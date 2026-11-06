// Merkmale einer Sorte: Werte aus der Bonitur, sonst aus dem Internet oder eigene Angaben.
// Klasse und Zahl sind getrennte Felder (Pflanzengröße „groß“ und Pflanzenhöhe 175 cm).
import { h } from "./util.js";

export const SOURCE_LABEL = { bonitur: "Bonitur", internet: "Internet", manual: "eigene Angabe" };
const GROUP = { regular: "plant", plant: "plant", flower: "flower", fruit: "fruit", taste: "taste", breeding: "breeding" };
const GROUP_LABEL = { plant: "Pflanze", flower: "Blüte", fruit: "Frucht", taste: "Geschmack", breeding: "Kreuzung und Saatgut" };
const GROUP_ORDER = Object.keys(GROUP_LABEL);
// Klasse und Zahl nebeneinander, die wichtigsten zuerst
const FIRST = ["plant_size", "height", "tom_growth", "pep_habit", "pep_species", "fruit_size", "tom_fruit_weight",
  "pep_fruit_weight", "maturity_class", "days_to_maturity", "tom_fruit_color", "pep_fruit_color", "tom_fruit_shape",
  "pep_fruit_shape", "pep_heat", "pep_scoville"];
const CORE = new Set([...FIRST, "pep_pungency"]);

function rank(r) {
  const i = FIRST.indexOf(r.key);
  return i < 0 ? 100 : i;
}

function ordered(rows) {
  const pos = new Map(rows.map((r, i) => [r.key, i]));
  return [...rows].sort((a, b) => GROUP_ORDER.indexOf(GROUP[a.section] || "plant") - GROUP_ORDER.indexOf(GROUP[b.section] || "plant")
    || rank(a) - rank(b) || pos.get(a.key) - pos.get(b.key));
}

export function fmtValue(r, value) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (r.type === "number" || r.type === "score") {
    const n = Number(value);
    let text = Math.abs(n - Math.round(n)) > 0.05 ? n.toFixed(1).replace(".", ",") : String(Math.round(n));
    if (n >= 10000) text = Math.round(n).toLocaleString("de-DE");
    if (r.type === "number") return `${text} ${r.unit || ""}`.trim();
    const label = r.options && !Array.isArray(r.options) && Math.abs(n - Math.round(n)) < 0.05 ? r.options[String(Math.round(n))] : "";
    return label ? `${text} – ${label}` : text;
  }
  return String(value);
}

function badge(source, year) {
  if (!source) return null;
  return h("span", { class: `src src-${source}` }, source === "bonitur" && year ? `Bonitur ${year}` : SOURCE_LABEL[source]);
}

function parseNumber(text) {
  const t = String(text).trim().replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

// rows: Zeilen wie /api/varieties/{id}/profile; values: {key: {value, source}} (gespeichertes Profil)
// highlight: Schlüssel, die gerade aus der Recherche kamen (grün hinterlegt)
// compact: nur Zeilen mit Wert, ohne „Weitere Merkmale“
export function profileForm({ rows = null, values = {}, highlight = new Set(), compact = false } = {}) {
  const vals = new Map(Object.entries(values || {}).filter(([, e]) => e && e.value != null));
  const el = h("div", { class: "prof" });
  let current = rows;
  let moreOpen = false;

  function setVal(key, value) {
    const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
    if (empty) vals.delete(key);
    else vals.set(key, { value, source: "manual" });
    highlight.delete(key);
  }

  function control(r, cell) {
    const cur = vals.get(r.key)?.value;
    const hl = highlight.has(r.key) ? "filled" : null;
    const changed = () => { cell.querySelector(".src")?.replaceWith(badge(vals.has(r.key) ? "manual" : null) || h("span", { class: "src" }));
      cell.querySelector(".filled")?.classList.remove("filled"); };
    if (r.type === "choice" || r.type === "score") {
      let opts;
      if (r.type === "choice") opts = (r.options || []).map((o) => [o, o]);
      else {
        const lo = r.min ?? 1;
        const hi = r.max ?? 9;
        opts = [];
        for (let i = lo; i <= hi; i++) opts.push([i, fmtValue(r, i)]);
      }
      const sel = h("select", { class: hl, "aria-label": r.name },
        h("option", { value: "" }, "–"),
        opts.map(([v, label]) => h("option", { value: v, selected: cur != null && String(cur) === String(v) }, label)));
      if (cur != null && !opts.some(([v]) => String(v) === String(cur))) sel.append(h("option", { value: cur, selected: true }, fmtValue(r, cur)));
      sel.addEventListener("change", () => { setVal(r.key, sel.value === "" ? null : r.type === "score" ? Number(sel.value) : sel.value); changed(); });
      return sel;
    }
    if (r.type === "multi") {
      const chosen = new Set(Array.isArray(cur) ? cur : cur ? [cur] : []);
      const box = h("div", { class: `prof-chips${hl ? " filled" : ""}`, role: "group", "aria-label": r.name });
      for (const o of r.options || []) {
        const b = h("button", { type: "button", class: "chip", "aria-pressed": chosen.has(o) ? "true" : "false", onclick: () => {
          if (chosen.has(o)) chosen.delete(o); else chosen.add(o);
          b.setAttribute("aria-pressed", chosen.has(o) ? "true" : "false");
          setVal(r.key, (r.options || []).filter((x) => chosen.has(x)));
          changed();
        } }, o);
        box.append(b);
      }
      return box;
    }
    if (r.type === "number") {
      const input = h("input", { inputmode: "decimal", value: cur != null ? String(cur).replace(".", ",") : "", class: hl,
        "aria-label": r.name, placeholder: r.hint && r.hint.length < 30 ? r.hint : "" });
      input.addEventListener("input", () => { setVal(r.key, input.value.trim() || null); changed(); });
      return h("div", { class: "prof-num" }, input, r.unit ? h("span", { class: "unit" }, r.unit) : null);
    }
    const input = h("input", { value: cur ?? "", maxlength: 500, class: hl, "aria-label": r.name });
    input.addEventListener("input", () => { setVal(r.key, input.value.trim() || null); changed(); });
    return input;
  }

  function cell(r) {
    const b = r.bonitur;
    const stored = vals.get(r.key);
    const c = h("div", { class: `prof-cell${b ? " is-bonitur" : ""}` });
    const label = h("div", { class: "prof-label" }, h("span", {}, r.name),
      b ? badge("bonitur", b.year) : badge(stored?.source) || h("span", { class: "src" }));
    if (b) {
      const earlier = b.years?.length > 1 ? ` (auch ${b.years.slice(1).join(", ")})` : "";
      c.append(label, h("div", { class: "prof-bon" },
        h("strong", {}, b.text),
        b.detail ? h("span", { class: "small muted" }, b.detail + earlier) : null,
        stored ? h("span", { class: "small muted" }, `${SOURCE_LABEL[stored.source] || "Angabe"}: ${fmtValue(r, stored.value)}`) : null));
    } else {
      c.append(label, control(r, c));
    }
    return c;
  }

  function groups(list) {
    const out = [];
    let last = null;
    let grid = null;
    for (const r of list) {
      const g = GROUP[r.section] || "plant";
      if (g !== last) {
        last = g;
        grid = h("div", { class: "prof-grid" });
        out.push(h("div", { class: "prof-group" }, h("h4", {}, GROUP_LABEL[g]), grid));
      }
      grid.append(cell(r));
    }
    return out;
  }

  function paint() {
    if (!current) {
      el.replaceChildren(h("p", { class: "muted small", style: { margin: 0 } }, "Lade Merkmale …"));
      return;
    }
    const list = ordered(current);
    const hasValue = (r) => r.bonitur || vals.has(r.key);
    const main = list.filter((r) => hasValue(r) || (!compact && CORE.has(r.key)));
    const rest = compact ? [] : list.filter((r) => !main.includes(r));
    const kids = groups(main);
    if (rest.length) {
      const det = h("details", { class: "prof-more" }, h("summary", {}, `Weitere Merkmale (${rest.length})`), ...groups(rest));
      det.open = moreOpen;
      det.addEventListener("toggle", () => { moreOpen = det.open; });
      kids.push(det);
    }
    if (!kids.length) kids.push(h("p", { class: "muted small", style: { margin: 0 } }, "Für diese Kultur gibt es keine Merkmale."));
    el.replaceChildren(...kids);
  }

  paint();
  return {
    el,
    setRows(next) { current = next; paint(); },
    get loaded() { return current != null; },
    count() { return current ? current.filter((r) => r.bonitur || vals.has(r.key)).length : 0; },
    // Profil zum Speichern; wirft bei ungültigen Zahlen. undefined, solange die Merkmale noch laden.
    get() {
      if (!current) return undefined;
      const out = {};
      for (const r of current) {
        const e = vals.get(r.key);
        if (!e) continue;
        let { value } = e;
        if (r.type === "number" && typeof value === "string") {
          value = parseNumber(value);
          if (Number.isNaN(value)) throw new Error(`${r.name}: bitte nur eine Zahl eingeben${r.unit ? ` (in ${r.unit})` : ""}`);
          if (value == null) continue;
          if ((r.min != null && value < r.min) || (r.max != null && value > r.max)) {
            throw new Error(`${r.name}: ${fmtValue(r, value)} liegt außerhalb von ${fmtValue(r, r.min ?? 0)} bis ${fmtValue(r, r.max)}`);
          }
        }
        out[r.key] = { value, source: e.source };
      }
      return out;
    },
  };
}

// Kurzfassung für die Karten der Sortenliste: wenige, eindeutig benannte Angaben
const CARD = [
  ["plant_size", (t) => `Pflanze ${t}`], ["height", (t) => `${t} hoch`], ["fruit_size", (t) => `Frucht ${t}`],
  ["tom_fruit_weight", (t) => t], ["pep_fruit_weight", (t) => t], ["maturity_class", (t) => t],
  ["days_to_maturity", (t) => t], ["tom_fruit_color", (t) => t], ["pep_fruit_color", (t) => t], ["pep_scoville", (t) => t],
];

export function cardTraits(summary, max = 4) {
  if (!summary?.length) return [];
  const by = new Map(summary.map((s) => [s.key, s]));
  return CARD.filter(([k]) => by.has(k)).slice(0, max).map(([k, f]) => ({ text: f(by.get(k).text), source: by.get(k).source }));
}

// Nur lesen: Merkmale mit Wert, nach Abschnitt, mit Herkunft (für die Übersicht einer Sorte)
export function profileView(rows) {
  const list = ordered(rows.filter((r) => r.text));
  if (!list.length) return null;
  const out = [];
  let last = null;
  let grid = null;
  for (const r of list) {
    const g = GROUP[r.section] || "plant";
    if (g !== last) {
      last = g;
      grid = h("dl", { class: "pv-grid" });
      out.push(h("div", { class: "prof-group" }, h("h4", {}, GROUP_LABEL[g]), grid));
    }
    const b = r.bonitur;
    const notes = [];
    if (b?.detail) notes.push(b.detail + (b.years?.length > 1 ? ` (auch ${b.years.slice(1).join(", ")})` : ""));
    if (b && r.stored) notes.push(`${SOURCE_LABEL[r.stored.source] || "Angabe"}: ${fmtValue(r, r.stored.value)}`);
    grid.append(h("div", { class: "pv-item" },
      h("dt", {}, r.name),
      h("dd", {}, h("span", { class: "pv-value" }, r.text), badge(r.source, b?.year),
        notes.length ? h("span", { class: "pv-note" }, notes.join(" · ")) : null)));
  }
  return h("div", { class: "prof" }, out);
}
