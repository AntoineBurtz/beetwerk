// Düngung in der Oberfläche: Anzeige je Satz, fällige Gaben, Felder für Kultur und Einstellungen, Richtwerte prüfen.
import { state, find, patch, create, remove, api, select, emit, load } from "./store.js";
import { h, fmtDay, fmtNum, isoOf, yearOf, todayNum, phases } from "./util.js";
import { feedPlan, feedTasks, feedWhen, gramsText, chosenFertilizer, bedFeed, FEED_LEVELS, FEED_LABEL } from "./feed.js";
import { shell, field } from "./editor.js";
import { toast, confirmDialog } from "./ui.js";

const SOURCE_TEXT = {
  "LWG 2202": "Stufe aus dem Merkblatt 2202 der Bayerischen Gartenakademie (LWG, 2020).",
  "LWG 2166": "Nach dem Merkblatt 2166 der Bayerischen Gartenakademie (Kräuter, 2016).",
  "N-Bedarf": "Im Merkblatt nicht genannt; abgeleitet aus dem Stickstoffbedarfswert des Erwerbsanbaus (IGZ, LfL).",
  Analogie: "Keine Angabe gefunden; wie die nächste verwandte Kultur eingestuft.",
  eigen: "Eigene Angabe.",
};
const SOURCE_SHORT = {
  "LWG 2202": "LWG, Merkblatt 2202",
  "LWG 2166": "LWG, Merkblatt 2166 (Kräuter)",
  "N-Bedarf": "abgeleitet aus dem N-Bedarfswert (IGZ, LfL)",
  Analogie: "wie die verwandte Kultur",
};
const REASON_TEXT = {
  unset: "Für diese Kultur ist kein Stickstoffbedarf festgelegt.",
  none: "Braucht keinen Stickstoffdünger. Kompost im Frühjahr genügt (höchstens 3 l/m²).",
  off: "Dieser Satz wird nicht gedüngt.",
  late: "Beginnt im Spätsommer: Der Boden liefert dann meist genug Stickstoff nach.",
};

const num = (v) => {
  const n = Number(String(v ?? "").trim().replace(",", "."));
  return String(v ?? "").trim() === "" || Number.isNaN(n) ? null : n;
};
const dayText = (day) => fmtDay(day, { year: yearOf(day) !== yearOf(state.day) });

function planOf(p) {
  return feedPlan(p, find.crop(p.crop_id), find.bed(p.bed_id), state.settings, state.fertilizers);
}

export async function setDone(p, i, on) {
  const fed = { ...(p.fed || {}) };
  if (on) fed[i] = isoOf(todayNum());
  else delete fed[i];
  try { await patch("plantings", p.id, { fed }); } catch { /* Meldung kam schon */ }
}

// Zeilen der Gaben eines Satzes, jede zum Abhaken
function itemRows(p, plan) {
  return h("ul", { class: "feed-list" }, plan.items.map((x) => h("li", { class: x.done ? "done" : "" },
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: !!x.done, onchange: (e) => setDone(p, x.i, e.target.checked),
        "aria-label": `Gabe vom ${dayText(x.day)} erledigt` }),
      h("span", { class: "feed-when" }, h("b", {}, dayText(x.day)), h("span", { class: "muted" }, ` ${feedWhen(x, p)}`))),
    h("span", { class: "feed-amount" }, x.grams == null ? `${fmtNum(x.n, 1)} g N` : gramsText(x.grams)))));
}

// Zusammenfassung eines Düngeplans in einem Satz
export function feedSummary(plan) {
  if (plan.reason) return REASON_TEXT[plan.reason];
  const grams = plan.fert ? plan.items.reduce((t, x) => t + x.grams, 0) : null;
  return `${fmtNum(plan.need, 1)} g Stickstoff je m² auf ${fmtNum(plan.area, 2)} m²`
    + (grams == null ? "" : `: zusammen höchstens ${gramsText(grams)} ${plan.fert.name}`)
    + (plan.items.length > 1 ? ` in ${plan.items.length} Gaben` : "") + ".";
}

// Abschnitt „Düngung“ für einen Satz (Seitenleiste der Karte, Übersicht) – null, wenn der Satz kein Beet hat
export function feedBlock(p) {
  if (!p.bed_id) return null;
  const plan = planOf(p);
  return h("div", { class: "feed-block" },
    h("p", { class: plan.reason ? "muted small" : "small", style: { margin: 0 } }, feedSummary(plan)),
    plan.items.length ? itemRows(p, plan) : null);
}

// Offene Gaben rund um den Stichtag: überfällige der letzten drei Wochen und die der nächsten 14 Tage
export function feedDue(day = state.day) {
  return feedTasks(state, day - 21, day + 14).filter(({ p, item }) => item.day >= day || phases(p).he >= day);
}

export function feedDueList(day = state.day, { onPick = (p) => select({ type: "planting", id: p.id }) } = {}) {
  const due = feedDue(day);
  if (!due.length) return null;
  return h("ul", { class: "legend-list feed-due" }, due.map(({ p, crop, bed, item }) =>
    h("li", {}, h("button", { type: "button", onclick: () => onPick(p) },
      h("span", { class: "dot", style: { background: crop?.color } }),
      h("span", { class: "name" }, crop?.name ?? "Kultur", h("span", { class: "muted" }, ` ${bed?.name ?? ""}`)),
      h("span", { class: `when${item.day < day ? " overdue" : ""}` },
        `${item.grams == null ? `${fmtNum(item.n, 1)} g N` : gramsText(item.grams)} · ${item.day < day ? "seit " : ""}${fmtDay(item.day)}`)))));
}

// Zeile für die Beetübersicht: Stickstoff im Jahr
export function bedFeedLine(bed, year) {
  const sum = bedFeed(state, bed, year);
  if (!(sum.total > 0)) return null;
  const fert = chosenFertilizer(state.settings, state.fertilizers);
  return h("p", { class: "small", style: { margin: 0 } },
    `Düngung ${year}: ${fmtNum(sum.total, 0)} g Stickstoff`,
    fert ? ` (${gramsText(sum.total / (fert.n_pct / 100))} ${fert.name})` : "",
    `, im Mittel ${fmtNum(sum.perM2, 1)} g je m² Beet.`);
}

// ---------------------------------------------------------------- Kultur: Felder im Dialog

export function cropFeedFields(c) {
  const level = h("select", {},
    [["", "nicht festgelegt"], ["none", "keine – Kompost genügt"], ["low", `gering (${fmtNum(FEED_LEVELS.low, 1)} g N/m²)`],
      ["medium", `mittel (${fmtNum(FEED_LEVELS.medium, 1)} g N/m²)`], ["high", `hoch (${fmtNum(FEED_LEVELS.high, 1)} g N/m²)`]]
      .map(([k, label]) => h("option", { value: k, selected: (c.feed || "") === k }, label)));
  const own = h("input", { inputmode: "decimal", value: c.feed_n > 0 ? String(c.feed_n).replace(".", ",") : "", placeholder: "wie die Stufe" });
  const start = h("input", { inputmode: "numeric", value: c.feed_start > 0 ? c.feed_start : "", placeholder: "nach Regel" });
  const cut = h("input", { type: "checkbox", checked: !!c.feed_cut });
  const late = h("input", { type: "checkbox", checked: !!c.feed_late });
  const example = h("p", { class: "calc", style: { margin: 0 } });
  const source = h("p", { class: "muted small", style: { margin: 0 } });
  const detail = h("div", { class: "feed-detail" },
    h("div", { class: "grid-2" },
      field("Eigene Menge (g N/m²)", own, "leer: die Menge der Stufe"),
      field("Schnell wirkender Dünger erst nach", start, "Tagen ab Saat oder Pflanzung; leer: 1 Woche nach der Pflanzung, 2 nach der Saat")),
    h("label", { class: "check" }, cut, "Schnittkultur: nach den Schnitten nachdüngen"),
    h("label", { class: "check" }, late, "Sätze, die ab August beginnen, nicht düngen"));
  const value = () => {
    const n = num(own.value);
    if (own.value.trim() && (n == null || n < 0 || n > 60)) throw new Error("Eigene Düngermenge: bitte 0 bis 60 g N/m² angeben");
    const s = num(start.value);
    if (start.value.trim() && (s == null || s < 0 || s > 120)) throw new Error("Düngung erst nach: bitte 0 bis 120 Tage angeben");
    const out = { feed: level.value, feed_n: n ?? 0, feed_start: Math.round(s ?? 0), feed_cut: cut.checked, feed_late: late.checked };
    const changed = out.feed !== (c.feed || "") || out.feed_n !== (c.feed_n || 0) || out.feed_cut !== !!c.feed_cut
      || out.feed_late !== !!c.feed_late || out.feed_start !== (c.feed_start || 0);
    if (changed) out.feed_src = "eigen";
    return out;
  };
  const paint = () => {
    const on = level.value === "low" || level.value === "medium" || level.value === "high";
    detail.hidden = !on;
    const fert = chosenFertilizer(state.settings, state.fertilizers);
    const n = num(own.value) > 0 ? num(own.value) : FEED_LEVELS[level.value] ?? 0;
    example.hidden = !on || !fert;
    if (on && fert) example.textContent = `Mit ${fert.name} (${fmtNum(fert.n_pct, 1)} % N): höchstens ${gramsText(n / (fert.n_pct / 100))} je m².`;
    const same = level.value === (c.feed || "") && (num(own.value) ?? 0) === (c.feed_n || 0);
    source.textContent = same && c.feed ? SOURCE_TEXT[c.feed_src] ?? "" : "";
    source.hidden = !source.textContent;
  };
  level.addEventListener("change", paint);
  own.addEventListener("input", paint);
  paint();
  const el = h("fieldset", {},
    h("legend", {}, "Düngung"),
    field("Stickstoffbedarf", level, "Höchstmenge über die ganze Kultur. Die Aufteilung richtet sich nach dem Dünger in den Einstellungen."),
    example, source, detail);
  return { el, value };
}

export function feedLabel(c) {
  if (!c.feed) return "";
  if (c.feed === "none") return "keine";
  return c.feed_n > 0 ? `${fmtNum(c.feed_n, 1)} g N/m²` : FEED_LABEL[c.feed];
}

// ---------------------------------------------------------------- Einstellungen: Dünger und Anpassung

export function feedSettings() {
  const s = state.settings;
  const chosen = h("select", {});
  const factor = h("select", {},
    [["100", "100 % – die volle Empfehlung"], ["75", "75 %"], ["50", "50 % – humusreicher Boden"], ["25", "25 % – sehr humusreich (über 4 % Humus)"]]
      .map(([v, label]) => h("option", { value: v, selected: (s.feed_factor || "100") === v }, label)));
  const list = h("div", { class: "fert-list" });

  const edit = (f) => {
    const name = h("input", { value: f?.name ?? "", maxlength: 60, required: true });
    const pct = h("input", { inputmode: "decimal", value: f ? String(f.n_pct).replace(".", ",") : "" });
    const speed = h("select", {},
      h("option", { value: "slow", selected: (f?.speed ?? "slow") === "slow" }, "langsam (Horn, organisch, Langzeit)"),
      h("option", { value: "fast", selected: f?.speed === "fast" }, "schnell (mineralisch, flüssig)"));
    const note = h("input", { value: f?.note ?? "", maxlength: 200 });
    const ui = shell(f ? f.name : "Neuer Dünger", {
      onSubmit: async () => {
        const n = num(pct.value);
        if (!name.value.trim()) throw new Error("Bitte einen Namen eingeben");
        if (!(n > 0 && n <= 50)) throw new Error("Stickstoffgehalt: bitte eine Zahl zwischen 0 und 50 % angeben");
        const payload = { name: name.value.trim(), n_pct: n, speed: speed.value, note: note.value.trim() };
        if (f) await patch("fertilizers", f.id, payload);
        else await create("fertilizers", payload);
        paint();
      },
    });
    ui.body.append(
      field("Name", name),
      h("div", { class: "grid-2" }, field("Stickstoff (N) in %", pct, "steht auf der Packung, z. B. 13 bei „13-0-0“"),
        field("Wirkung", speed, "bestimmt, wie die Menge auf Termine verteilt wird")),
      field("Hinweis", note));
    ui.foot.append(
      f ? h("button", { type: "button", class: "btn btn-danger", disabled: state.fertilizers.length <= 1, onclick: async () => {
        if (!(await confirmDialog(`${f.name} wird aus der Düngerliste gelöscht.`, { title: "Dünger löschen?" }))) return;
        try {
          await remove("fertilizers", f.id);
          state.settings = (await api.get("/api/data")).settings; // die Wahl kann auf einen anderen Dünger gefallen sein
          emit("data");
        } catch { return; }
        ui.dlg.close();
        paint();
      } }, "Löschen") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn", onclick: () => ui.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, f ? "Speichern" : "Anlegen"));
    ui.open();
  };

  function paint() {
    const current = chosen.value || String(state.settings.fert_id ?? "");
    chosen.replaceChildren(...state.fertilizers.map((f) =>
      h("option", { value: f.id, selected: String(f.id) === current }, `${f.name} (${fmtNum(f.n_pct, 1)} % N)`)));
    list.replaceChildren(...state.fertilizers.map((f) => h("button", { type: "button", class: "chip", onclick: () => edit(f), title: f.note || null },
      f.name, h("span", { class: "muted" }, ` ${fmtNum(f.n_pct, 1)} % · ${f.speed === "fast" ? "schnell" : "langsam"}`))),
    h("button", { type: "button", class: "chip chip-add", onclick: () => edit(null) }, "+ Dünger"));
  }
  paint();

  const el = h("fieldset", {},
    h("legend", {}, "Düngung"),
    h("div", { class: "grid-2" },
      field("Mein Stickstoffdünger", chosen, "Mit ihm rechnet Beetwerk Mengen und Termine."),
      field("Menge", factor, "Humusreiche Gartenböden liefern selbst Stickstoff nach.")),
    h("p", { class: "muted small", style: { margin: 0 } },
      "Empfehlung nach der Bayerischen Gartenakademie (LWG, Merkblatt 2202): je Kultur höchstens 6,5, 13 oder 19,5 g Stickstoff je m². "
      + "Kompost (höchstens 3 l/m² im Frühjahr) deckt Phosphat und Kali, als Stickstoffquelle reicht er nicht. Die Liste antippen, um einen Dünger zu ändern:"),
    list);
  return { el, value: () => ({ fert_id: Number(chosen.value) || undefined, feed_factor: factor.value }) };
}

// ---------------------------------------------------------------- Richtwerte prüfen

// Stellt die eigenen Kulturwerte neben die Richtwerte aus den Quellen; übernommen wird nur, was angehakt ist.
export async function openReferenceCheck() {
  let data;
  try { data = await api.get("/api/crops/reference"); } catch (e) { toast(e.message, { error: true }); return; }
  const rows = [];
  for (const item of data.crops) {
    const c = find.crop(item.id);
    const ref = item.ref;
    if (!c || !ref) continue;
    const diffs = [];
    if (ref.row_spacing && (ref.row_spacing !== c.row_spacing || ref.plant_spacing !== c.plant_spacing)) {
      diffs.push({ what: "Abstände", mine: `${c.row_spacing} × ${c.plant_spacing} cm`, theirs: `${ref.row_spacing} × ${ref.plant_spacing} cm`,
        source: ref.spacing_src, changes: { row_spacing: ref.row_spacing, plant_spacing: ref.plant_spacing } });
    }
    const feedDiffers = ref.feed !== (c.feed || "") || (c.feed_n || 0) > 0 || !!ref.feed_cut !== !!c.feed_cut
      || !!ref.feed_late !== !!c.feed_late || (ref.feed_start || 0) !== (c.feed_start || 0);
    if (feedDiffers) {
      diffs.push({ what: "Düngung", mine: feedLabel(c) || "nicht festgelegt", theirs: FEED_LABEL[ref.feed] + (ref.feed_cut ? ", nach Schnitt" : ""),
        source: SOURCE_SHORT[ref.feed_src] ?? ref.feed_src, changes: { feed: ref.feed, feed_n: 0, feed_cut: !!ref.feed_cut, feed_late: !!ref.feed_late,
          feed_start: ref.feed_start || 0, feed_src: ref.feed_src } });
    }
    for (const d of diffs) rows.push({ c, ...d, box: h("input", { type: "checkbox", "aria-label": `${c.name}: ${d.what} übernehmen` }) });
  }
  const unknown = data.crops.filter((x) => !x.ref).map((x) => x.name);
  const all = h("input", { type: "checkbox", "aria-label": "alle auswählen", onchange: (e) => { for (const r of rows) r.box.checked = e.target.checked; } });
  const ui = shell("Richtwerte prüfen", {
    onSubmit: async () => {
      const byCrop = new Map();
      for (const r of rows.filter((x) => x.box.checked)) byCrop.set(r.c.id, { ...(byCrop.get(r.c.id) || {}), ...r.changes });
      if (!byCrop.size) throw new Error("Bitte mindestens eine Zeile anhaken");
      for (const [id, changes] of byCrop) await patch("crops", id, changes);
      toast(`${byCrop.size} ${byCrop.size === 1 ? "Kultur" : "Kulturen"} angepasst`);
    },
  });
  ui.dlg.classList.add("wide");
  ui.body.append(
    h("p", { class: "muted", style: { margin: 0 } },
      "Deine Werte neben den Richtwerten aus den Quellen. Übernommen wird nur, was du anhakst; bestehende Sätze rechnen danach mit den neuen Abständen, "
      + "soweit sie keine eigenen haben. Anzuchtdauer und Kulturzeiten stehen in diesen Quellen nicht und bleiben, wie sie sind."),
    rows.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", { style: { width: "34px" } }, all), h("th", {}, "Kultur"), h("th", {}, "Wert"),
          h("th", {}, "bei dir"), h("th", {}, "Richtwert"), h("th", {}, "Quelle"))),
        h("tbody", {}, rows.map((r) => h("tr", { onclick: (e) => { if (e.target !== r.box) r.box.checked = !r.box.checked; } },
          h("td", {}, r.box),
          h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: r.c.color } }), r.c.name)),
          h("td", {}, r.what), h("td", { class: "nowrap" }, r.mine), h("td", { class: "nowrap" }, h("b", {}, r.theirs)),
          h("td", { class: "small muted" }, r.source))))))
      : h("p", {}, "Alle Kulturen, für die es Richtwerte gibt, stimmen mit ihnen überein."),
    unknown.length ? h("p", { class: "muted small", style: { margin: 0 } }, `Ohne Richtwert: ${unknown.join(", ")}.`) : null,
    // Kräuter, die es in diesem Garten (noch) nicht gibt – etwa nach dem Einspielen einer älteren Sicherung
    data.missing_herbs?.length ? h("p", { class: "small", style: { margin: 0 } },
      `In der Kulturliste fehlen: ${data.missing_herbs.join(", ")}. `,
      h("button", { type: "button", class: "btn btn-sm", onclick: async () => {
        try {
          const out = await api.post("/api/crops/herbs");
          await load();
          toast(out.added.length ? `Ergänzt: ${out.added.join(", ")}` : "Nichts zu ergänzen");
          ui.dlg.close();
        } catch (e) { ui.showError(e.message); }
      } }, "Als Kulturen ergänzen")) : null,
    h("p", { class: "muted small", style: { margin: 0 } },
      "Quellen: Bayerische Gartenakademie (LWG), „Sä- und Pflanztermine auf einen Blick“ und Merkblätter 2202 und 2166; aid, „Gemüse, Obst & Co.“ (2017); "
      + "IGZ, Nmin-Sollwerte für Freilandgemüse (2015); LfL, Basisdaten 2025, Tabelle 9d."));
  ui.foot.append(
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn", onclick: () => ui.dlg.close() }, rows.length ? "Abbrechen" : "Schließen"),
    rows.length ? h("button", { type: "submit", class: "btn btn-primary" }, "Angehakte übernehmen") : null);
  ui.open();
}
