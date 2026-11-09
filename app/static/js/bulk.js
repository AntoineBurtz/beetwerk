// Mehrere markierte Sätze gemeinsam ändern oder löschen (Zeitleiste und Liste unter „Sätze“)
import { state, find, patchMany, removeMany, clearMarks } from "./store.js";
import { h, phases, isoOf, dayNum, fmtDay, round2, clamp, PLANTABLE, isMixed, plural } from "./util.js";
import { shell, field, firstFreeStart } from "./editor.js";
import { confirmDialog, icon, iconBtn } from "./ui.js";

const DATES = ["sow_date", "plant_date", "harvest_start", "harvest_end"];
const FLAGS = [["sown_done", "Gesät"], ["planted_done", "Gepflanzt"], ["harvest_done", "Abgeerntet"]];

export function markedPlantings() {
  return [...state.marked].map((id) => find.planting(id)).filter(Boolean)
    .sort((a, b) => phases(a).sow - phases(b).sow || a.id - b.id);
}

// "Radieschen (5), Kopfsalat (2)"
export function markedSummary(ps) {
  const byCrop = new Map();
  for (const p of ps) {
    const name = find.crop(p.crop_id)?.name ?? "Kultur";
    byCrop.set(name, (byCrop.get(name) || 0) + 1);
  }
  return [...byCrop].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(", ");
}

const count = (n) => plural(n, "Satz", "Sätze");

// Inhalt der Leiste für markierte Sätze; extra = weitere Knöpfe vor „Löschen“
export function bulkBar(ps, { extra = [] } = {}) {
  return [
    h("span", { class: "tl-selbar-text" },
      h("strong", {}, `${count(ps.length)} markiert`),
      h("span", { class: "muted small" }, markedSummary(ps))),
    ...extra,
    h("button", { type: "button", class: "btn btn-sm", onclick: () => deleteMarked(ps) }, icon("trash"), "Löschen"),
    h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => openBulkEditor(ps) }, "Ändern"),
    iconBtn("close", "Markierung aufheben", clearMarks),
  ].filter(Boolean);
}

export async function deleteMarked(ps) {
  const ok = await confirmDialog(`${count(ps.length)} werden gelöscht: ${markedSummary(ps)}. Mit „Rückgängig“ holst du sie zurück.`,
    { title: `${count(ps.length)} löschen?` });
  if (!ok) return false;
  await removeMany("plantings", ps.map((p) => p.id), { undoLabel: `${count(ps.length)} gelöscht` });
  clearMarks();
  return true;
}

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(",", ".").replace("−", "-"));
  return Number.isFinite(n) ? n : NaN;
}

export function openBulkEditor(ps) {
  ps = ps.map((p) => find.planting(p.id)).filter(Boolean);
  if (!ps.length) return;
  const crops = new Set(ps.map((p) => p.crop_id));
  const oneCrop = crops.size === 1 ? find.crop(ps[0].crop_id) : null;
  const mixed = ps.filter(isMixed).length;
  const anyTransplant = ps.some((p) => p.method === "transplant");
  const first = Math.min(...ps.map((p) => phases(p).sow)), last = Math.max(...ps.map((p) => phases(p).he));

  const shift = h("input", { name: "shift", inputmode: "numeric", placeholder: "0" });
  const bed = h("select", { name: "bed" },
    h("option", { value: "" }, "unverändert"),
    h("option", { value: "none" }, "Ohne Beet"),
    state.beds.filter((b) => PLANTABLE.has(b.kind)).map((b) => h("option", { value: b.id }, b.name)));
  const variety = h("input", { name: "variety", placeholder: "unverändert", list: "bulk-varieties", autocomplete: "off" });
  const varList = h("datalist", { id: "bulk-varieties" },
    oneCrop ? state.varieties.filter((v) => v.crop_id === oneCrop.id).map((v) => h("option", { value: v.name })) : null);
  const len = h("input", { name: "len", inputmode: "decimal", placeholder: "unverändert" });
  const rows = h("input", { name: "rows", inputmode: "numeric", placeholder: "unverändert" });
  const flagSel = FLAGS.filter(([k]) => k !== "planted_done" || anyTransplant).map(([k, label]) => [k, label, h("select", { name: k },
    h("option", { value: "" }, "unverändert"), h("option", { value: "1" }, "ja"), h("option", { value: "0" }, "nein"))]);
  const note = h("input", { name: "note", placeholder: "wird an die Notizen angehängt", maxlength: 300 });

  const ui = shell(`${count(ps.length)} ändern`, {
    onSubmit: async () => {
      const days = num(shift.value);
      const newLen = num(len.value);
      const newRows = num(rows.value);
      if (Number.isNaN(days) || (days != null && !Number.isInteger(days))) throw new Error("Verschieben bitte in ganzen Tagen angeben, z. B. 7 oder -14");
      if (Number.isNaN(newLen) || (newLen != null && !(newLen > 0))) throw new Error("Die Länge muss größer als 0 sein");
      if (Number.isNaN(newRows) || (newRows != null && !(Number.isInteger(newRows) && newRows > 0))) throw new Error("Reihen bitte als ganze Zahl ab 1 angeben");
      const target = bed.value && bed.value !== "none" ? find.bed(Number(bed.value)) : null;
      const vName = variety.value.trim();
      const text = note.value.trim();

      const changesFor = (p) => {
        const ch = {};
        if (days) for (const k of DATES) if (p[k]) ch[k] = isoOf(dayNum(p[k]) + days);
        if (oneCrop && vName && !isMixed(p) && vName !== p.variety) ch.variety = vName;
        if (newRows != null) ch.rows = newRows;
        for (const [k, , sel] of flagSel) {
          if (sel.value === "" || (k === "planted_done" && p.method !== "transplant")) continue;
          if (!!p[k] !== (sel.value === "1")) ch[k] = sel.value === "1";
        }
        if (text) ch.notes = p.notes ? `${p.notes}\n${text}` : text;
        const where = bed.value === "none" ? null : target ?? find.bed(p.bed_id);
        if (bed.value === "none") {
          if (p.bed_id != null) ch.bed_id = null;
          if (newLen != null) ch.len = round2(newLen);
        } else if (where) {
          const l = round2(Math.min(newLen ?? p.len, where.length));
          if (target && target.id !== p.bed_id) {
            // Ins neue Beet: Breite übernehmen, freie Stelle in der Zeit des Satzes suchen
            const span = p.span != null && p.span < where.width - 0.001 ? p.span : null;
            const offset = span != null ? round2(clamp(p.offset || 0, 0, where.width - span)) : 0;
            const ph = phases({ ...p, ...ch });
            const start = firstFreeStart(where, l, { offset, span, from: ph.fieldStart, to: ph.he, excludeId: p.id })
              ?? round2(clamp(p.start || 0, 0, Math.max(0, where.length - l)));
            Object.assign(ch, { bed_id: where.id, start, len: l, offset, span });
          } else if (newLen != null) {
            ch.len = l;
            if ((p.start || 0) + l > where.length) ch.start = round2(Math.max(0, where.length - l));
          }
        } else if (newLen != null) ch.len = round2(newLen);
        return ch;
      };

      const n = await patchMany("plantings", ps.map((p) => ({ id: p.id, changes: changesFor })),
        { undoLabel: `${count(ps.length)} geändert` });
      if (!n) throw new Error("Es ist nichts zu ändern – bitte mindestens ein Feld ausfüllen");
    },
  });

  ui.body.append(
    h("p", { class: "muted small", style: { margin: 0 } },
      `${markedSummary(ps)} · ${fmtDay(first)} bis ${fmtDay(last, { year: true })}. Leere Felder bleiben, wie sie sind.`),
    field("Termine verschieben um (Tage)", shift, "Alle Termine gleich weit: 7 = eine Woche später, -14 = zwei Wochen früher"),
    field("Beet", bed, "Im neuen Beet sucht jeder Satz eine freie Stelle für seine Zeit; ohne Platz wird er als Überschneidung markiert."),
    oneCrop
      ? field(`Sorte (${oneCrop.name})`, variety, mixed ? `${count(mixed)} mit mehreren Sorten ${mixed === 1 ? "behält" : "behalten"} ihre Mischung` : null)
      : h("p", { class: "muted small", style: { margin: 0 } }, "Die Sorte lässt sich nur ändern, wenn alle markierten Sätze dieselbe Kultur haben."),
    varList,
    h("div", { class: "grid-2" }, field("Länge (m)", len), field("Reihen", rows)),
    h("fieldset", {}, h("legend", {}, "Erledigt"),
      h("div", { class: `grid-${flagSel.length}` }, flagSel.map(([, label, sel]) => field(label, sel)))),
    field("Notiz", note),
  );
  ui.foot.append(
    h("button", { type: "button", class: "btn btn-danger", onclick: async () => { if (await deleteMarked(ps)) ui.dlg.close(); } }, "Löschen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, "Übernehmen"));
  ui.open();
}
