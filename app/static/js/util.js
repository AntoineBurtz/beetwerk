// Datumsrechnung in ganzen Tagen (UTC), damit Sommerzeit nie stört.

const DAY = 86400000;

export function dayNum(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

export function isoOf(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function todayNum() {
  const t = new Date();
  return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY);
}

export function yearOf(n) {
  return new Date(n * DAY).getUTCFullYear();
}

export function yearStart(year) {
  return Math.floor(Date.UTC(year, 0, 1) / DAY);
}

export function yearLength(year) {
  return yearStart(year + 1) - yearStart(year);
}

export function isoWeek(n) {
  const d = new Date(n * DAY);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // Donnerstag dieser Woche
  const ft = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d - ft) / (7 * DAY));
}

export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
  "September", "Oktober", "November", "Dezember"];
export const MONTHS_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function fmtDay(n, opts = {}) {
  if (n == null) return "–";
  const d = new Date(n * DAY);
  const s = `${d.getUTCDate()}. ${MONTHS_SHORT[d.getUTCMonth()]}`;
  return opts.year ? `${s} ${d.getUTCFullYear()}` : s;
}

export function fmtDayLong(n) {
  const d = new Date(n * DAY);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtNum(v, digits = 1) {
  return Number(v).toLocaleString("de-DE", { maximumFractionDigits: digits });
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function snap(v, step) {
  return Math.round(v / step) * step;
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- Sätze

export function phases(p) {
  const sow = dayNum(p.sow_date);
  const plant = p.method === "transplant" ? dayNum(p.plant_date) : null;
  const hs = dayNum(p.harvest_start);
  const he = dayNum(p.harvest_end);
  return { sow, plant, hs, he, fieldStart: plant ?? sow };
}

export function onBedAt(p, day) {
  const ph = phases(p);
  return ph.fieldStart <= day && day <= ph.he;
}

export function spanOf(p, bed) {
  if (p.span != null) return p.span;
  return bed ? Math.max(0.05, bed.width - (p.offset || 0)) : 1;
}

export function spacing(p, crop) {
  return {
    row: p.row_spacing || crop?.row_spacing || 30,
    plant: p.plant_spacing || crop?.plant_spacing || 30,
  };
}

// Pflanzbild: Reihen laufen immer entlang der längeren Seite der Fläche.
// along = "x": Reihen waagrecht (entlang der Länge), sonst senkrecht.
export function plantLayout(p, crop, bed) {
  const sp = spacing(p, crop);
  const lenM = p.len;
  const spanM = spanOf(p, bed);
  const along = lenM >= spanM ? "x" : "y";
  const longM = along === "x" ? lenM : spanM;
  const shortM = along === "x" ? spanM : lenM;
  const rows = p.rows || Math.max(1, Math.floor((shortM * 100 + 0.5) / sp.row));
  const perRow = Math.max(1, Math.floor((longM * 100 + 0.5) / sp.plant));
  return { along, rows, perRow, sp };
}

export function rowCount(p, crop, bed) {
  return plantLayout(p, crop, bed).rows;
}

export function plantCount(p, crop, bed) {
  const l = plantLayout(p, crop, bed);
  return l.rows * l.perRow;
}

// ---------------------------------------------------------------- Mischsatz (mehrere Sorten in einem Satz)

export const VARIETY_COLORS = ["#c0392b", "#2d6a4f", "#e8a33b", "#6c3483", "#2f7ab8", "#8c564b",
  "#d4527e", "#138d90", "#9aa61f", "#5f5e5a", "#e8743b", "#3e5c9a"];

export function varietyColor(i) {
  return VARIETY_COLORS[i % VARIETY_COLORS.length];
}

export function varietyMark(i) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

export function isMixed(p) {
  return Array.isArray(p.varieties) && p.varieties.length > 0;
}

// Kurzbeschreibung der Sorte(n) für Listen und Beschriftungen
export function varietyText(p) {
  if (isMixed(p)) return p.varieties.length === 1 ? p.varieties[0].name : `${p.varieties.length} Sorten`;
  return p.variety || "";
}

export function varietyNames(p) {
  return isMixed(p) ? p.varieties.map((v) => `${v.name} (${v.count})`).join(", ") : p.variety || "";
}

// Plätze in Pflanzreihenfolge. r/c = Reihe/Platz physisch (Reihe quer zur langen Seite, Platz entlang),
// row/place = Nummer ab der Startecke (1-basiert). fill: "snake" | "columns", start: "tl" | "tr" | "bl" | "br"
export function plantOrder(layout, fill = "snake", start = "tl") {
  const { along, rows, perRow } = layout;
  const left = start[1] !== "r", top = start[0] !== "b";
  const L = [...Array(perRow).keys()];
  const S = [...Array(rows).keys()];
  if (!(along === "x" ? left : top)) L.reverse();
  if (!(along === "x" ? top : left)) S.reverse();
  const placeNo = new Map(L.map((c, i) => [c, i + 1]));
  const out = [];
  if (fill === "columns") {
    L.forEach((c) => S.forEach((r, ri) => out.push({ r, c, row: ri + 1, place: placeNo.get(c) })));
  } else {
    S.forEach((r, ri) => (ri % 2 === 0 ? L : [...L].reverse()).forEach((c) => out.push({ r, c, row: ri + 1, place: placeNo.get(c) })));
  }
  return out;
}

// Pflanzplan eines Mischsatzes: Reihenfolge mit Sortenindex v (oder undefined = frei)
export function mixPlan(p, crop, bed) {
  const layout = plantLayout(p, crop, bed);
  const order = plantOrder(layout, p.fill, p.fill_start);
  const varieties = isMixed(p) ? p.varieties : [];
  let k = 0;
  varieties.forEach((v, vi) => {
    for (let n = 0; n < v.count && k < order.length; n++) order[k++].v = vi;
  });
  const total = varieties.reduce((t, v) => t + v.count, 0);
  return { layout, order, total, capacity: order.length, free: Math.max(0, order.length - total), overflow: Math.max(0, total - order.length) };
}

// Lage einer Sorte als Text, z. B. "Reihe 1: 1–7 · Reihe 2: 9–10"
export function varietyPlaces(plan, vi) {
  const byRow = new Map();
  for (const o of plan.order) {
    if (o.v !== vi) continue;
    if (!byRow.has(o.row)) byRow.set(o.row, []);
    byRow.get(o.row).push(o.place);
  }
  return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, places]) => {
    places.sort((a, b) => a - b);
    const parts = [];
    let from = places[0], prev = places[0];
    for (const pl of places.slice(1).concat([null])) {
      if (pl !== null && pl === prev + 1) { prev = pl; continue; }
      parts.push(from === prev ? `${from}` : `${from}–${prev}`);
      from = prev = pl;
    }
    return `Reihe ${row}: ${parts.join(", ")}`;
  }).join(" · ");
}

export function area(p, bed) {
  return p.len * spanOf(p, bed);
}

function rectsOverlap(a, b) {
  const eps = 0.001;
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}

export function rectOf(p, bed) {
  return { x: p.start, y: p.offset || 0, w: p.len, h: spanOf(p, bed) };
}

// Termine aus den Kulturdaten ableiten. anchor = Tag, an dem die Fläche belegt wird.
export function datesFromCrop(crop, anchor, method = crop.method) {
  if (method === "transplant") {
    const plant = anchor;
    const sow = plant - (crop.nursery_days || 0);
    const hs = plant + (crop.field_days || 0);
    return { sow_date: isoOf(sow), plant_date: isoOf(plant), harvest_start: isoOf(hs),
      harvest_end: isoOf(hs + (crop.harvest_days || 0)) };
  }
  const hs = anchor + (crop.field_days || 0);
  return { sow_date: isoOf(anchor), plant_date: null, harvest_start: isoOf(hs),
    harvest_end: isoOf(hs + (crop.harvest_days || 0)) };
}

// Konflikte (gleiche Fläche zur gleichen Zeit) und Fruchtfolge-Hinweise für alle Sätze.
export function analyse(state) {
  const issues = new Map();
  const add = (id, kind, text) => {
    if (!issues.has(id)) issues.set(id, []);
    const list = issues.get(id);
    if (!list.some((i) => i.text === text)) list.push({ kind, text });
  };
  const beds = new Map(state.beds.map((b) => [b.id, b]));
  const crops = new Map(state.crops.map((c) => [c.id, c]));
  const byBed = new Map();
  for (const p of state.plantings) {
    if (p.bed_id == null) continue;
    if (!byBed.has(p.bed_id)) byBed.set(p.bed_id, []);
    byBed.get(p.bed_id).push(p);
  }
  const years = Number(state.settings.rotation_years ?? 3);

  for (const [bedId, list] of byBed) {
    const bed = beds.get(bedId);
    if (!bed) continue;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const pa = phases(a);
      const ra = rectOf(a, bed);
      const ca = crops.get(a.crop_id);
      if (ra.x + ra.w > bed.length + 0.001 || ra.y + ra.h > bed.width + 0.001) {
        add(a.id, "conflict", `Ragt über den Rand von ${bed.name} hinaus`);
      }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const pb = phases(b);
        if (pa.fieldStart <= pb.he && pb.fieldStart <= pa.he && rectsOverlap(ra, rectOf(b, bed))) {
          const cb = crops.get(b.crop_id);
          add(a.id, "conflict", `Überschneidet sich mit ${cb?.name ?? "Satz"} (${fmtDay(pb.fieldStart)} bis ${fmtDay(pb.he)})`);
          add(b.id, "conflict", `Überschneidet sich mit ${ca?.name ?? "Satz"} (${fmtDay(pa.fieldStart)} bis ${fmtDay(pa.he)})`);
        }
      }
      if (!years || !ca?.family) continue;
      const ya = yearOf(pa.fieldStart);
      for (const b of list) {
        if (b === a) continue;
        const cb = crops.get(b.crop_id);
        if (!cb || cb.family !== ca.family) continue;
        const yb = yearOf(phases(b).fieldStart);
        if (yb < ya && ya - yb <= years && rectsOverlap(ra, rectOf(b, bed))) {
          add(a.id, "rotation", `${ca.family}: ${cb.name} stand ${yb} an dieser Stelle`);
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------- Farben

export function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.36 ? "#1d2b24" : "#ffffff";
}

export function mix(hex, other, t) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return "#" + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- DOM

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const KIND_LABEL = {
  bed: "Beet",
  raised: "Hochbeet",
  greenhouse: "Gewächshaus",
  path: "Weg",
  other: "Sonstiges",
};

export const PLANTABLE = new Set(["bed", "raised", "greenhouse"]);
