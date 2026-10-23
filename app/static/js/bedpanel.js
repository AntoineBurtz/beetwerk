// Eigenschaften eines Beets zum direkten Bearbeiten, dazu Belegung und Fruchtfolge.
// Wird in der Seitenleiste der Karte und der Zeitleiste verwendet.
import { state, find, patch } from "./store.js";
import {
  h, phases, mix, clamp, fmtDay, fmtNum, yearOf, yearStart, yearLength, round2, KIND_LABEL, PLANTABLE, varietyText,
} from "./util.js";
import { toast, icon } from "./ui.js";

function num(v) {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function fmtInput(v) {
  return String(round2(v)).replace(".", ",");
}

export function bedProperties(bed, { actions = [], onClose } = {}) {
  const commit = (changes, what) =>
    patch("beds", bed.id, changes, { undoLabel: `${bed.name}: ${what} geändert`, silent: false }).catch(() => {});

  const name = h("input", { class: "input", value: bed.name, maxlength: 80, "data-focus-key": "bed-name", "aria-label": "Name" });
  name.addEventListener("change", () => {
    const v = name.value.trim();
    if (!v) { toast("Der Name darf nicht leer sein", { error: true }); name.value = bed.name; return; }
    if (v !== bed.name) commit({ name: v }, "Name");
  });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });

  const kind = h("select", { class: "input", "data-focus-key": "bed-kind", "aria-label": "Art" },
    Object.entries(KIND_LABEL).map(([k, label]) => h("option", { value: k, selected: k === bed.kind }, label)));
  kind.addEventListener("change", () => commit({ kind: kind.value }, "Art"));

  const sizeInput = (key, label) => {
    const el = h("input", { class: "input", inputmode: "decimal", value: fmtInput(bed[key]), "data-focus-key": `bed-${key}`, "aria-label": label });
    el.addEventListener("change", () => {
      const v = num(el.value);
      if (!(v > 0) || v > 500) { toast(`${label}: bitte eine Zahl größer als 0 eingeben`, { error: true }); el.value = fmtInput(bed[key]); return; }
      if (round2(v) !== bed[key]) commit({ [key]: round2(v) }, label);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
    return el;
  };
  const length = sizeInput("length", "Länge");
  const width = sizeInput("width", "Breite");

  const notes = h("textarea", { class: "input", rows: 2, "data-focus-key": "bed-notes", "aria-label": "Notizen",
    placeholder: "Bodenart, Bewässerung, Mulch …" }, bed.notes || "");
  notes.addEventListener("change", () => { if (notes.value !== (bed.notes || "")) commit({ notes: notes.value }, "Notizen"); });

  const field = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
  return h("section", { class: "panel-section bed-props" },
    h("div", { class: "panel-title" },
      h("h2", {}, bed.name),
      onClose ? h("button", { type: "button", class: "icon-btn", "aria-label": "Schließen", title: "Schließen", onclick: onClose },
        icon("close")) : null),
    h("p", { class: "muted small", style: { margin: 0 } },
      `${KIND_LABEL[bed.kind]}, ${fmtNum(bed.length * bed.width)} m²`),
    field("Name", name),
    h("div", { class: "bed-props-grid" }, field("Art", kind), field("Länge (m)", length), field("Breite (m)", width)),
    field("Notizen", notes),
    actions.length ? h("div", { class: "actions" }, actions) : null);
}

export function bedUsage(bed, { onPlanting } = {}) {
  if (!PLANTABLE.has(bed.kind)) return [];
  const year = yearOf(state.day);
  const ys = yearStart(year), ye = ys + yearLength(year) - 1;
  const thisYear = state.plantings
    .filter((p) => p.bed_id === bed.id)
    .filter((p) => { const ph = phases(p); return ph.sow <= ye && ph.he >= ys; })
    .sort((a, b) => phases(a).fieldStart - phases(b).fieldStart);
  return [
    h("section", { class: "panel-section" }, h("h3", {}, `Belegung ${year}`),
      thisYear.length
        ? h("div", { class: "bed-timeline" }, thisYear.map((p) => {
          const c = find.crop(p.crop_id);
          return h("div", { class: "row" },
            h("button", { type: "button", onclick: () => onPlanting?.(p), title: `${c?.name ?? ""} ${varietyText(p)}` },
              c?.name ?? "Kultur", varietyText(p) ? h("span", { class: "muted" }, ` ${varietyText(p)}`) : null),
            miniTimeline(p, year));
        }))
        : h("p", { class: "muted small", style: { margin: 0 } }, "Noch nichts geplant.")),
    h("section", { class: "panel-section" }, h("h3", {}, "Fruchtfolge"), rotationHistory(bed, year)),
  ];
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

export function miniTimeline(p, year) {
  const ys = yearStart(year), len = yearLength(year);
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
