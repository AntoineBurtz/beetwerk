// Beetkarte: Grundstück mit Beeten, darauf die Sätze, die am Stichtag im Beet stehen.
import { state, find, select, patch, remove, setDay, setPlacing, issuesOf, api, replaceAll } from "./store.js";
import {
  h, s, phases, onBedAt, rectOf, spanOf, rowCount, plantCount, spacing, mix, clamp, snap, round2,
  fmtDay, fmtNum, yearOf, yearStart, yearLength, MONTHS_SHORT, KIND_LABEL, PLANTABLE, isoOf, plural,
} from "./util.js";
import { openPlantingEditor, openBedEditor, createBedAt, placeCrop, createSuccession } from "./editor.js";
import { iconBtn, icon, toast, confirmDialog } from "./ui.js";

const U = 100; // SVG-Einheiten pro Meter, also Zentimeter
const UPCOMING_DAYS = 21;

let view = null; // { x, y, w, h } bleibt beim Wechsel der Ansicht erhalten
let cropQuery = "";

export function mountMap(root) {
  const svg = s("svg", { class: "map-svg", role: "application", "aria-label": "Beetkarte", tabindex: "0" });
  const tools = h("div", { class: "map-tools" },
    iconBtn("plus", "Vergrößern", () => zoomAtCenter(0.75)),
    iconBtn("minus", "Verkleinern", () => zoomAtCenter(1.33)),
    iconBtn("fit", "Ganzen Garten zeigen", () => { fit(); render(); }));
  const hint = h("div", { class: "map-hint", hidden: true });
  const empty = h("div", { class: "map-empty", hidden: true });
  const stage = h("div", { style: { position: "relative", minHeight: "0" } }, svg, tools, hint, empty);
  const scrub = buildScrubber();
  const panel = h("aside", { class: "panel", "aria-label": "Details" });
  const el = h("div", { class: "mapview" }, h("div", { class: "map-area" }, stage, scrub.el), panel);
  root.append(el);

  let size = { w: 1, h: 1 };
  let frame = 0;
  let pending = new Set();

  // ------------------------------------------------------------ Ansicht

  function gardenSize() {
    return { W: Number(state.settings.garden_width || 16), H: Number(state.settings.garden_height || 11) };
  }

  function upp() { return view.w / size.w; } // SVG-Einheiten pro Bildschirmpixel

  function fit() {
    const { W, H } = gardenSize();
    const m = 0.08 * Math.max(W, H) * U + 40;
    let w = W * U + 2 * m;
    let hh = H * U + 2 * m;
    const aspect = size.w / size.h;
    if (w / hh > aspect) hh = w / aspect; else w = hh * aspect;
    view = { x: (W * U - w) / 2, y: (H * U - hh) / 2, w, h: hh };
  }

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function zoomAround(px, py, factor) {
    const { W, H } = gardenSize();
    const maxW = Math.max(W, H) * U * 4;
    const nw = clamp(view.w * factor, 120, maxW);
    const f = nw / view.w;
    const wx = view.x + (px / size.w) * view.w;
    const wy = view.y + (py / size.h) * view.h;
    view = { x: wx - (wx - view.x) * f, y: wy - (wy - view.y) * f, w: nw, h: view.h * f };
    schedule("svg");
  }

  function zoomAtCenter(factor) { zoomAround(size.w / 2, size.h / 2, factor); }

  const ro = new ResizeObserver(() => {
    const r = svg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const old = size;
    size = { w: r.width, h: r.height };
    if (!view) fit();
    else {
      const k = view.w / old.w;
      const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
      view = { w: size.w * k, h: size.h * k, x: cx - (size.w * k) / 2, y: cy - (size.h * k) / 2 };
    }
    render();
  });
  ro.observe(svg);

  // ------------------------------------------------------------ Zeichnen

  function schedule(...parts) {
    for (const p of parts) pending.add(p);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const parts = pending;
      pending = new Set();
      if (parts.has("all")) { render(); return; }
      if (parts.has("svg")) renderSvg();
      if (parts.has("panel")) renderPanel();
      if (parts.has("scrub")) scrub.render(parts.has("area"));
    });
  }

  function render() {
    if (!view) return;
    renderSvg();
    renderPanel();
    scrub.render(true);
  }

  function defs() {
    const minor = s("pattern", { id: "grid-minor", width: 50, height: 50, patternUnits: "userSpaceOnUse" },
      s("path", { d: "M50 0H0V50", fill: "none", stroke: "rgba(29,43,36,.07)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
    const major = s("pattern", { id: "grid-major", width: 100, height: 100, patternUnits: "userSpaceOnUse" },
      s("rect", { width: 100, height: 100, fill: "url(#grid-minor)" }),
      s("path", { d: "M100 0H0V100", fill: "none", stroke: "rgba(29,43,36,.14)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
    const soil = s("pattern", { id: "soil", width: 36, height: 36, patternUnits: "userSpaceOnUse" },
      s("rect", { width: 36, height: 36, fill: "#b4967a" }),
      s("circle", { cx: 6, cy: 8, r: 1.6, fill: "#9a7c60" }),
      s("circle", { cx: 24, cy: 5, r: 1.2, fill: "#c7ac91" }),
      s("circle", { cx: 17, cy: 21, r: 1.8, fill: "#9a7c60" }),
      s("circle", { cx: 31, cy: 28, r: 1.3, fill: "#9a7c60" }),
      s("circle", { cx: 8, cy: 30, r: 1.1, fill: "#c7ac91" }));
    const glass = s("pattern", { id: "glass", width: 40, height: 40, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 40, height: 40, fill: "#c9b294" }),
      s("rect", { width: 6, height: 40, fill: "#bda485" }));
    const gravel = s("pattern", { id: "gravel", width: 24, height: 24, patternUnits: "userSpaceOnUse" },
      s("rect", { width: 24, height: 24, fill: "#e7e4dc" }),
      s("circle", { cx: 5, cy: 6, r: 2.2, fill: "#d6d1c6" }),
      s("circle", { cx: 16, cy: 15, r: 2.6, fill: "#d6d1c6" }),
      s("circle", { cx: 19, cy: 4, r: 1.6, fill: "#cfc9bd" }));
    const hatch = s("pattern", { id: "hatch", width: 14, height: 14, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 4, height: 14, fill: "rgba(251,252,249,.55)" }));
    return s("defs", {}, minor, major, soil, glass, gravel, hatch);
  }

  function renderSvg() {
    if (!view) return;
    applyView();
    svg.classList.toggle("placing", !!state.placing);
    const k = upp();
    const { W, H } = gardenSize();
    const groundLayer = s("g", {},
      s("rect", { class: "garden", x: 0, y: 0, width: W * U, height: H * U }),
      s("rect", { x: 0, y: 0, width: W * U, height: H * U, fill: "url(#grid-major)" }),
      s("rect", { x: 0, y: 0, width: W * U, height: H * U, fill: "none", stroke: "#9fb093", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));

    // Meterangaben am Rand, ausgedünnt je nach Zoom
    const step = k > 2.2 ? 2 : 1;
    const ruler = s("g", { class: "ruler", style: `font-size:${11 * k}px` });
    for (let i = 0; i <= W; i += step) ruler.append(s("text", { x: i * U, y: -6 * k, "text-anchor": "middle" }, i));
    for (let j = step; j <= H; j += step) ruler.append(s("text", { x: -6 * k, y: j * U + 4 * k, "text-anchor": "end" }, j));
    ruler.append(s("text", { x: W * U + 8 * k, y: -6 * k, "text-anchor": "start" }, "m"));

    const bedLayer = s("g", {});
    const overLayer = s("g", {});
    const ordered = [...state.beds].sort((a, b) => (a.kind === "path" ? -1 : 0) - (b.kind === "path" ? -1 : 0));
    for (const bed of ordered) bedLayer.append(drawBed(bed, k, overLayer));

    svg.replaceChildren(defs(), groundLayer, ruler, bedLayer, overLayer);

    empty.hidden = state.beds.length > 0 || !state.loaded;
    if (!empty.hidden && !empty.firstChild) renderEmpty();
    if (state.placing) {
      const crop = find.crop(state.placing);
      hint.hidden = false;
      hint.replaceChildren(h("span", {}, `Tippe auf ein Beet, um ${crop?.name ?? "die Kultur"} zu setzen`),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => setPlacing(null) }, "Abbrechen"));
    } else {
      hint.hidden = true;
    }
  }

  function renderEmpty() {
    empty.replaceChildren(h("div", {},
      h("h2", {}, "Noch keine Beete"),
      h("p", { class: "muted", style: { margin: 0 } },
        "Lege dein erstes Beet an und ziehe es an die richtige Stelle. Größe und Lage stellst du direkt auf der Karte ein."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn btn-primary", onclick: () => addBed("bed") }, "Beet anlegen"),
        h("button", {
          type: "button", class: "btn", onclick: async () => {
            try { replaceAll(await api.post("/api/demo")); fit(); render(); toast("Beispielgarten geladen"); }
            catch (e) { toast(e.message, { error: true }); }
          },
        }, "Beispielgarten laden"))));
  }

  function bedTransform(b) {
    return `translate(${b.x * U} ${b.y * U}) rotate(${b.rotation || 0} ${(b.length * U) / 2} ${(b.width * U) / 2})`;
  }

  function bedFill(kind) {
    return {
      bed: { fill: "url(#soil)", stroke: "#6b4f3a" },
      raised: { fill: "url(#soil)", stroke: "#7a5a3c" },
      greenhouse: { fill: "url(#glass)", stroke: "#5c7a86" },
      path: { fill: "url(#gravel)", stroke: "#b9b3a6" },
      other: { fill: "#cfc6b4", stroke: "#8f8470" },
    }[kind] || { fill: "url(#soil)", stroke: "#6b4f3a" };
  }

  function drawBed(bed, k, overLayer) {
    const L = bed.length * U, Wd = bed.width * U;
    const selBed = state.sel?.type === "bed" && state.sel.id === bed.id;
    const g = s("g", { class: "bed", "data-bed": bed.id, transform: bedTransform(bed) });
    const st = bedFill(bed.kind);
    const sw = bed.kind === "raised" ? 4 : bed.kind === "greenhouse" ? 2.5 : 1.5;
    g.append(s("rect", { class: "bed-body", x: 0, y: 0, width: L, height: Wd, fill: st.fill, stroke: st.stroke,
      "stroke-width": sw, "vector-effect": "non-scaling-stroke", rx: bed.kind === "raised" ? 3 * k : 0 }));
    if (bed.kind === "greenhouse") {
      g.append(s("rect", { x: 0, y: 0, width: L, height: Wd, fill: "none", stroke: "#5c7a86",
        "stroke-width": 1, "stroke-dasharray": "2 4", "vector-effect": "non-scaling-stroke",
        transform: `translate(${4 * k} ${4 * k}) scale(${(L - 8 * k) / L} ${(Wd - 8 * k) / Wd})` }));
    }

    if (PLANTABLE.has(bed.kind)) {
      const clipId = `clip-bed-${bed.id}`;
      g.append(s("clipPath", { id: clipId }, s("rect", { x: 0, y: 0, width: L, height: Wd })));
      const pg = s("g", { "clip-path": `url(#${clipId})` });
      const mine = state.plantings.filter((p) => p.bed_id === bed.id);
      const upcoming = mine.filter((p) => {
        const ph = phases(p);
        return ph.fieldStart > state.day && ph.fieldStart <= state.day + UPCOMING_DAYS;
      });
      const active = mine.filter((p) => onBedAt(p, state.day));
      for (const p of upcoming) pg.append(drawPlanting(p, bed, k, "upcoming"));
      for (const p of active) pg.append(drawPlanting(p, bed, k, "active"));
      g.append(pg);
      // Warnzeichen und Griffe liegen außerhalb der Beschneidung
      for (const p of active) {
        const flags = drawFlags(p, bed, k);
        if (flags) g.append(flags);
      }
      const selP = state.sel?.type === "planting" ? mine.find((p) => p.id === state.sel.id) : null;
      if (selP && (onBedAt(selP, state.day) || upcoming.includes(selP))) g.append(plantingHandles(selP, bed, k));
    }

    // Beschriftung
    const flip = ((bed.rotation % 360) + 360) % 360 > 90 && ((bed.rotation % 360) + 360) % 360 <= 270;
    const fs = Math.min(12.5 * k, 40);
    const showSize = 12.5 * k <= 40;
    if (bed.kind === "path") {
      if (L / k > 60) {
        g.append(s("text", { class: "bed-name", x: L / 2, y: Wd / 2 + fs * 0.35, "text-anchor": "middle",
          style: `font-size:${fs}px; fill: var(--ink-3)`, transform: flip ? `rotate(180 ${L / 2} ${Wd / 2})` : null }, bed.name));
      }
    } else {
      const gap = Math.min(5 * k, 12);
      const label = s("text", { class: "bed-name", x: 0, y: -gap, style: `font-size:${fs}px`,
        transform: flip ? `rotate(180 ${L / 2} ${Wd / 2}) translate(0 ${Wd + gap + fs})` : null },
        bed.name,
        showSize ? s("tspan", { class: "bed-size", dx: 6 * k, style: `font-size:${fs * 0.85}px` }, `${fmtNum(bed.length)} × ${fmtNum(bed.width)} m`) : null);
      g.append(label);
    }

    if (selBed) {
      g.append(s("rect", { x: -3 * k, y: -3 * k, width: L + 6 * k, height: Wd + 6 * k, fill: "none",
        stroke: "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "5 4", "vector-effect": "non-scaling-stroke" }));
      g.append(s("line", { x1: L / 2, y1: 0, x2: L / 2, y2: -30 * k, stroke: "var(--ink)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      g.append(handle("bed-rot", L / 2, -30 * k, k, "circle"));
      g.append(handle("bed-r", L, Wd / 2, k));
      g.append(handle("bed-b", L / 2, Wd, k));
      g.append(handle("bed-br", L, Wd, k));
    }
    return g;
  }

  function handle(kind, x, y, k, shape = "square") {
    const r = 6 * k;
    const vis = shape === "circle"
      ? s("circle", { class: "handle", cx: x, cy: y, r })
      : s("rect", { class: "handle", x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 1.5 * k });
    return s("g", { class: "handle-group", "data-handle": kind },
      s("circle", { class: "handle-hit", cx: x, cy: y, r: 18 * k }), vis);
  }

  function drawPlanting(p, bed, k, mode) {
    const crop = find.crop(p.crop_id);
    const color = crop?.color || "#6a9b3c";
    const r = rectOf(p, bed);
    const x = r.x * U, y = r.y * U, w = r.w * U, hh = r.h * U;
    const g = s("g", { class: "planting", "data-pid": p.id });
    const issues = issuesOf(p.id);
    const conflict = issues.some((i) => i.kind === "conflict");
    const selected = state.sel?.type === "planting" && state.sel.id === p.id;

    if (mode === "upcoming") {
      g.append(s("rect", { x, y, width: w, height: hh, fill: "url(#hatch)", stroke: color, "stroke-width": 2,
        "stroke-dasharray": "6 5", "vector-effect": "non-scaling-stroke" }));
    } else {
      g.append(s("rect", { x, y, width: w, height: hh, fill: mix(color, "#ffffff", 0.58), stroke: mix(color, "#1d2b24", 0.2),
        "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      g.append(drawPlants(p, crop, bed, x, y, w, hh, color));
    }
    if (conflict) {
      g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--alert)", "stroke-width": 3, "vector-effect": "non-scaling-stroke" }));
    }
    if (selected) {
      g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "vector-effect": "non-scaling-stroke" }));
    }

    // Beschriftung, nur wenn sie lesbar Platz hat
    const screenH = hh / k;
    const screenW = w / k;
    if (screenH >= 13 && screenW >= 26) {
      const fs = Math.min(13 * k, hh * 0.42);
      const pad = 4 * k;
      const name = crop?.name ?? "Kultur";
      const maxChars = Math.max(2, Math.floor((w - 2 * pad) / (fs * 0.47)));
      const clip = (t) => (t.length > maxChars ? t.slice(0, Math.max(1, maxChars - 1)) + "…" : t);
      const sub = mode === "upcoming" ? `ab ${fmtDay(phases(p).fieldStart)}` : p.variety;
      const twoLines = sub && screenH >= 32;
      const t = s("text", { class: "pl-label", x: x + pad, y: y + pad + fs * 0.85,
        style: `font-size:${fs}px; stroke-width:${3.5 * k}px` }, clip(name));
      if (sub) {
        if (twoLines) t.append(s("tspan", { class: "pl-sub", x: x + pad, dy: fs * 1.08, style: `font-size:${fs * 0.88}px` }, clip(sub)));
        else if (name.length + sub.length + 1 <= maxChars) t.append(s("tspan", { class: "pl-sub", dx: fs * 0.3, style: `font-size:${fs * 0.88}px` }, sub));
      }
      g.append(t);
    }
    return g;
  }

  function drawPlants(p, crop, bed, x, y, w, hh, color) {
    const g = s("g", { "pointer-events": "none" });
    const sp = spacing(p, crop);
    const rows = rowCount(p, crop, bed);
    const perRow = Math.max(1, Math.floor((p.len * 100 + 0.5) / sp.plant));
    const dark = mix(color, "#1d2b24", 0.1);
    if (rows * perRow > 900) {
      for (let i = 0; i < rows; i++) {
        const ry = y + (hh * (i + 0.5)) / rows;
        g.append(s("line", { x1: x + 4, x2: x + w - 4, y1: ry, y2: ry, stroke: dark,
          "stroke-width": Math.min(sp.row * 0.4, 10), "stroke-linecap": "round", opacity: 0.8 }));
      }
      return g;
    }
    const rad = clamp(Math.min(sp.row, sp.plant) * 0.36, 1.2, 55);
    for (let i = 0; i < rows; i++) {
      const cy = y + (hh * (i + 0.5)) / rows;
      for (let j = 0; j < perRow; j++) {
        const cx = x + (w * (j + 0.5)) / perRow;
        g.append(s("circle", { cx, cy, r: rad, fill: dark, opacity: 0.85 }));
      }
    }
    return g;
  }

  function drawFlags(p, bed, k) {
    const issues = issuesOf(p.id);
    if (!issues.length) return null;
    const kind = issues.some((i) => i.kind === "conflict") ? "conflict" : "rotation";
    const r = rectOf(p, bed);
    const cx = (r.x + r.w) * U - 9 * k, cy = r.y * U + 9 * k;
    const g = s("g", { "pointer-events": "none" });
    g.append(s("circle", { cx, cy, r: 7.5 * k, fill: kind === "conflict" ? "var(--alert)" : "var(--warn)", stroke: "#fff", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
    g.append(s("text", { x: cx, y: cy + 3.6 * k, "text-anchor": "middle", fill: "#fff", style: `font: 700 ${10.5 * k}px var(--font)` }, "!"));
    return g;
  }

  function plantingHandles(p, bed, k) {
    const r = rectOf(p, bed);
    const x = r.x * U, y = r.y * U, w = r.w * U, hh = r.h * U;
    return s("g", { "data-pid": p.id },
      handle("pl-l", x, y + hh / 2, k), handle("pl-r", x + w, y + hh / 2, k),
      handle("pl-t", x + w / 2, y, k), handle("pl-b", x + w / 2, y + hh, k));
  }

  // ------------------------------------------------------------ Gesten

  const pointers = new Map();
  let gesture = null;
  let lastTap = { time: 0, key: null };

  function toWorld(e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function toLocal(e, inv) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(inv);
  }

  function bedGroup(id) { return svg.querySelector(`.bed[data-bed="${id}"]`); }

  // Weltposition der Beet-Ecke links oben, unabhängig von der Drehung um die Mitte
  function cornerWorld(b) {
    const t = ((b.rotation || 0) * Math.PI) / 180;
    const cx = b.length / 2, cy = b.width / 2;
    return { x: b.x + cx - (Math.cos(t) * cx - Math.sin(t) * cy), y: b.y + cy - (Math.sin(t) * cx + Math.cos(t) * cy) };
  }

  function placeForCorner(b, corner) {
    const t = ((b.rotation || 0) * Math.PI) / 180;
    const cx = b.length / 2, cy = b.width / 2;
    return { x: corner.x - cx + (Math.cos(t) * cx - Math.sin(t) * cy), y: corner.y - cy + (Math.sin(t) * cx + Math.cos(t) * cy) };
  }

  function onDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    svg.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      cancelGesture();
      const [a, b] = [...pointers.values()];
      const rect = svg.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      gesture = { type: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), view0: { ...view },
        w0: { x: view.x + (mid.x / size.w) * view.w, y: view.y + (mid.y / size.h) * view.h } };
      return;
    }
    if (pointers.size > 2) return;

    const handleEl = e.target.closest("[data-handle]");
    const plEl = e.target.closest("[data-pid]");
    const bedEl = e.target.closest("[data-bed]");
    const base = { x0: e.clientX, y0: e.clientY, moved: false, pointerType: e.pointerType };

    if (state.placing && bedEl) {
      gesture = { ...base, type: "place", bedId: Number(bedEl.dataset.bed), inv: bedEl.getScreenCTM().inverse() };
      return;
    }
    if (handleEl && bedEl) {
      const kind = handleEl.dataset.handle;
      const bed = find.bed(Number(bedEl.dataset.bed));
      const inv = bedEl.getScreenCTM().inverse();
      if (kind.startsWith("bed-")) {
        gesture = { ...base, type: "bed-handle", kind, id: bed.id, inv, orig: pick(bed, ["x", "y", "length", "width", "rotation"]),
          corner: cornerWorld(bed) };
      } else {
        const p = find.planting(Number(plEl.dataset.pid));
        gesture = { ...base, type: "pl-handle", kind, id: p.id, bedId: bed.id, inv,
          orig: { start: p.start, len: p.len, offset: p.offset, span: p.span }, span0: spanOf(p, bed) };
      }
      return;
    }
    if (plEl && bedEl) {
      const p = find.planting(Number(plEl.dataset.pid));
      const bed = find.bed(Number(bedEl.dataset.bed));
      if (!(state.sel?.type === "planting" && state.sel.id === p.id)) select({ type: "planting", id: p.id });
      const inv = bedEl.getScreenCTM().inverse();
      gesture = { ...base, type: "move-pl", id: p.id, bedId: bed.id, inv, l0: toLocal(e, inv),
        orig: { start: p.start, offset: p.offset, span: p.span }, span0: spanOf(p, bed) };
      return;
    }
    if (bedEl) {
      const bed = find.bed(Number(bedEl.dataset.bed));
      if (!(state.sel?.type === "bed" && state.sel.id === bed.id)) select({ type: "bed", id: bed.id });
      gesture = { ...base, type: "move-bed", id: bed.id, w0: toWorld(e), orig: { x: bed.x, y: bed.y } };
      return;
    }
    gesture = { ...base, type: "pan", view0: { ...view } };
    svg.classList.add("panning");
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.type === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const rect = svg.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const { W, H } = gardenSize();
      const nw = clamp(gesture.view0.w * (gesture.d0 / d), 120, Math.max(W, H) * U * 4);
      const nh = nw * (size.h / size.w);
      const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      view = { w: nw, h: nh, x: gesture.w0.x - (mid.x / size.w) * nw, y: gesture.w0.y - (mid.y / size.h) * nh };
      schedule("svg");
      return;
    }

    const dxPx = e.clientX - gesture.x0, dyPx = e.clientY - gesture.y0;
    if (!gesture.moved) {
      const threshold = gesture.pointerType === "touch" ? 8 : 4;
      if (Math.hypot(dxPx, dyPx) < threshold) return;
      gesture.moved = true;
    }

    switch (gesture.type) {
      case "pan": {
        const k = upp();
        view = { ...gesture.view0, x: gesture.view0.x - dxPx * k, y: gesture.view0.y - dyPx * k };
        applyView();
        break;
      }
      case "move-bed": {
        const bed = find.bed(gesture.id);
        const w = toWorld(e);
        bed.x = round2(snap(gesture.orig.x + (w.x - gesture.w0.x) / U, 0.1));
        bed.y = round2(snap(gesture.orig.y + (w.y - gesture.w0.y) / U, 0.1));
        bedGroup(bed.id)?.setAttribute("transform", bedTransform(bed));
        break;
      }
      case "bed-handle": {
        const bed = find.bed(gesture.id);
        if (gesture.kind === "bed-rot") {
          const c = { x: (gesture.orig.x + gesture.orig.length / 2) * U, y: (gesture.orig.y + gesture.orig.width / 2) * U };
          const w = toWorld(e);
          let ang = (Math.atan2(w.y - c.y, w.x - c.x) * 180) / Math.PI + 90;
          ang = ((snap(ang, e.shiftKey ? 1 : 15) % 360) + 360) % 360;
          bed.rotation = ang;
          bedGroup(bed.id)?.setAttribute("transform", bedTransform(bed));
        } else {
          const l = toLocal(e, gesture.inv);
          if (gesture.kind !== "bed-b") bed.length = Math.max(0.3, round2(snap(l.x / U, 0.1)));
          if (gesture.kind !== "bed-r") bed.width = Math.max(0.2, round2(snap(l.y / U, 0.1)));
          const pos = placeForCorner(bed, gesture.corner);
          bed.x = round2(pos.x);
          bed.y = round2(pos.y);
          schedule("svg");
        }
        break;
      }
      case "move-pl": {
        const p = find.planting(gesture.id);
        const bed = find.bed(gesture.bedId);
        const l = toLocal(e, gesture.inv);
        const len = p.len;
        p.start = round2(clamp(snap(gesture.orig.start + (l.x - gesture.l0.x) / U, 0.1), 0, Math.max(0, bed.length - len)));
        const sp = Math.min(gesture.span0, bed.width);
        const newOffset = round2(clamp(snap((gesture.orig.offset || 0) + (l.y - gesture.l0.y) / U, 0.1), 0, Math.max(0, bed.width - sp)));
        if (newOffset !== (gesture.orig.offset || 0) || p.span != null) {
          p.offset = newOffset;
          p.span = round2(sp);
        }
        schedule("svg");
        break;
      }
      case "pl-handle": {
        const p = find.planting(gesture.id);
        const bed = find.bed(gesture.bedId);
        const l = toLocal(e, gesture.inv);
        const lx = round2(snap(l.x / U, 0.1)), ly = round2(snap(l.y / U, 0.1));
        const { start, len, offset } = gesture.orig;
        const span = gesture.span0;
        if (gesture.kind === "pl-r") p.len = round2(clamp(lx, start + 0.1, bed.length) - start);
        if (gesture.kind === "pl-l") {
          const ns = clamp(lx, 0, start + len - 0.1);
          p.start = round2(ns); p.len = round2(start + len - ns);
        }
        if (gesture.kind === "pl-b") { p.span = round2(clamp(ly, offset + 0.1, bed.width) - offset); }
        if (gesture.kind === "pl-t") {
          const nt = clamp(ly, 0, offset + span - 0.1);
          p.offset = round2(nt); p.span = round2(offset + span - nt);
        }
        schedule("svg");
        break;
      }
      default:
        break;
    }
  }

  async function onUp(e) {
    pointers.delete(e.pointerId);
    svg.classList.remove("panning");
    const g = gesture;
    if (!g) return;
    if (g.type === "pinch") {
      if (pointers.size === 0) gesture = null;
      return;
    }
    gesture = null;
    if (e.type === "pointercancel") { revert(g); return; }

    if (!g.moved) {
      if (g.type === "place") {
        const bed = find.bed(g.bedId);
        const l = toLocal(e, g.inv);
        const cropId = state.placing;
        setPlacing(null);
        await placeCrop(cropId, bed, { x: l.x / U, y: l.y / U });
        return;
      }
      if (g.type === "pan") {
        if (state.placing) setPlacing(null);
        else if (state.sel) select(null);
        return;
      }
      const key = `${g.type}:${g.id}`;
      const now = performance.now();
      if (lastTap.key === key && now - lastTap.time < 380) {
        lastTap = { time: 0, key: null };
        openEditorFor(g);
      } else {
        lastTap = { time: now, key };
      }
      return;
    }

    switch (g.type) {
      case "move-bed": {
        const bed = find.bed(g.id);
        await commit("beds", bed, g.orig, ["x", "y"], `${bed.name} verschoben`);
        break;
      }
      case "bed-handle": {
        const bed = find.bed(g.id);
        await commit("beds", bed, g.orig, ["x", "y", "length", "width", "rotation"],
          g.kind === "bed-rot" ? `${bed.name} gedreht` : `Größe von ${bed.name} geändert`);
        break;
      }
      case "move-pl":
      case "pl-handle": {
        const p = find.planting(g.id);
        const crop = find.crop(p.crop_id);
        await commit("plantings", p, g.orig, ["start", "len", "offset", "span"],
          g.type === "move-pl" ? `${crop?.name ?? "Satz"} verschoben` : `${crop?.name ?? "Satz"} angepasst`);
        break;
      }
      default:
        break;
    }
  }

  function openEditorFor(g) {
    if (g.type === "move-pl") openPlantingEditor(find.planting(g.id));
    else if (g.type === "move-bed") openBedEditor(find.bed(g.id));
  }

  // Entwurf zurücksetzen und als eine Änderung speichern (dann klappt auch Rückgängig)
  async function commit(kind, item, orig, keys, label) {
    const changes = {};
    for (const k of keys) if (item[k] !== orig[k] && k in orig) changes[k] = item[k];
    for (const k of Object.keys(orig)) item[k] = orig[k];
    if (!Object.keys(changes).length) { schedule("svg"); return; }
    try { await patch(kind, item.id, changes, { undoLabel: label }); } catch { /* Meldung kam schon */ }
  }

  function revert(g) {
    if (!g?.orig) return;
    const item = g.type.includes("bed") ? find.bed(g.id) : find.planting(g.id);
    if (item) Object.assign(item, g.orig);
    schedule("svg");
  }

  function cancelGesture() {
    if (gesture && gesture.type !== "pinch") revert(gesture);
    gesture = null;
  }

  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAround(e.clientX - rect.left, e.clientY - rect.top, Math.exp(clamp(delta, -120, 120) * 0.0022));
  }, { passive: false });

  // Tastatur: Pfeile verschieben um 10 cm, Entf löscht, Eingabe öffnet den Dialog
  async function onKey(e) {
    if (document.querySelector("dialog[open]")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const sel = state.sel;
    if (!sel) return;
    const item = sel.type === "bed" ? find.bed(sel.id) : find.planting(sel.id);
    if (!item) return;
    const d = e.shiftKey ? 1 : 0.1;
    const moves = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
    if (moves[e.key] && e.target === svg) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      if (sel.type === "bed") {
        await patch("beds", item.id, { x: round2(item.x + dx), y: round2(item.y + dy) });
      } else {
        const bed = find.bed(item.bed_id);
        if (!bed) return;
        const sp = spanOf(item, bed);
        const changes = { start: round2(clamp(item.start + dx, 0, bed.length - item.len)) };
        if (dy) Object.assign(changes, { offset: round2(clamp((item.offset || 0) + dy, 0, bed.width - sp)), span: round2(sp) });
        await patch("plantings", item.id, changes);
      }
    } else if ((e.key === "Delete" || e.key === "Backspace") && e.target === svg) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "Enter" && e.target === svg) {
      e.preventDefault();
      if (sel.type === "bed") openBedEditor(item); else openPlantingEditor(item);
    }
  }
  document.addEventListener("keydown", onKey);

  async function deleteSelected() {
    const sel = state.sel;
    if (!sel) return;
    if (sel.type === "planting") {
      const p = find.planting(sel.id);
      await remove("plantings", p.id, { undoLabel: `${find.crop(p.crop_id)?.name ?? "Satz"} gelöscht` });
    } else {
      const b = find.bed(sel.id);
      const count = state.plantings.filter((p) => p.bed_id === b.id).length;
      const ok = await confirmDialog(count
        ? `${b.name} wird gelöscht. Die ${count} Sätze darin bleiben erhalten und stehen danach unter „Ohne Beet“.`
        : `${b.name} wird gelöscht.`, { title: "Beet löschen?" });
      if (ok) await remove("beds", b.id, { undoLabel: `${b.name} gelöscht` });
    }
  }

  function addBed(kind) {
    const c = view ? { x: (view.x + view.w / 2) / U, y: (view.y + view.h / 2) / U } : { x: 4, y: 3 };
    createBedAt(kind, c.x, c.y);
  }

  // ------------------------------------------------------------ Seitenleiste

  function renderPanel() {
    const sel = state.sel;
    const parts = [];
    if (sel?.type === "planting" && find.planting(sel.id)) parts.push(...plantingPanel(find.planting(sel.id)));
    else if (sel?.type === "bed" && find.bed(sel.id)) parts.push(...bedPanel(find.bed(sel.id)));
    else parts.push(...overviewPanel());
    const scrollTop = panel.scrollTop;
    const focusedSearch = document.activeElement?.classList?.contains("crop-search");
    panel.replaceChildren(...parts);
    panel.scrollTop = scrollTop;
    if (focusedSearch) {
      const inp = panel.querySelector(".crop-search");
      inp?.focus();
      inp?.setSelectionRange(inp.value.length, inp.value.length);
    }
  }

  function section(...children) { return h("section", { class: "panel-section" }, ...children); }

  function overviewPanel() {
    const day = state.day;
    const onBeds = state.plantings.filter((p) => p.bed_id != null && onBedAt(p, day));
    const nursery = state.plantings.filter((p) => {
      const ph = phases(p);
      return p.method === "transplant" && ph.sow <= day && day < ph.plant;
    });
    const soon = state.plantings.filter((p) => {
      const ph = phases(p);
      return ph.sow > day && ph.sow <= day + 14;
    }).sort((a, b) => phases(a).sow - phases(b).sow);
    const occ = occupancy(day);

    const list = (items, when) => h("ul", { class: "legend-list" }, items.map((p) => {
      const c = find.crop(p.crop_id);
      return h("li", {}, h("button", { type: "button", onclick: () => select({ type: "planting", id: p.id }) },
        h("span", { class: "dot", style: { background: c?.color } }),
        h("span", { class: "name" }, c?.name ?? "Kultur", p.variety ? h("span", { class: "muted" }, ` ${p.variety}`) : null),
        h("span", { class: "when" }, when(p))));
    }));

    const out = [section(
      h("div", { class: "panel-title" }, h("h2", {}, state.settings.garden_name || "Garten")),
      h("p", { class: "status-line", style: { margin: 0 } },
        state.beds.length
          ? `${onBeds.length} ${onBeds.length === 1 ? "Satz steht" : "Sätze stehen"} am Stichtag im Beet, ${Math.round(occ * 100)} % der Anbaufläche sind belegt.`
          : "Lege zuerst Beete an."),
    )];
    if (nursery.length) {
      out.push(section(h("h3", {}, "In Anzucht"),
        h("p", { class: "muted small", style: { margin: 0 } }, "Diese Jungpflanzen stehen noch nicht im Beet und erscheinen nicht auf der Karte."),
        list(nursery, (p) => `pflanzen ${fmtDay(phases(p).plant)}`)));
    }
    if (soon.length) out.push(section(h("h3", {}, "Aussaat in den nächsten 14 Tagen"), list(soon, (p) => fmtDay(phases(p).sow))));
    out.push(cropSection(null));
    out.push(section(h("h3", {}, "Fläche anlegen"),
      h("div", { class: "actions" }, Object.entries(KIND_LABEL).map(([k, label]) =>
        h("button", { type: "button", class: "btn btn-sm", onclick: () => addBed(k) }, label)))));
    return out;
  }

  function cropSection(bed) {
    const plantable = bed && PLANTABLE.has(bed.kind);
    const q = cropQuery.trim().toLowerCase();
    const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.family || "").toLowerCase().includes(q));
    const chips = h("div", { class: "chips" }, crops.map((c) => cropChip(c, plantable ? bed : null)));
    const search = h("input", { class: "input crop-search", type: "search", placeholder: "Kultur suchen", value: cropQuery,
      "aria-label": "Kultur suchen",
      oninput: (e) => { cropQuery = e.target.value; schedule("panel"); } });
    return section(
      h("h3", {}, plantable ? `Kultur in ${bed.name} setzen` : "Kulturen"),
      h("p", { class: "muted small", style: { margin: 0 } }, plantable
        ? "Antippen setzt die Kultur an die erste freie Stelle. Ziehen setzt sie genau dorthin, wo du loslässt."
        : "Ziehe eine Kultur auf ein Beet, oder tippe sie an und danach auf das Beet. Termine richten sich nach dem Stichtag."),
      search, chips);
  }

  function cropChip(crop, bed) {
    const chip = h("button", { type: "button", class: "chip", "aria-pressed": state.placing === crop.id ? "true" : "false",
      title: crop.family || null },
      h("span", { class: "dot", style: { background: crop.color } }), crop.name);
    let start = null;
    let ghost = null;
    chip.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      start = { x: e.clientX, y: e.clientY };
      chip.setPointerCapture(e.pointerId);
    });
    chip.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
        ghost = h("div", { class: "drag-ghost", style: { background: crop.color, color: textColor(crop.color) } }, crop.name);
        document.body.append(ghost);
      }
      if (ghost) { ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`; }
    });
    const finish = async (e) => {
      if (!start) return;
      start = null;
      if (ghost) {
        ghost.remove();
        ghost = null;
        if (e.type === "pointercancel") return;
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const bedEl = hit?.closest?.(".map-svg [data-bed]");
        if (!bedEl) { toast("Zum Setzen auf ein Beet ziehen"); return; }
        const target = find.bed(Number(bedEl.dataset.bed));
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const l = pt.matrixTransform(bedEl.getScreenCTM().inverse());
        await placeCrop(crop.id, target, { x: l.x / U, y: l.y / U });
        return;
      }
      if (e.type === "pointercancel") return;
      if (bed) await placeCrop(crop.id, bed);
      else setPlacing(state.placing === crop.id ? null : crop.id);
    };
    chip.addEventListener("pointerup", finish);
    chip.addEventListener("pointercancel", finish);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (bed) placeCrop(crop.id, bed); else setPlacing(state.placing === crop.id ? null : crop.id);
      }
    });
    return chip;
  }

  function bedPanel(bed) {
    const year = yearOf(state.day);
    const ys = yearStart(year), ye = ys + yearLength(year) - 1;
    const mine = state.plantings.filter((p) => p.bed_id === bed.id);
    const thisYear = mine.filter((p) => { const ph = phases(p); return ph.sow <= ye && ph.he >= ys; })
      .sort((a, b) => phases(a).fieldStart - phases(b).fieldStart);
    const plantable = PLANTABLE.has(bed.kind);
    const out = [section(
      h("div", { class: "panel-title" }, h("h2", {}, bed.name),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openBedEditor(bed) }, icon("edit"), "Bearbeiten")),
      h("p", { class: "muted", style: { margin: 0 } },
        `${KIND_LABEL[bed.kind]}, ${fmtNum(bed.length)} × ${fmtNum(bed.width)} m (${fmtNum(bed.length * bed.width)} m²)`),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => patch("beds", bed.id, { rotation: ((bed.rotation || 0) + 90) % 360 }, { undoLabel: `${bed.name} gedreht` }) }, icon("rotate"), "90° drehen"),
        h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: deleteSelected }, icon("trash"), "Löschen")),
    )];
    if (plantable) {
      out.push(section(h("h3", {}, `Belegung ${year}`),
        thisYear.length
          ? h("div", { class: "bed-timeline" }, thisYear.map((p) => {
            const c = find.crop(p.crop_id);
            return h("div", { class: "row" },
              h("button", { type: "button", onclick: () => select({ type: "planting", id: p.id }), title: `${c?.name} ${p.variety}` },
                c?.name ?? "Kultur", p.variety ? h("span", { class: "muted" }, ` ${p.variety}`) : null),
              miniTimeline(p, year));
          }))
          : h("p", { class: "muted small", style: { margin: 0 } }, "Noch nichts geplant.")));
      out.push(section(h("h3", {}, "Fruchtfolge"), rotationHistory(bed, year)));
      out.push(cropSection(bed));
    }
    return out;
  }

  function rotationHistory(bed, year) {
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

  function miniTimeline(p, year) {
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

  function plantingPanel(p) {
    const crop = find.crop(p.crop_id);
    const bed = find.bed(p.bed_id);
    const ph = phases(p);
    const day = state.day;
    const issues = issuesOf(p.id);
    const sp = spacing(p, crop);
    let status;
    if (day < ph.sow) status = `Aussaat in ${ph.sow - day} Tagen`;
    else if (ph.plant != null && day < ph.plant) status = `In Anzucht, Pflanzung in ${ph.plant - day} Tagen`;
    else if (day < ph.hs) status = `Wächst, Ernte ab ${fmtDay(ph.hs)}`;
    else if (day <= ph.he) status = `Ernte läuft bis ${fmtDay(ph.he, { year: yearOf(ph.he) !== yearOf(day) })}`;
    else status = `Abgeräumt seit ${fmtDay(ph.he)}`;
    const visible = onBedAt(p, day) || (ph.fieldStart > day && ph.fieldStart <= day + UPCOMING_DAYS);
    const year = yearOf(day);

    const kv = h("dl", { class: "kv", style: { margin: 0 } },
      h("dt", {}, "Beet"), h("dd", {}, bed ? bed.name : "Ohne Beet"),
      h("dt", {}, "Fläche"), h("dd", {}, `${fmtNum(p.len)} × ${fmtNum(spanOf(p, bed))} m, ab ${fmtNum(p.start)} m`),
      h("dt", {}, "Pflanzen"), h("dd", {}, `${plantCount(p, crop, bed)} in ${plural(rowCount(p, crop, bed), "Reihe", "Reihen")}`),
      h("dt", {}, "Abstände"), h("dd", {}, `${sp.row} × ${sp.plant} cm`),
      h("dt", {}, "Aussaat"), h("dd", {}, fmtDay(ph.sow, { year: true })),
      ph.plant != null ? h("dt", {}, "Pflanzung") : null, ph.plant != null ? h("dd", {}, fmtDay(ph.plant, { year: true })) : null,
      h("dt", {}, "Ernte"), h("dd", {}, `${fmtDay(ph.hs)} bis ${fmtDay(ph.he, { year: true })}`),
    );

    const out = [section(
      h("div", { class: "panel-title" },
        h("h2", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("span", { class: "dot", style: { background: crop?.color, width: "14px", height: "14px" } }), crop?.name ?? "Kultur"),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openPlantingEditor(p) }, icon("edit"), "Bearbeiten")),
      p.variety ? h("p", { class: "muted", style: { margin: "-6px 0 0" } }, p.variety) : null,
      h("p", { class: "status-line", style: { margin: 0 } }, status),
      miniTimeline(p, year),
      !visible && bed ? h("div", {},
        h("button", { type: "button", class: "btn btn-sm", onclick: () => setDay(ph.fieldStart) },
          `Zum ${ph.plant != null ? "Pflanztag" : "Saattag"} springen (${fmtDay(ph.fieldStart)})`)) : null,
      issues.length ? h("ul", { class: "issues" }, issues.map((i) => h("li", { class: i.kind }, i.text))) : null,
      kv,
      p.notes ? h("p", { class: "small", style: { margin: 0, whiteSpace: "pre-wrap" } }, p.notes) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => createSuccession(p, 14), title: "Gleiche Kultur 14 Tage später" }, icon("copy"), "Folgesatz"),
        bed ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => select({ type: "bed", id: bed.id }) }, `${bed.name} zeigen`) : null,
        h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: deleteSelected }, icon("trash"), "Löschen")),
    )];
    return out;
  }

  // ------------------------------------------------------------ Zeitregler mit Flächenauslastung

  function plantableArea() {
    return state.beds.filter((b) => PLANTABLE.has(b.kind)).reduce((sum, b) => sum + b.length * b.width, 0);
  }

  function occupancy(day) {
    const total = plantableArea();
    if (!total) return 0;
    let used = 0;
    for (const p of state.plantings) {
      if (p.bed_id == null || !onBedAt(p, day)) continue;
      const b = find.bed(p.bed_id);
      if (b && PLANTABLE.has(b.kind)) used += p.len * spanOf(p, b);
    }
    return Math.min(1, used / total);
  }

  function buildScrubber() {
    const headDay = h("strong", {});
    const headOcc = h("span", {});
    const svgEl = s("svg", { preserveAspectRatio: "none" });
    const thumb = h("div", { class: "scrubber-thumb" });
    const track = h("div", { class: "scrubber-track", role: "slider", tabindex: "0", "aria-label": "Stichtag im Jahr verschieben" }, svgEl, thumb);
    const months = h("div", { class: "scrubber-months", "aria-hidden": "true" });
    const elx = h("div", { class: "scrubber" },
      h("div", { class: "scrubber-head" }, h("span", {}, "Stichtag ", headDay), headOcc),
      track, months);
    let areaYear = null;

    function dayFromX(clientX) {
      const r = track.getBoundingClientRect();
      const year = yearOf(state.day);
      const f = clamp((clientX - r.left) / r.width, 0, 0.99999);
      return yearStart(year) + Math.floor(f * yearLength(year));
    }
    let dragging = false;
    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      setDay(dayFromX(e.clientX));
    });
    track.addEventListener("pointermove", (e) => { if (dragging) setDay(dayFromX(e.clientX)); });
    track.addEventListener("pointerup", () => { dragging = false; });
    track.addEventListener("pointercancel", () => { dragging = false; });
    track.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -7, ArrowUp: 7 }[e.key];
      if (d) { e.preventDefault(); setDay(state.day + d); }
    });

    function renderAll(areaToo) {
      const year = yearOf(state.day);
      const ys = yearStart(year), len = yearLength(year);
      if (areaToo || areaYear !== year) {
        areaYear = year;
        svgEl.setAttribute("viewBox", `0 0 ${len} 100`);
        let d = `M0 100`;
        for (let i = 0; i < len; i += 2) d += ` L${i} ${100 - occupancy(ys + i) * 92}`;
        d += ` L${len} ${100 - occupancy(ys + len - 1) * 92} L${len} 100 Z`;
        const parts = [];
        for (let m = 1; m < 12; m++) {
          const x = Math.floor(Date.UTC(year, m, 1) / 86400000) - ys;
          parts.push(s("line", { class: "month-line", x1: x, x2: x, y1: 0, y2: 100 }));
        }
        svgEl.replaceChildren(...parts, s("path", { class: "area", d }));
        months.replaceChildren(...MONTHS_SHORT.map((m, i) => {
          const x = Math.floor(Date.UTC(year, i, 1) / 86400000) - ys;
          return h("span", { style: { left: `${(x / len) * 100}%` } }, m);
        }));
      }
      thumb.style.left = `${((state.day - ys + 0.5) / len) * 100}%`;
      headDay.textContent = fmtDay(state.day, { year: true });
      headOcc.textContent = state.beds.length ? `${Math.round(occupancy(state.day) * 100)} % der Anbaufläche belegt` : "";
      track.setAttribute("aria-valuetext", isoOf(state.day));
    }
    return { el: elx, render: renderAll };
  }

  // ------------------------------------------------------------ Lebenszyklus

  return {
    update(reason) {
      if (gesture && gesture.type !== "pan" && gesture.type !== "pinch" && reason === "data") return;
      if (reason === "day") schedule("svg", "panel", "scrub");
      else if (reason === "select") schedule("svg", "panel");
      else schedule("svg", "panel", "scrub", "area");
    },
    destroy() {
      ro.disconnect();
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    },
  };
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return o;
}

function textColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const L = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return L > 150 ? "#1d2b24" : "#ffffff";
}
