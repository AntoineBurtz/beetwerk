// Ernteziele: „6 Köpfe Salat je Woche von KW 20 bis 43“ – Beetwerk legt die Folgesätze dafür an.
import { state, api, find, load, patch } from "./store.js";
import { h, fmtDay, dayNum, isoWeek, plural, fmtNum, phases, yearOf } from "./util.js";
import { toast, confirmDialog, icon } from "./ui.js";
import { shell, field, firstFreeStart } from "./editor.js";
import { openGoalOverview } from "./overview.js";

const UNITS = ["Köpfe", "Stück", "Bund", "Portionen", "kg"];
const BASIS = {
  Klima: "Kulturdauer nach den Temperaturen deines Gartens (Wetterdaten der letzten Jahre)",
  typisch: "Kulturdauer nach typischen Temperaturen in Süddeutschland – mit Wetterdaten wird es genauer",
  fest: "feste Kulturdauer der Kultur",
};

function day(iso, opts) {
  return iso ? fmtDay(dayNum(iso), opts) : "–";
}

function kw(iso) {
  return iso ? `KW ${isoWeek(dayNum(iso))}` : "";
}

function amountText(g) {
  return `${fmtNum(g.amount)} ${g.unit}`;
}

export function goalPlantings(g) {
  return state.plantings.filter((p) => p.goal_id === g.id).sort((a, b) => (a.goal_seq ?? 0) - (b.goal_seq ?? 0));
}

// ---------------------------------------------------------------- Übersicht im Sätze-Blatt

export function goalsSection(year) {
  const list = (state.goals || []).filter((g) => yearOf(dayNum(g.start_date)) === year || yearOf(dayNum(g.end_date)) === year);
  const head = h("div", { class: "section-head" }, h("h2", {}, "Ernteziele"),
    h("span", { class: "muted small" }, "Wie viel du wann ernten willst – Beetwerk plant die Folgesätze und die Anzucht dazu"),
    h("button", { type: "button", class: "btn", onclick: () => openGoalEditor(null, { year }) }, icon("plus"), "Ernteziel"));
  if (!list.length) {
    return h("section", { class: "section" }, head, h("div", { class: "empty-note" },
      "Zum Beispiel „6 Köpfe Kopfsalat je Woche von Mitte Mai bis Oktober“ oder „2 Bund Basilikum je Woche im Sommer“. ",
      "Daraus werden Sätze mit Aussaat, Pflanzung und Pflanzenzahl, im Frühjahr und Herbst mit längerer Kulturdauer."));
  }
  return h("section", { class: "section" }, head, h("div", { class: "goals" }, list.map((g) => {
    const crop = find.crop(g.crop_id);
    const ps = goalPlantings(g);
    const loose = ps.filter((p) => !p.bed_id);
    const first = ps.map((p) => p.sow_date).sort()[0];
    return h("div", { class: "goal" },
      h("button", { type: "button", class: "goal-main", onclick: () => openGoalOverview(g) },
        h("span", { class: "dot", style: { background: crop?.color } }),
        h("span", { class: "goal-title" }, `${crop?.name || "Kultur"}${g.variety ? ` ${g.variety}` : ""}`),
        h("span", { class: "goal-what" }, `${amountText(g)} je Woche · ${kw(g.start_date)} bis ${kw(g.end_date)}`),
        h("span", { class: "muted small goal-sub" },
          `${plural(ps.length, "Satz", "Sätze")}${ps.length ? ` · erste Aussaat ${day(first)}` : ""}`)),
      loose.length
        ? h("button", { type: "button", class: "btn btn-sm", onclick: () => openAssign(g) }, `${loose.length} ohne Beet – Beete vorschlagen`)
        : ps.length ? h("span", { class: "src src-bonitur" }, "alle auf Beeten") : null);
  })));
}

// ---------------------------------------------------------------- Ziel anlegen und ändern

export function openGoalEditor(goal, { year } = {}) {
  const isNew = !goal?.id;
  const y = year ?? yearOf(state.day);
  const g = { crop_id: null, variety: "", start_date: `${y}-05-15`, end_date: `${y}-09-30`, amount: 4, unit: "Köpfe",
    yield_per_plant: 1, window_days: null, interval_days: null, seasonal: 1, notes: "", ...goal };
  const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"));
  const cropSel = h("select", { required: true },
    h("option", { value: "", selected: !g.crop_id }, "– Kultur wählen –"),
    crops.map((c) => h("option", { value: c.id, selected: c.id === g.crop_id }, c.name)));
  const variety = h("input", { value: g.variety, list: "goal-varieties", autocomplete: "off", placeholder: "optional" });
  const varList = h("datalist", { id: "goal-varieties" });
  const start = h("input", { type: "date", value: g.start_date, required: true });
  const end = h("input", { type: "date", value: g.end_date, required: true });
  const amount = h("input", { inputmode: "decimal", value: String(g.amount).replace(".", ","), required: true });
  const unit = h("input", { value: g.unit, list: "goal-units", maxlength: 30 });
  const unitList = h("datalist", { id: "goal-units" }, UNITS.map((u) => h("option", { value: u })));
  const per = h("input", { inputmode: "decimal", value: String(g.yield_per_plant).replace(".", ",") });
  const windowIn = h("input", { inputmode: "numeric", value: g.window_days ?? "" });
  const intervalIn = h("input", { inputmode: "numeric", value: g.interval_days ?? "" });
  const seasonal = h("input", { type: "checkbox", checked: !!g.seasonal });
  const notes = h("input", { value: g.notes || "", maxlength: 2000 });
  const preview = h("div", { class: "goal-preview" });
  let touched = !isNew; // Einheit und Ertrag nicht überschreiben, wenn schon bearbeitet

  const fillCrop = async () => {
    const crop = find.crop(Number(cropSel.value));
    const names = new Set(state.varieties.filter((v) => v.crop_id === crop?.id).map((v) => v.name));
    varList.replaceChildren(...[...names].sort((a, b) => a.localeCompare(b, "de")).map((n) => h("option", { value: n })));
    windowIn.placeholder = crop ? `${crop.harvest_days} (wie Kultur)` : "";
    intervalIn.placeholder = "wie Erntefenster";
    if (crop && !touched) {
      try {
        const s = await api.get(`/api/goals/suggest?crop_id=${crop.id}`);
        unit.value = s.unit;
        per.value = String(s.yield_per_plant).replace(".", ",");
      } catch { /* Vorschlag ist nur Bequemlichkeit */ }
    }
    refresh();
  };
  for (const el of [unit, per]) el.addEventListener("input", () => { touched = true; });

  const numOf = (el, label, { int = false, optional = false } = {}) => {
    const t = el.value.trim().replace(",", ".");
    if (!t) {
      if (optional) return 0;
      throw new Error(`${label}: bitte angeben`);
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw new Error(`${label}: bitte eine ${int ? "ganze " : ""}Zahl eingeben`);
    return n;
  };
  const body = () => ({
    crop_id: Number(cropSel.value) || null, variety: variety.value.trim(), start_date: start.value, end_date: end.value,
    amount: numOf(amount, "Menge je Woche"), unit: unit.value.trim() || "Stück", yield_per_plant: numOf(per, "Ertrag je Pflanze"),
    window_days: numOf(windowIn, "Erntefenster", { int: true, optional: true }),
    interval_days: numOf(intervalIn, "Abstand", { int: true, optional: true }),
    seasonal: seasonal.checked, notes: notes.value.trim(),
  });

  let seq = 0;
  let timer = null;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      let b;
      try { b = body(); } catch (e) { preview.replaceChildren(h("p", { class: "muted small" }, e.message)); return; }
      if (!b.crop_id || !b.start_date || !b.end_date) { preview.replaceChildren(); return; }
      try {
        const out = await api.post("/api/goals/preview", b);
        if (my === seq) paintPreview(out);
      } catch (e) {
        if (my === seq) preview.replaceChildren(h("p", { class: "form-error", style: { margin: 0 } }, e.message));
      }
    }, 250);
  }

  function paintPreview(out) {
    const ok = out.successions.filter((s) => !s.too_cold);
    const cold = out.successions.filter((s) => s.too_cold);
    const transplant = out.method === "transplant";
    const s0 = ok[0];
    preview.replaceChildren(...[
      h("p", { class: "goal-sum" },
        h("strong", {}, plural(ok.length, "Satz", "Sätze")), ` alle ${out.interval_days} Tage, je ${s0 ? s0.count : "–"} Pflanzen`,
        s0 && s0.count > s0.need ? ` (${s0.need} gebraucht, auf volle Reihen aufgerundet)` : "",
        ` · zusammen ${out.plants} Pflanzen · jeder Satz wird ${out.window_days} Tage beerntet`),
      h("p", { class: "muted small", style: { margin: 0 } }, BASIS[out.basis] || ""),
      cold.length ? h("p", { class: "note-inline" }, `${plural(cold.length, "Erntetermin", "Erntetermine")} (${cold.map((s) => day(s.harvest_start)).join(", ")}) `
        + "schafft die Kultur im Freiland nicht – zu kalt. Ohne Anpassung an die Jahreszeit (z. B. im Gewächshaus) werden sie geplant.") : null,
      h("div", { class: "table-wrap" }, h("table", { class: "data goal-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Satz"), h("th", {}, transplant ? "Aussaat (Anzucht)" : "Aussaat"),
          transplant ? h("th", {}, "Pflanzung") : null, h("th", {}, "Ernte"), h("th", { class: "r" }, "Pflanzen"),
          h("th", { class: "r" }, "Kulturdauer"))),
        h("tbody", {}, out.successions.map((s, i) => h("tr", { class: s.too_cold ? "cold" : "", style: { cursor: "default" } },
          h("td", { class: "num" }, i + 1),
          h("td", { class: "nowrap" }, s.too_cold ? "zu kalt" : `${kw(s.sow_date)} · ${day(s.sow_date)}`),
          transplant ? h("td", { class: "nowrap" }, s.plant_date ? day(s.plant_date) : "–") : null,
          h("td", { class: "nowrap" }, `${day(s.harvest_start)} bis ${day(s.harvest_end)}`),
          h("td", { class: "r" }, s.too_cold ? "–" : s.count),
          h("td", { class: "r nowrap" }, s.field_days ? `${s.field_days} Tage` : "–"))))))].filter(Boolean));
  }

  for (const el of [start, end, amount, per, windowIn, intervalIn, unit]) el.addEventListener("input", refresh);
  seasonal.addEventListener("change", refresh);
  cropSel.addEventListener("change", fillCrop);

  const startHint = h("span", { class: "hint" });
  const endHint = h("span", { class: "hint" });
  const hints = () => { startHint.textContent = kw(start.value); endHint.textContent = kw(end.value); };
  start.addEventListener("input", hints);
  end.addEventListener("input", hints);
  hints();

  const ui = shell(isNew ? "Neues Ernteziel" : "Ernteziel", {
    onSubmit: async () => {
      const b = body();
      if (!b.crop_id) throw new Error("Bitte eine Kultur wählen");
      if (!(b.amount > 0)) throw new Error("Menge je Woche: bitte mehr als 0");
      if (!(b.yield_per_plant > 0)) throw new Error("Ertrag je Pflanze: bitte mehr als 0");
      const res = isNew ? await api.post("/api/goals", b) : await api.patch(`/api/goals/${g.id}`, b);
      await load();
      const parts = [];
      if (res.created.length) parts.push(`${plural(res.created.length, "Satz", "Sätze")} angelegt`);
      if (res.updated.length) parts.push(`${res.updated.length} angepasst`);
      if (res.removed.length) parts.push(`${res.removed.length} entfernt`);
      if (res.kept.length) parts.push(`${res.kept.length} schon begonnen, unverändert`);
      const loose = state.plantings.filter((p) => p.goal_id === res.goal.id && !p.bed_id).length;
      toast(`${parts.join(", ") || "Nichts geändert"}.${loose ? ` ${plural(loose, "Satz wartet", "Sätze warten")} auf ein Beet – unter Ernteziele „Beete vorschlagen“.` : ""}`);
    },
  });
  ui.dlg.classList.add("goal-dialog");
  ui.body.append(
    h("div", { class: "grid-2" }, field("Kultur", cropSel), field("Sorte", variety, "Für Frühjahr und Sommer eigene Ziele mit passender Sorte"), varList),
    h("div", { class: "grid-2" },
      h("label", { class: "field" }, h("span", {}, "Ernte ab"), start, startHint),
      h("label", { class: "field" }, h("span", {}, "Ernte bis"), end, endHint)),
    h("div", { class: "grid-3" },
      field("Menge je Woche", amount),
      field("Einheit", unit), unitList,
      field("Ertrag je Pflanze", per, "über das ganze Erntefenster, z. B. 1 Kopf")),
    h("div", { class: "grid-3" },
      field("Erntefenster je Satz", windowIn, "Tage, die ein Satz beerntet wird"),
      field("Abstand der Sätze", intervalIn, "Tage; kürzer als das Fenster = Sätze überlappen"),
      h("label", { class: "check", style: { alignSelf: "center" } }, seasonal, "Kulturdauer an die Jahreszeit anpassen")),
    field("Notiz", notes),
    preview);
  ui.foot.append(
    isNew ? null : h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      const ps = goalPlantings(g);
      const started = ps.filter((p) => p.sown_done || p.planted_done || p.harvest_done).length;
      const text = `Das Ziel wird gelöscht und mit ihm ${plural(ps.length - started, "Satz", "Sätze")}, die noch nicht gesät sind.`
        + (started ? ` ${plural(started, "begonnener Satz bleibt", "begonnene Sätze bleiben")} als normale Sätze.` : "");
      if (!(await confirmDialog(text, { title: "Ernteziel löschen?" }))) return;
      ui.dlg.close();
      try {
        await api.del(`/api/goals/${g.id}`);
        await load();
        toast("Ernteziel gelöscht");
      } catch (e) { toast(e.message, { error: true }); }
    } }, "Löschen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Sätze anlegen" : "Speichern und Sätze anpassen"));
  ui.open();
  if (g.crop_id) fillCrop(); else refresh();
}

// ---------------------------------------------------------------- Beete vorschlagen

const PLANTABLE = new Set(["bed", "raised", "greenhouse"]);

// Freie Stellen im passenden Zeitraum; Beete mit gleicher Pflanzenfamilie in der Anbaupause kommen zuletzt
export function suggestBeds(p, max = 3) {
  const crop = find.crop(p.crop_id);
  const ph = phases(p);
  const years = Number(state.settings.rotation_years ?? 3);
  const span = p.span ?? 1;
  const out = [];
  for (const bed of [...state.beds].sort((a, b) => a.sort - b.sort)) {
    if (!PLANTABLE.has(bed.kind) || bed.width + 0.001 < span || bed.length + 0.001 < p.len) continue;
    const offsets = [...new Set([0, Math.round((bed.width - span) * 100) / 100])];
    let hit = null;
    for (const offset of offsets) {
      const x = firstFreeStart(bed, p.len, { offset, span, from: ph.fieldStart, to: ph.he, excludeId: p.id });
      if (x != null) { hit = { x, offset }; break; }
    }
    if (!hit) continue;
    const rotation = !!crop?.family && state.plantings.some((q) => {
      if (q.bed_id !== bed.id || q.id === p.id) return false;
      const c = find.crop(q.crop_id);
      const qy = yearOf(phases(q).fieldStart);
      const py = yearOf(ph.fieldStart);
      return c?.family === crop.family && qy < py && py - qy <= years;
    });
    out.push({ bed, ...hit, rotation });
  }
  out.sort((a, b) => Number(a.rotation) - Number(b.rotation) || Number(a.bed.kind === "greenhouse") - Number(b.bed.kind === "greenhouse"));
  return out.slice(0, max);
}

export function openAssign(g) {
  const crop = find.crop(g.crop_id);
  const ui = shell(`Beete für ${crop?.name || "Kultur"}${g.variety ? ` ${g.variety}` : ""}`, { onSubmit: () => {} });
  const list = h("div", { class: "assign" });
  const place = async (p, s) => {
    await patch("plantings", p.id, { bed_id: s.bed.id, start: s.x, offset: s.offset });
    paint();
  };
  function paint() {
    const ps = goalPlantings(g);
    list.replaceChildren(...ps.map((p) => {
      const bed = find.bed(p.bed_id);
      const ph = phases(p);
      const what = h("div", { class: "assign-what" },
        h("strong", {}, `Ernte ${fmtDay(ph.hs)} bis ${fmtDay(ph.he)}`),
        h("span", { class: "muted small" }, `${p.plant_date ? `pflanzen ${fmtDay(ph.plant)}` : `säen ${fmtDay(ph.sow)}`} · ${fmtNum(p.len)} × ${fmtNum(p.span ?? 1)} m`));
      if (bed) {
        return h("div", { class: "assign-row" }, what,
          h("span", { class: "assign-bed" }, `${bed.name}, ab ${fmtNum(p.start)} m`),
          h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: async () => { await patch("plantings", p.id, { bed_id: null }); paint(); } }, "Lösen"));
      }
      const sugg = suggestBeds(p);
      return h("div", { class: "assign-row" }, what,
        sugg.length ? h("div", { class: "assign-sugg" }, sugg.map((s) => h("button", { type: "button", class: `chip quick${s.rotation ? " warnchip" : ""}`,
          title: s.rotation ? "Gleiche Pflanzenfamilie stand hier in der Anbaupause" : null, onclick: () => place(p, s) },
        `${s.bed.name} ab ${fmtNum(s.x)} m${s.rotation ? " · Fruchtfolge" : ""}`)))
          : h("span", { class: "muted small" }, "Kein Beet frei in dieser Zeit"));
    }));
  }
  paint();
  ui.body.append(h("p", { class: "muted", style: { margin: 0 } },
    "Vorschläge sind Beete mit freiem Platz während der ganzen Zeit im Beet. Fruchtfolge-Treffer stehen hinten."), list);
  ui.foot.append(
    h("button", { type: "button", class: "btn", onclick: async () => {
      let n = 0;
      for (const p of goalPlantings(g)) {
        if (p.bed_id) continue;
        const s = suggestBeds(p, 1).find((x) => !x.rotation);
        if (s) { await patch("plantings", p.id, { bed_id: s.bed.id, start: s.x, offset: s.offset }); n += 1; }
      }
      paint();
      toast(n ? `${plural(n, "Satz", "Sätze")} auf Beete gelegt` : "Kein passender freier Platz ohne Fruchtfolge-Konflikt");
    } }, "Alle ersten Vorschläge übernehmen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => ui.dlg.close() }, "Fertig"));
  ui.open();
}
