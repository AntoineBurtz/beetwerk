// Übersicht eines Beets in der Seitenleiste (Karte, Zeitleiste): Eckdaten, Belegung und Fruchtfolge.
import { state, find } from "./store.js";
import {
  h, phases, mix, clamp, fmtDay, fmtNum, yearOf, yearStart, yearLength, KIND_LABEL, PLANTABLE, varietyText, foilById, foilLabel,
} from "./util.js";
import { icon } from "./ui.js";
import { bedFeedLine } from "./feedui.js";

// Nur lesen: Name, Art, Größe, Notizen; geändert wird über „Bearbeiten“
export function bedSummary(bed, { actions = [], onClose } = {}) {
  return h("section", { class: "panel-section bed-props" },
    h("div", { class: "panel-title" },
      h("h2", {}, bed.name),
      onClose ? h("button", { type: "button", class: "icon-btn", "aria-label": "Schließen", title: "Schließen", onclick: onClose },
        icon("close")) : null),
    h("p", { class: "muted", style: { margin: 0 } },
      `${KIND_LABEL[bed.kind]} · ${fmtNum(bed.length, 2)} × ${fmtNum(bed.width, 2)} m · ${fmtNum(bed.length * bed.width)} m²`),
    foilById(bed.foil_id) ? h("p", { class: "muted", style: { margin: 0 } }, foilLabel(foilById(bed.foil_id))) : null,
    bed.notes ? h("p", { class: "small", style: { margin: 0, whiteSpace: "pre-wrap" } }, bed.notes) : null,
    actions.length ? h("div", { class: "actions" }, actions) : null);
}

export function bedUsage(bed, { onPlanting } = {}) {
  if (!PLANTABLE.has(bed.kind)) return [];
  const year = yearOf(state.day);
  const ys = yearStart(year), ye = ys + yearLength(year) - 1;
  const mine = state.plantings.filter((p) => p.bed_id === bed.id);
  const inYear = (y) => {
    const a = yearStart(y), b = a + yearLength(y) - 1;
    return mine.filter((p) => { const ph = phases(p); return ph.sow <= b && ph.he >= a; })
      .sort((p, q) => phases(p).fieldStart - phases(q).fieldStart);
  };
  const list = (items, y) => h("div", { class: "bed-timeline" }, items.map((p) => {
    const c = find.crop(p.crop_id);
    return h("div", { class: "row" },
      h("button", { type: "button", onclick: () => onPlanting?.(p), title: `${c?.name ?? ""} ${varietyText(p)}` },
        c?.name ?? "Kultur", varietyText(p) ? h("span", { class: "muted" }, ` ${varietyText(p)}`) : null),
      miniTimeline(p, y));
  }));
  const thisYear = inYear(year);
  // Was erst im Folgejahr beginnt, steht darunter: so findet sich im Herbst, was für das Frühjahr geplant ist
  const nextYear = inYear(year + 1);
  const fresh = nextYear.some((p) => phases(p).sow > ye);
  return [
    h("section", { class: "panel-section" }, h("h3", {}, `Belegung ${year}`),
      thisYear.length ? list(thisYear, year)
        : h("p", { class: "muted small", style: { margin: 0 } }, fresh ? `${year} nichts geplant.` : "Noch nichts geplant."),
      bedFeedLine(bed, year)),
    fresh ? h("section", { class: "panel-section" }, h("h3", {}, `Belegung ${year + 1}`), list(nextYear, year + 1), bedFeedLine(bed, year + 1)) : null,
    h("section", { class: "panel-section" }, h("h3", {}, "Fruchtfolge"), rotationHistory(bed, year)),
  ].filter(Boolean);
}

export function rotationHistory(bed, year) {
  const n = Math.max(3, Number(state.settings.rotation_years ?? 3));
  const grid = h("div", { class: "bed-history" });
  for (let y = year; y >= year - n; y--) {
    const fams = new Set();
    for (const p of state.plantings) {
      if (p.bed_id !== bed.id || yearOf(phases(p).fieldStart) !== y) continue;
      const c = find.crop(p.crop_id);
      if (c?.family) fams.add(c.family);
    }
    grid.append(h("span", { class: "num muted" }, y),
      h("span", { class: "fams" }, fams.size ? [...fams].map((f) => h("span", { class: "fam" }, f)) : h("span", { class: "muted small" }, "–")));
  }
  return grid;
}

// Satz als schmaler Balken über ein Jahr oder über einen eigenen Bereich { ys, len }
export function miniTimeline(p, year, range = null) {
  const ys = range ? range.ys : yearStart(year), len = range ? range.len : yearLength(year);
  const ph = phases(p);
  const c = find.crop(p.crop_id);
  const color = c?.color || "#6a9b3c";
  const pct = (d) => `${clamp(((d - ys) / len) * 100, 0, 100)}%`;
  const w = (a, b) => `calc(${pct(b + 1)} - ${pct(a)})`;
  const bar = h("div", { class: "mini-tl", title: `${fmtDay(ph.sow)} bis ${fmtDay(ph.he)}` });
  if (ph.plant != null) bar.append(h("i", { style: { left: pct(ph.sow), width: w(ph.sow, ph.plant - 1), background: mix(color, "#ffffff", 0.7), top: "3px", bottom: "3px" } }));
  bar.append(h("i", { style: { left: pct(ph.fieldStart), width: w(ph.fieldStart, ph.hs - 1), background: mix(color, "#ffffff", 0.45) } }));
  bar.append(h("i", { style: { left: pct(ph.hs), width: w(ph.hs, ph.he), background: color } }));
  if (state.day >= ys && state.day < ys + len) bar.append(h("span", { class: "now", style: { left: pct(state.day) } }));
  return bar;
}
