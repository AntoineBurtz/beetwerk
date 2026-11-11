// Beetkarte: Grundstück mit Beeten, darauf die Sätze, die am Stichtag im Beet stehen.
import { state, find, select, patch, remove, setDay, setMode, issuesOf, api, replaceAll } from "./store.js";
import {
  h, s, phases, onBedAt, rectOf, spanOf, rowCount, plantCount, plantLayout, spacing, mix, clamp, snap, round2,
  fmtDay, fmtNum, yearOf, yearStart, yearLength, MONTHS_SHORT, KIND_LABEL, PLANTABLE, isoOf, plural,
  isMixed, mixPlan, varietyColor, varietyMark, varietyText, textOn,
} from "./util.js";
import { mixLegend, downloadPlan } from "./mix.js";
import {
  openPlantingEditor, openBedEditor, createBedRect, placeCrop, followUp, goalSeries, assignPlanting, DEFAULT_BED_SIZE,
  uniformWidth, bedModeControl, saveBedMode,
} from "./editor.js";
import { iconBtn, icon, toast, confirmDialog, replaceKeepingFocus } from "./ui.js";
import { bedSummary, bedUsage, miniTimeline } from "./bedpanel.js";
import { cropLink, varietyLink, link, openGoalOverview } from "./overview.js";
import { openGeoSetup } from "./geosetup.js";
import { openBonitur } from "./bonitur.js";
import { openGoalEditor, blockGoalOf, moveBlock } from "./goals.js";
import { feedBlock, feedDueList } from "./feedui.js";

const U = 100; // SVG-Einheiten pro Meter, also Zentimeter
const PLAN_AHEAD = 400; // so viele Tage voraus zeigt die Karte, was als Nächstes auf einer freien Fläche geplant ist

let view = null; // { x, y, w, h } bleibt beim Wechsel der Ansicht erhalten
let cropQuery = "";
let showSat = readSat();

function readSat() {
  try { return localStorage.getItem("beetwerk.sat") !== "0"; } catch { return true; }
}

function writeSat(on) {
  try { localStorage.setItem("beetwerk.sat", on ? "1" : "0"); } catch { /* egal */ }
}

export function mountMap(root) {
  view = null; // beim Öffnen immer den ganzen Garten zentriert zeigen
  const svg = s("svg", { class: "map-svg", role: "application", "aria-label": "Beetkarte", tabindex: "0" });
  const satBtn = iconBtn("layers", "Luftbild ein- oder ausblenden", () => {
    showSat = !showSat;
    writeSat(showSat);
    schedule("svg");
  }, { hidden: true });
  const compass = h("div", { class: "compass", title: "Norden", hidden: true },
    s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" },
      s("path", { d: "M12 2l5 12-5-3-5 3z", fill: "currentColor" }),
      s("text", { x: 12, y: 23, "text-anchor": "middle", style: "font: 700 8px var(--font)", fill: "currentColor" }, "N")));
  // Schloss: gesperrte Beete lassen sich nicht verschieben, drehen oder in der Größe ändern – Ziehen bewegt den Ausschnitt
  const lockBtn = iconBtn("unlock", "Beete sperren", toggleLock, { class: "icon-btn lock-btn", "aria-pressed": "false" });
  const tools = h("div", { class: "map-tools" },
    iconBtn("plus", "Vergrößern", () => zoomAtCenter(0.75)),
    iconBtn("minus", "Verkleinern", () => zoomAtCenter(1.33)),
    iconBtn("fit", "Ganzen Garten zeigen", () => { fit(); render(); }),
    lockBtn, satBtn, compass);
  const hint = h("div", { class: "map-hint", hidden: true });
  const empty = h("div", { class: "map-empty", hidden: true });
  const attrib = h("div", { class: "map-attrib", hidden: true });
  const legend = h("div", { class: "map-legend", hidden: true, "aria-label": "Legende" });
  const fabMenu = h("div", { class: "fab-menu", role: "menu", hidden: true, "aria-label": "Neue Fläche" },
    Object.entries(KIND_LABEL).map(([k, label]) => h("button", {
      type: "button", role: "menuitem", class: `fab-item kind-${k}`,
      onclick: () => { closeFab(); setMode({ type: "bed", kind: k }); },
    }, h("span", { class: "swatch", "aria-hidden": "true" }), label)));
  const fab = h("button", { type: "button", class: "fab", "aria-label": "Neue Fläche anlegen", title: "Neue Fläche anlegen",
    "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => (fabMenu.hidden ? openFab() : closeFab()) }, icon("plus"));
  const orphanPill = h("button", { type: "button", class: "orphan-pill", hidden: true, onclick: showOrphans });
  const stage = h("div", { style: { position: "relative", minHeight: "0" } }, svg, tools, hint, empty, attrib, legend, orphanPill, fabMenu, fab);

  const locked = () => state.settings?.beds_locked === "1";

  async function toggleLock() {
    const on = !locked();
    try {
      state.settings = await api.patch("/api/settings", { beds_locked: on ? "1" : "0" });
    } catch { return; } // Meldung kam schon
    render();
    toast(on ? "Beete gesperrt: Ziehen verschiebt jetzt den Ausschnitt. Einen Satz erst antippen, dann ziehen."
      : "Beete entsperrt: Ziehen verschiebt sie wieder.");
  }

  function renderLock() {
    const on = locked();
    lockBtn.setAttribute("aria-pressed", String(on));
    const label = on ? "Beete sind gesperrt – zum Verschieben entsperren" : "Beete sperren, damit sie beim Verschieben des Ausschnitts liegen bleiben";
    lockBtn.title = label;
    lockBtn.setAttribute("aria-label", label);
    lockBtn.replaceChildren(icon(on ? "lock" : "unlock"));
    svg.classList.toggle("locked", on);
  }

  function openFab() {
    fabMenu.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    fabMenu.querySelector("button")?.focus();
  }
  function closeFab() {
    fabMenu.hidden = true;
    fab.setAttribute("aria-expanded", "false");
  }
  function onDocPointer(e) {
    if (!fabMenu.hidden && !fabMenu.contains(e.target) && !fab.contains(e.target)) closeFab();
  }
  document.addEventListener("pointerdown", onDocPointer, true);
  fabMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeFab(); fab.focus(); }
  });
  const scrub = buildScrubber();
  const panel = h("aside", { class: "panel", "aria-label": "Details" });
  const el = h("div", { class: "mapview" }, h("div", { class: "map-area" }, stage, scrub.el), panel);
  root.append(el);

  let size = { w: 1, h: 1 };
  let seen = { planned: 0, past: 0 }; // was die Karte gerade außer dem Bestand zeigt – für die Legende
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
    // Stoppeln: abgeerntete Fläche – der Boden etwas heller, mit kurzen Halmen
    const stubble = s("pattern", { id: "stubble", width: 26, height: 26, patternUnits: "userSpaceOnUse" },
      s("rect", { width: 26, height: 26, fill: "rgba(255,255,255,.2)" }),
      s("path", { d: "M5 4v5M18 7v5M11 16v5M23 19v5", fill: "none", stroke: "rgba(84,58,36,.4)", "stroke-width": 1.7, "stroke-linecap": "round" }));
    const light = s("pattern", { id: "grid-light", width: 100, height: 100, patternUnits: "userSpaceOnUse" },
      s("path", { d: "M100 0H0V100", fill: "none", stroke: "rgba(255,255,255,.28)", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
    return s("defs", {}, minor, major, soil, glass, gravel, stubble, light);
  }

  function renderSvg() {
    if (!view) return;
    applyView();
    const mode = state.mode;
    svg.classList.toggle("placing", mode?.type === "crop" || mode?.type === "planting");
    svg.classList.toggle("drawing", mode?.type === "bed");
    fab.classList.toggle("active", mode?.type === "bed");
    renderLock();
    const k = upp();
    const { W, H } = gardenSize();
    const groundLayer = ground(W, H);

    // Meterangaben am Rand, ausgedünnt je nach Zoom
    const step = k > 2.2 ? 2 : 1;
    const ruler = s("g", { class: "ruler", style: `font-size:${11 * k}px` });
    for (let i = 0; i <= W; i += step) ruler.append(s("text", { x: i * U, y: -6 * k, "text-anchor": "middle" }, i));
    for (let j = step; j <= H; j += step) ruler.append(s("text", { x: -6 * k, y: j * U + 4 * k, "text-anchor": "end" }, j));
    ruler.append(s("text", { x: W * U + 8 * k, y: -6 * k, "text-anchor": "start" }, "m"));

    seen = { planned: 0, past: 0 };
    const bedLayer = s("g", {});
    const ordered = [...state.beds].sort((a, b) => (a.kind === "path" ? -1 : 0) - (b.kind === "path" ? -1 : 0));
    for (const bed of ordered) bedLayer.append(drawBed(bed, k));

    svg.replaceChildren(defs(), groundLayer, ruler, bedLayer);

    empty.hidden = state.beds.length > 0 || !state.loaded || state.mode?.type === "bed";
    empty.classList.toggle("low", !!state.geo);
    if (!empty.hidden && !empty.firstChild) renderEmpty();
    renderHint();
    renderOrphanPill();
    renderLegend();
  }

  // Legende: nur, wenn außer dem, was im Beet steht, auch Geplantes oder Abgeerntetes zu sehen ist
  function renderLegend() {
    legend.hidden = !(seen.planned || seen.past);
    if (legend.hidden) return;
    const swatch = (...shapes) => s("svg", { viewBox: "0 0 26 16", "aria-hidden": "true" }, ...shapes);
    const item = (sw, text) => h("span", { class: "legend-item" }, sw, text);
    legend.replaceChildren(...[
      item(swatch(s("rect", { x: 1, y: 1, width: 24, height: 14, fill: "#cfe3c2", stroke: "#56704a" }),
        s("circle", { cx: 8, cy: 8, r: 2.6, fill: "#5d8a4a" }), s("circle", { cx: 18, cy: 8, r: 2.6, fill: "#5d8a4a" })), "im Beet"),
      seen.planned ? item(swatch(s("rect", { x: 1, y: 1, width: 24, height: 14, fill: "rgba(93,138,74,.2)", stroke: "#4a6b3e", "stroke-width": 0.9 }),
        s("path", { d: "M1.5 6V1.5H6M20 1.5h4.5V6M24.5 10v4.5H20M6 14.5H1.5V10", fill: "none", stroke: "#3f5c35", "stroke-width": 2.2 }),
        s("path", { d: "M6 8h14", stroke: "#4a6b3e", "stroke-width": 1, "stroke-dasharray": "1 2.5" })), "geplant") : null,
      seen.past ? item(swatch(s("rect", { x: 1, y: 1, width: 24, height: 14, fill: "#d9c9b6", stroke: "rgba(74,52,33,.7)", "stroke-width": 1.2,
        "stroke-dasharray": ".1 3", "stroke-linecap": "round" }),
        s("path", { d: "M7 5v4M14 8v4M20 4v4", stroke: "rgba(84,58,36,.55)", "stroke-width": 1.4, "stroke-linecap": "round" })), "abgeerntet") : null,
    ].filter(Boolean));
  }

  function renderHint() {
    const mode = state.mode;
    if (!mode) { hint.hidden = true; return; }
    hint.hidden = false;
    if (mode.type === "bed") {
      const label = KIND_LABEL[mode.kind];
      hint.replaceChildren(
        h("span", {}, `${label}: auf der Karte aufziehen, oder tippen für Standardgröße`),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => setMode(null) }, "Fertig"));
      return;
    }
    let what = "die Kultur";
    let when = "";
    if (mode.type === "crop") what = find.crop(mode.id)?.name ?? what;
    else {
      const p = find.planting(mode.id);
      what = p ? `${find.crop(p.crop_id)?.name ?? "den Satz"}${varietyText(p) ? " " + varietyText(p) : ""}` : "den Satz";
      const series = goalSeries(p);
      if (p) when = ` (${series ? `Satz ${series.pos + 1} von ${series.total}, ` : ""}${phases(p).plant != null ? "pflanzen" : "säen"} ${fmtDay(phases(p).fieldStart)})`;
    }
    const ghosts = state.beds.some((b) => PLANTABLE.has(b.kind) && harvestedOn(b).length);
    hint.replaceChildren(h("span", {}, `Tippe auf ein Beet, um ${what} zu setzen${when}.`,
      ghosts ? h("span", { class: "hint-sub" }, "Tippen in eine abgeerntete Fläche (hell umrandet) nutzt genau diese Fläche.") : null),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => setMode(null) }, "Abbrechen"));
  }

  // Sätze ohne Beet, die am Stichtag noch nicht vorbei sind
  function orphans() {
    return state.plantings
      .filter((p) => {
        const b = p.bed_id == null ? null : find.bed(p.bed_id);
        return (!b || !PLANTABLE.has(b.kind)) && phases(p).he >= state.day;
      })
      .sort((a, b) => phases(a).sow - phases(b).sow);
  }

  function renderOrphanPill() {
    const n = orphans().length;
    orphanPill.hidden = n === 0 || state.mode?.type === "planting";
    orphanPill.replaceChildren(h("span", { class: "count" }, n), n === 1 ? "Satz ohne Beet" : "Sätze ohne Beet");
  }

  function showOrphans() {
    if (state.sel) select(null);
    requestAnimationFrame(() => {
      const sec = panel.querySelector(".orphans");
      if (!sec) return;
      sec.scrollIntoView({ block: "start", behavior: "smooth" });
      sec.classList.remove("flash");
      void sec.offsetWidth;
      sec.classList.add("flash");
    });
  }

  // Grundstück: Rechteck, oder die gezeichnete Grenze mit Luftbild dahinter
  function ground(W, H) {
    const g = state.geo;
    const sat = !!(showSat && g?.image);
    svg.classList.toggle("sat", sat);
    satBtn.hidden = !g?.image;
    satBtn.setAttribute("aria-pressed", sat ? "true" : "false");
    compass.hidden = !g;
    if (g) compass.firstChild.style.transform = `rotate(${90 - g.frame.bearing}deg)`;
    attrib.hidden = !sat;
    if (sat) attrib.textContent = g.image.attribution || g.image.source || "";

    if (!g) {
      return s("g", {},
        s("rect", { class: "garden", x: 0, y: 0, width: W * U, height: H * U }),
        s("rect", { x: 0, y: 0, width: W * U, height: H * U, fill: "url(#grid-major)" }),
        s("rect", { x: 0, y: 0, width: W * U, height: H * U, fill: "none", stroke: "#9fb093", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
    }
    const pts = g.polygon.map(([x, y]) => `${x * U},${y * U}`);
    const layer = s("g", {});
    if (sat) {
      // Luftbild ist nach Norden ausgerichtet (Ost/Nord in Metern) und wird ins Beet-Koordinatensystem gedreht
      const b = (g.frame.bearing * Math.PI) / 180;
      const sn = Math.sin(b), cs = Math.cos(b);
      const [e0, n0, e1, n1] = g.image.enu;
      layer.append(s("g", { transform: `matrix(${sn} ${cs} ${-cs} ${sn} ${-g.frame.ox * U} ${-g.frame.oy * U})` },
        s("image", { href: g.image.url, x: e0 * U, y: -n1 * U, width: (e1 - e0) * U, height: (n1 - n0) * U, preserveAspectRatio: "none" })));
      const big = 100000;
      layer.append(s("path", { d: `M${-big} ${-big}H${big}V${big}H${-big}Z M${pts.join(" L")} Z`, "fill-rule": "evenodd", fill: "rgba(238,241,234,.55)" }));
    } else {
      layer.append(s("polygon", { class: "garden", points: pts.join(" ") }));
    }
    layer.append(s("polygon", { points: pts.join(" "), fill: sat ? "url(#grid-light)" : "url(#grid-major)" }));
    layer.append(s("polygon", { points: pts.join(" "), fill: "none", stroke: sat ? "#f2c200" : "#7f9772",
      "stroke-width": sat ? 2 : 1.5, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
    return layer;
  }

  // Drehwinkel rastet an Kanten der Grundstücksgrenze ein (parallel oder rechtwinklig)
  function snapToEdges(ang) {
    const poly = state.geo?.polygon;
    if (!poly) return null;
    let best = null;
    let bestDiff = 5;
    poly.forEach(([x1, y1], i) => {
      const [x2, y2] = poly[(i + 1) % poly.length];
      if (Math.hypot(x2 - x1, y2 - y1) < 1) return;
      const a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      for (let k = 0; k < 4; k++) {
        const cand = a + 90 * k;
        const d = Math.abs(((ang - cand) % 360 + 540) % 360 - 180);
        if (d < bestDiff) { bestDiff = d; best = cand; }
      }
    });
    return best;
  }

  function renderEmpty() {
    // Erste Frage beim Einrichten: sind alle Beete gleich breit?
    const bedMode = bedModeControl({ onChange: async () => {
      try { await saveBedMode(bedMode.value()); } catch (e) { toast(e.message, { error: true }); }
    } });
    empty.replaceChildren(h("div", {},
      h("h2", {}, "Noch keine Beete"),
      h("p", { class: "muted", style: { margin: 0 } },
        "Lege dein erstes Beet an und ziehe es an die richtige Stelle. Größe und Lage stellst du direkt auf der Karte ein."),
      h("div", { class: "empty-bedmode" },
        h("span", { class: "small" }, "Deine Beete"), bedMode.el,
        h("span", { class: "muted small" }, "Bei gleicher Breite bekommt jedes Beet diese Breite. Später änderbar unter Einstellungen.")),
      h("div", { class: "row" },
        state.geo ? null : h("button", { type: "button", class: "btn btn-primary", onclick: openGeoSetup }, icon("parcel"), "Grundstück auf dem Luftbild festlegen"),
        h("button", { type: "button", class: state.geo ? "btn btn-primary" : "btn", onclick: () => setMode({ type: "bed", kind: "bed" }) }, "Beet anlegen"),
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

  // ------------------------------------------------------------ Zeit auf der Karte
  // Die Karte zeigt den Stichtag. Drei Zustände, deutlich getrennt:
  //   im Beet    – farbige Fläche mit Pflanzen
  //   geplant    – abgesteckt: Rahmen mit Eckmarken in Kulturfarbe und Saatrillen, der Boden scheint durch
  //   abgeerntet – Stoppeln: ohne Farbe, fein gepunktet umrandet, kleine gedeckte Schrift
  // Auf jeder Stelle ist nur eines davon zu sehen: was dort steht – sonst, was als Nächstes kommt –
  // sonst, was dort zuletzt stand. Der gewählte Satz ist immer zu sehen.

  // Abgeerntete Sätze im Jahr des Stichtags, das zuletzt Abgeerntete am Ende
  function harvestedOn(bed) {
    const y = yearOf(state.day);
    return state.plantings.filter((p) => {
      if (p.bed_id !== bed.id) return false;
      const he = phases(p).he;
      return he < state.day && yearOf(he) === y;
    }).sort((a, b) => phases(a).he - phases(b).he);
  }

  const inside = (r, pt) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  // Anteil von r, den die Flächen in list überdecken (0 bis 1)
  const coveredShare = (r, list) => (r.w * r.h > 0
    ? Math.min(1, list.reduce((sum, c) => sum + overlapArea(r, c), 0) / (r.w * r.h)) : 1);

  // Abgeerntete Fläche unter einem Punkt (Meter im Beet), die zuletzt abgeerntete zuerst; nicht, wo jetzt etwas steht
  function spotAt(bed, local) {
    if (!bed || !local || !PLANTABLE.has(bed.kind)) return null;
    if (state.plantings.some((p) => p.bed_id === bed.id && onBedAt(p, state.day) && inside(rectOf(p, bed), local))) return null;
    const hit = harvestedOn(bed).reverse().find((p) => inside(rectOf(p, bed), local));
    if (!hit) return null;
    const r = rectOf(hit, bed);
    return { start: r.x, len: r.w, offset: r.y, span: r.h < bed.width - 0.001 ? r.h : null };
  }

  // Was ein Beet am Stichtag zeigt: was steht (active), was als Nächstes kommt (planned) und was zuletzt
  // dort stand (past) – jeweils nur, wo nichts Näherliegendes die Fläche schon belegt.
  function bedScene(bed) {
    const day = state.day;
    const mine = state.plantings.filter((p) => p.bed_id === bed.id);
    const rects = new Map();
    const R = (p) => {
      let r = rects.get(p.id);
      if (!r) rects.set(p.id, (r = rectOf(p, bed)));
      return r;
    };
    const active = mine.filter((p) => onBedAt(p, day));
    const activeR = active.map(R);

    // Satzfolgen: beginnt die Folge erst noch, steht ihr Block als eine geplante Fläche im Beet;
    // läuft sie, umrahmt ihn eine Linie und ihre Sätze erscheinen einzeln.
    const blocks = [], running = [];
    const inBlock = new Set();
    for (const goal of state.goals || []) {
      if (goal.bed_id !== bed.id || !(goal.block_len > 0)) continue;
      const ps = mine.filter((p) => p.goal_id === goal.id);
      if (!ps.length) continue;
      const from = Math.min(...ps.map((p) => phases(p).fieldStart)), to = Math.max(...ps.map((p) => phases(p).he));
      if (day < from) {
        const first = ps.reduce((a, b) => (phases(b).fieldStart < phases(a).fieldStart ? b : a));
        blocks.push({ goal, from, p: first, r: { x: goal.block_start || 0, y: 0, w: goal.block_len, h: bed.width } });
        for (const p of ps) inBlock.add(p.id);
      } else if (day <= to) running.push(goal);
    }

    // Geplant: in der Reihenfolge, in der die Sätze kommen – der erste bekommt die Fläche. Steht dort
    // am Stichtag noch etwas (oder kommt vorher etwas anderes), zählt der Satz nur unter „später“.
    const queue = [
      ...mine.filter((p) => phases(p).fieldStart > day && !inBlock.has(p.id)).map((p) => ({ p, from: phases(p).fieldStart, r: R(p) })),
      ...blocks,
    ].sort((a, b) => a.from - b.from);
    const planned = [];
    const waiting = new Set(); // eine Satzfolge zählt unter „später“ nur einmal
    for (const q of queue) {
      if (q.from > day + PLAN_AHEAD) continue;
      if (coveredShare(q.r, [...activeR, ...planned.map((x) => x.r)]) > 0.5) waiting.add(q.p.goal_id ? `g${q.p.goal_id}` : q.p.id);
      else planned.push(q);
    }
    const later = waiting.size;

    // Abgeerntet: vom zuletzt Abgeernteten rückwärts, solange ein gutes Stück der Fläche frei geblieben ist
    const past = [];
    for (const p of harvestedOn(bed).reverse()) {
      if (coveredShare(R(p), [...activeR, ...planned.map((x) => x.r), ...past.map((x) => x.r)]) < 0.7) past.push({ p, r: R(p) });
    }
    past.reverse(); // das Älteste liegt zuunterst
    return { mine, active, activeR, planned, past, running, later, R };
  }

  // Schneidet aus einer Fläche heraus, was darüber liegt, damit nichts durchscheint
  function cutOut(g, body, r, covers, k, key) {
    const hits = covers.filter((c) => overlapArea(r, c) > 1e-6);
    if (!hits.length) return;
    const m = 4 * k;
    const box = { x: r.x * U - m, y: r.y * U - m, width: r.w * U + 2 * m, height: r.h * U + 2 * m };
    g.append(s("mask", { id: `cut-${key}`, maskUnits: "userSpaceOnUse", ...box },
      s("rect", { ...box, fill: "#fff" }),
      ...hits.map((c) => s("rect", { x: c.x * U, y: c.y * U, width: c.w * U, height: c.h * U, fill: "#000" }))));
    body.setAttribute("mask", `url(#cut-${key})`);
  }

  // Freier Abschnitt für die Beschriftung: der breiteste am oberen Rand, über dem nichts liegt, sonst am unteren
  function labelSlot(r, covers, band) {
    const free = (y0, y1) => {
      let parts = [[r.x, r.x + r.w]];
      for (const c of covers) {
        if (c.y >= y1 - 0.001 || c.y + c.h <= y0 + 0.001) continue;
        parts = parts.flatMap(([a, b]) => (c.x >= b || c.x + c.w <= a ? [[a, b]]
          : [[a, Math.min(b, c.x)], [Math.max(a, c.x + c.w), b]].filter(([p, q]) => q - p > 0.01)));
      }
      return parts.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0] ?? null;
    };
    const top = free(r.y, Math.min(r.y + r.h, r.y + band));
    const bottom = free(Math.max(r.y, r.y + r.h - band), r.y + r.h);
    if (top && (!bottom || top[1] - top[0] >= (bottom[1] - bottom[0]) * 0.75)) return { x: top[0], w: top[1] - top[0], bottom: false };
    return bottom ? { x: bottom[0], w: bottom[1] - bottom[0], bottom: true } : null;
  }

  // Beschriftung einer Fläche: der Name, darunter (bei wenig Höhe dahinter) eine zweite Angabe – nur, wo sie lesbar Platz hat.
  // sub ist ein Text oder eine Funktion (max, immer), die die längste passende Schreibweise liefert.
  function areaLabel(g, r, k, { covers = [], name, sub = "", cls = "", size = 13, dot = null }) {
    const hh = r.h * U;
    if (hh / k < 13) return;
    const fs = Math.min(size * k, hh * 0.42);
    const pad = 4 * k;
    const tall = hh / k >= 32;
    const slot = covers.length ? labelSlot(r, covers, ((tall ? 2.2 : 1.2) * fs + pad) / U) : { x: r.x, w: r.w, bottom: false };
    if (!slot || (slot.w * U) / k < 26) return;
    const x = slot.x * U, y = r.y * U, w = slot.w * U;
    const lead = dot ? fs * 0.78 : 0;
    const maxChars = Math.max(2, Math.floor((w - 2 * pad - lead) / (fs * 0.47)));
    const subMax = Math.max(2, Math.floor((w - 2 * pad) / (fs * 0.88 * 0.47)));
    const clip = (t, n = maxChars) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + "…" : t);
    const fitted = typeof sub === "function";
    const second = fitted ? sub(tall ? subMax : maxChars - name.length - 1, tall) : sub;
    const twoLines = second && tall;
    const base = slot.bottom ? y + hh - pad - fs * 0.25 - (twoLines ? fs * 1.08 : 0) : y + pad + fs * 0.85;
    if (dot) g.append(s("circle", { class: "pl-dot", cx: x + pad + fs * 0.28, cy: base - fs * 0.33, r: fs * 0.27, fill: dot }));
    const t = s("text", { class: `pl-label ${cls}`.trim(), x: x + pad + lead, y: base,
      style: `font-size:${fs}px; stroke-width:${3.5 * k}px` }, clip(name));
    if (second) {
      if (twoLines) t.append(s("tspan", { class: "pl-sub", x: x + pad, dy: fs * 1.08, style: `font-size:${fs * 0.88}px` }, fitted ? second : clip(second)));
      else if (name.length + second.length + 1 <= maxChars) t.append(s("tspan", { class: "pl-sub", dx: fs * 0.3, style: `font-size:${fs * 0.88}px` }, second));
    }
    g.append(t);
  }

  // Ein Datum in der längsten Schreibweise, die in max Zeichen passt: „ab 1. Apr 2027“, „ab 1.4.27“, „ab 1.4.“, „1.4.“
  // – passt keine, die kürzeste (always) oder nichts
  function dayText(day, max, always, words) {
    const other = yearOf(day) !== yearOf(state.day);
    const [y, mo, d] = isoOf(day).split("-").map(Number);
    const forms = [...words.map((w) => `${w} ${fmtDay(day, { year: other })}`),
      `${words.at(-1)} ${d}.${mo}.${other ? String(y).slice(2) : ""}`, `${words.at(-1)} ${d}.${mo}.`, `${d}.${mo}.`];
    return forms.find((f) => f.length <= max) ?? (always ? forms.at(-1) : "");
  }

  // Saatrillen einer geplanten Fläche: wo die Reihen liegen werden, in Beetrichtung
  function furrows(p, crop, bed, x, y, w, hh, color, k) {
    const g = s("g", { class: "plan-rows", "pointer-events": "none", stroke: mix(color, "#1d2b24", 0.25) });
    const { along, rows } = plantLayout(p, crop, bed);
    const across = along === "x" ? hh : w;
    const step = Math.max(1, Math.ceil((7 * k * rows) / across)); // nicht dichter als alle 7 Pixel
    const inset = Math.min(7 * k, (along === "x" ? w : hh) / 6);
    for (let i = 0; i < rows; i += step) {
      const c = (across * (i + 0.5)) / rows;
      g.append(along === "x" ? s("line", { x1: x + inset, x2: x + w - inset, y1: y + c, y2: y + c })
        : s("line", { x1: x + c, x2: x + c, y1: y + inset, y2: y + hh - inset }));
    }
    return g;
  }

  // Geplant: ein Satz (oder der Block einer Satzfolge), der erst später ins Beet kommt – abgesteckt
  function drawPlanned(q, bed, k, { covers = [], onTop = false } = {}) {
    const { p, r } = q;
    const crop = find.crop(p.crop_id);
    const color = crop?.color || "#6a9b3c";
    const x = r.x * U, y = r.y * U, w = r.w * U, hh = r.h * U;
    const selected = !q.goal && state.sel?.type === "planting" && state.sel.id === p.id;
    const g = s("g", { class: `planting planned${selected ? " sel" : ""}`, "data-pid": p.id });
    const body = s("g", {});
    if (onTop) body.append(s("rect", { class: "on-top-back", x, y, width: w, height: hh }));
    body.append(s("rect", { class: "plan-tint", x, y, width: w, height: hh, fill: mix(color, "#ffffff", 0.6) }));
    if (!q.goal) body.append(furrows(p, crop, bed, x, y, w, hh, color, k));
    // Rahmen und Eckmarken liegen innen, damit der Beetrand sie nicht abschneidet
    const dark = mix(color, "#1d2b24", 0.3);
    const i = 1.5 * k;
    const x0 = x + i, y0 = y + i, x1 = x + w - i, y1 = y + hh - i;
    if (x1 > x0 && y1 > y0) {
      const c = Math.min(9 * k, (x1 - x0) / 3, (y1 - y0) / 3);
      body.append(s("rect", { class: "plan-frame", x: x0, y: y0, width: x1 - x0, height: y1 - y0, stroke: dark }));
      body.append(s("path", { class: "plan-corners", stroke: dark,
        d: `M${x0} ${y0 + c}V${y0}H${x0 + c}M${x1 - c} ${y0}H${x1}V${y0 + c}M${x1} ${y1 - c}V${y1}H${x1 - c}M${x0 + c} ${y1}H${x0}V${y1 - c}` }));
    }
    cutOut(g, body, r, covers, k, `p${p.id}${q.goal ? "b" : ""}`);
    g.append(body);
    if (selected) g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "vector-effect": "non-scaling-stroke" }));
    areaLabel(g, r, k, { covers, name: q.goal ? `Satzfolge ${crop?.name ?? ""}`.trim() : crop?.name ?? "Kultur",
      sub: (max, always) => dayText(q.from, max, always, ["ab"]) });
    return g;
  }

  // Abgeerntet: hier stand in diesem Jahr schon etwas – Stoppeln, die Fläche ist frei
  function drawPast(p, bed, k, { r = rectOf(p, bed), covers = [], onTop = false } = {}) {
    const crop = find.crop(p.crop_id);
    const x = r.x * U, y = r.y * U, w = r.w * U, hh = r.h * U;
    const selected = state.sel?.type === "planting" && state.sel.id === p.id;
    const g = s("g", { class: `planting past${selected ? " sel" : ""}`, "data-pid": p.id });
    const body = s("g", {});
    if (onTop) body.append(s("rect", { class: "on-top-back", x, y, width: w, height: hh }));
    const i = 1.5 * k;
    body.append(s("rect", { class: "past-area", x: x + i, y: y + i, width: Math.max(0, w - 2 * i), height: Math.max(0, hh - 2 * i) }));
    cutOut(g, body, r, covers, k, `h${p.id}`);
    g.append(body);
    if (selected) g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "vector-effect": "non-scaling-stroke" }));
    const he = phases(p).he;
    areaLabel(g, r, k, { covers, cls: "pl-past", size: 11.5, dot: crop?.color || "#6a9b3c", name: crop?.name ?? "Kultur",
      sub: (max, always) => dayText(he, max, always, ["abgeerntet", "bis"]) });
    return g;
  }

  // Rahmen um den Block einer laufenden Satzfolge
  function drawBlockFrame(goal, bed, k) {
    const crop = find.crop(goal.crop_id);
    const x = (goal.block_start || 0) * U, w = goal.block_len * U, hh = bed.width * U;
    return s("rect", { class: "block-outline", "pointer-events": "none", x: x + 1.5 * k, y: 1.5 * k,
      width: Math.max(0, w - 3 * k), height: Math.max(0, hh - 3 * k), rx: 2 * k,
      stroke: mix(crop?.color || "#6a9b3c", "#1d2b24", 0.4) });
  }

  function drawBed(bed, k) {
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

    let later = 0; // geplante Sätze, die am Stichtag nicht zu sehen sind, weil auf ihrer Fläche noch etwas steht
    if (PLANTABLE.has(bed.kind)) {
      const clipId = `clip-bed-${bed.id}`;
      g.append(s("clipPath", { id: clipId }, s("rect", { x: 0, y: 0, width: L, height: Wd })));
      const pg = s("g", { "clip-path": `url(#${clipId})` });
      const sc = bedScene(bed);
      later = sc.later;
      seen.planned += sc.planned.length;
      seen.past += sc.past.length;
      const plannedR = sc.planned.map((q) => q.r);
      // Der gewählte Satz ist immer ganz zu sehen: steht er nicht im Beet, liegt er zuoberst – als helle Karte,
      // wenn auf seiner Fläche gerade etwas anderes steht oder kommt.
      const selP = state.sel?.type === "planting" ? sc.mine.find((p) => p.id === state.sel.id) : null;
      const lifted = selP && !sc.active.includes(selP) ? selP : null;
      const isLifted = (q) => !q.goal && q.p === lifted;
      // von unten nach oben: abgeerntet, geplant (was früher kommt, liegt obenauf), im Beet
      sc.past.forEach((q, i) => {
        if (!isLifted(q)) pg.append(drawPast(q.p, bed, k, { r: q.r, covers: [...sc.past.slice(i + 1).map((x) => x.r), ...plannedR, ...sc.activeR] }));
      });
      for (let i = sc.planned.length - 1; i >= 0; i--) {
        if (!isLifted(sc.planned[i])) pg.append(drawPlanned(sc.planned[i], bed, k, { covers: [...plannedR.slice(0, i), ...sc.activeR] }));
      }
      for (const p of sc.active) pg.append(drawPlanting(p, bed, k));
      for (const goal of sc.running) pg.append(drawBlockFrame(goal, bed, k));
      if (lifted) {
        const r = sc.R(lifted), gone = phases(lifted).he < state.day;
        const others = [...sc.activeR, ...sc.planned.filter((q) => !isLifted(q)).map((q) => q.r), ...sc.past.filter((q) => !isLifted(q)).map((q) => q.r)];
        const onTop = others.some((c) => overlapArea(r, c) > 1e-6);
        if (!sc.planned.some(isLifted) && !sc.past.some(isLifted)) seen[gone ? "past" : "planned"]++;
        pg.append(gone ? drawPast(lifted, bed, k, { r, onTop })
          : drawPlanned({ p: lifted, from: phases(lifted).fieldStart, r }, bed, k, { onTop }));
      }
      g.append(pg);
      // Warnzeichen und Griffe liegen außerhalb der Beschneidung
      for (const p of sc.active) {
        const flags = drawFlags(p, bed, k);
        if (flags) g.append(flags);
      }
      // Griffe: nicht für Abgeerntetes, und nicht im Block einer Satzfolge (Größe bestimmt die Folge, Ziehen verschiebt den Block)
      if (selP && !blockGoalOf(selP) && phases(selP).he >= state.day) g.append(plantingHandles(selP, bed, k));
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
      const label = s("text", { class: "bed-name", x: 0, y: -gap, style: `font-size:${fs}px; stroke-width:${Math.min(3 * k, 9)}px`,
        transform: flip ? `rotate(180 ${L / 2} ${Wd / 2}) translate(0 ${Wd + gap + fs})` : null },
        bed.name,
        showSize ? s("tspan", { class: "bed-size", dx: 6 * k, style: `font-size:${fs * 0.85}px` }, `${fmtNum(bed.length, 2)} × ${fmtNum(bed.width, 2)} m`) : null,
        // steht am Stichtag noch etwas anderes auf der Fläche, zeigt die Beschriftung, dass hier später mehr kommt
        showSize && later ? s("tspan", { class: "bed-later", dx: 6 * k, style: `font-size:${fs * 0.85}px` }, `+${later} später`) : null);
      g.append(label);
    }

    if (selBed) {
      g.append(s("rect", { x: -3 * k, y: -3 * k, width: L + 6 * k, height: Wd + 6 * k, fill: "none",
        stroke: "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "5 4", "vector-effect": "non-scaling-stroke" }));
      if (locked()) {
        // gesperrt: keine Griffe, ein kleines Schloss am Rahmen
        g.append(s("g", { class: "bed-lock", "pointer-events": "none", transform: `translate(${L + 3 * k} ${-3 * k}) scale(${k})` },
          s("circle", { r: 9.5 }), s("path", { d: "M-3.6 -0.8h7.2v5.6h-7.2z M-2.2 -0.8v-1.9a2.2 2.2 0 0 1 4.4 0v1.9" })));
      } else {
        g.append(s("line", { x1: L / 2, y1: 0, x2: L / 2, y2: -30 * k, stroke: "var(--ink)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
        g.append(handle("bed-rot", L / 2, -30 * k, k, "circle"));
        g.append(handle("bed-r", L, Wd / 2, k));
        // Gleiche Beetbreite: nur die Länge lässt sich ziehen
        if (!uniformWidth(bed.kind)) {
          g.append(handle("bed-b", L / 2, Wd, k));
          g.append(handle("bed-br", L, Wd, k));
        }
      }
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

  // Im Beet: die Fläche in Kulturfarbe mit ihren Pflanzen
  function drawPlanting(p, bed, k) {
    const crop = find.crop(p.crop_id);
    const color = crop?.color || "#6a9b3c";
    const r = rectOf(p, bed);
    const x = r.x * U, y = r.y * U, w = r.w * U, hh = r.h * U;
    const selected = state.sel?.type === "planting" && state.sel.id === p.id;
    const g = s("g", { class: `planting${selected ? " sel" : ""}`, "data-pid": p.id });
    g.append(s("rect", { x, y, width: w, height: hh, fill: mix(color, "#ffffff", 0.58), stroke: mix(color, "#1d2b24", 0.2),
      "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
    g.append(drawPlants(p, crop, bed, x, y, w, hh, color, k));
    if (issuesOf(p.id).some((i) => i.kind === "conflict")) {
      g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--alert)", "stroke-width": 3, "vector-effect": "non-scaling-stroke" }));
    }
    if (selected) {
      g.append(s("rect", { x, y, width: w, height: hh, fill: "none", stroke: "var(--ink)", "stroke-width": 2.5, "vector-effect": "non-scaling-stroke" }));
    }
    areaLabel(g, r, k, { name: crop?.name ?? "Kultur", sub: varietyText(p) });
    return g;
  }

  function drawPlants(p, crop, bed, x, y, w, hh, color, k) {
    const g = s("g", { "pointer-events": "none" });
    const { along, rows, perRow, sp } = plantLayout(p, crop, bed);
    const dark = mix(color, "#1d2b24", 0.1);
    // Position von Reihe i, Pflanze j; Reihen laufen in Beetrichtung (along = "x": entlang der Beetlänge)
    const at = (i, j) => (along === "x"
      ? [x + (w * (j + 0.5)) / perRow, y + (hh * (i + 0.5)) / rows]
      : [x + (w * (i + 0.5)) / rows, y + (hh * (j + 0.5)) / perRow]);
    if (isMixed(p) && rows * perRow <= 3000) {
      // Mischsatz: jede Pflanze in der Farbe ihrer Sorte, mit Kürzel wenn genug Platz
      const plan = mixPlan(p, crop, bed);
      const rad = clamp(Math.min(sp.row, sp.plant) * 0.38, 1.2, 55);
      const showMark = rad / k >= 6.5;
      g.removeAttribute("pointer-events");
      for (const o of plan.order) {
        const [cx, cy] = at(o.r, o.c);
        if (o.v == null) {
          g.append(s("circle", { cx, cy, r: rad * 0.8, fill: "none", stroke: dark, "stroke-width": 1, "stroke-dasharray": "2 2",
            "vector-effect": "non-scaling-stroke", opacity: 0.6, "pointer-events": "none" }));
          continue;
        }
        const vc = varietyColor(o.v);
        const dot = s("g", {},
          s("title", {}, `${p.varieties[o.v].name}, Reihe ${o.row}, Platz ${o.place}`),
          s("circle", { cx, cy, r: rad, fill: vc, stroke: "#fff", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
        if (showMark) {
          dot.append(s("text", { x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central", fill: textOn(vc),
            "pointer-events": "none", transform: bed?.rotation ? `rotate(${-bed.rotation} ${cx} ${cy})` : null,
            style: `font: 600 ${rad * 1.1}px var(--font-cond)` }, varietyMark(o.v)));
        }
        g.append(dot);
      }
      // ausgewählt: Pflanzweg und erste Pflanze hervorheben
      if (state.sel?.type === "planting" && state.sel.id === p.id && plan.order.length > 1 && plan.order.length <= 800) {
        const pts = plan.order.map((o) => at(o.r, o.c).map((v) => v.toFixed(1)).join(",")).join(" ");
        g.prepend(s("polyline", { points: pts, fill: "none", stroke: "var(--ink)", "stroke-width": 1, "stroke-dasharray": "3 3",
          "vector-effect": "non-scaling-stroke", opacity: 0.5, "pointer-events": "none" }));
        const [sx, sy] = at(plan.order[0].r, plan.order[0].c);
        g.append(s("circle", { cx: sx, cy: sy, r: rad * 1.5, fill: "none", stroke: "var(--ink)", "stroke-width": 2,
          "vector-effect": "non-scaling-stroke", "pointer-events": "none" }));
      }
      return g;
    }
    if (rows * perRow > 900) {
      const inset = 4;
      for (let i = 0; i < rows; i++) {
        const [ax, ay] = at(i, 0);
        const line = along === "x"
          ? { x1: x + inset, x2: x + w - inset, y1: ay, y2: ay }
          : { x1: ax, x2: ax, y1: y + inset, y2: y + hh - inset };
        g.append(s("line", { ...line, stroke: dark, "stroke-width": Math.min(sp.row * 0.4, 10), "stroke-linecap": "round", opacity: 0.8 }));
      }
      return g;
    }
    const rad = clamp(Math.min(sp.row, sp.plant) * 0.36, 1.2, 55);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < perRow; j++) {
        const [cx, cy] = at(i, j);
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

    if (state.mode?.type === "bed") {
      gesture = { ...base, type: "draw", kind: state.mode.kind, w0: toWorld(e) };
      return;
    }
    if ((state.mode?.type === "crop" || state.mode?.type === "planting") && bedEl) {
      // Tippen setzt den Satz, Ziehen verschiebt den Ausschnitt
      gesture = { ...base, type: "place", bedId: Number(bedEl.dataset.bed), inv: bedEl.getScreenCTM().inverse(), view0: { ...view } };
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
      const isSel = state.sel?.type === "planting" && state.sel.id === p.id;
      const tap = { type: "planting", id: p.id };
      // Bei gesperrten Beeten verschiebt Ziehen einen Satz erst, wenn er gewählt ist – sonst bewegt es den
      // Ausschnitt, und Antippen wählt den Satz. Abgeerntetes liegt immer fest.
      if (locked() && (!isSel || phases(p).he < state.day)) {
        gesture = { ...base, type: "pan", view0: { ...view }, tap };
        svg.classList.add("panning");
        return;
      }
      // Eine abgeerntete Fläche ist freier Boden: Ziehen verschiebt das Beet, Antippen wählt den früheren Satz
      if (phases(p).he < state.day) {
        gesture = { ...base, type: "move-bed", id: bed.id, w0: toWorld(e), orig: { x: bed.x, y: bed.y }, tap };
        return;
      }
      if (!isSel) select({ type: "planting", id: p.id });
      const inv = bedEl.getScreenCTM().inverse();
      gesture = { ...base, type: "move-pl", id: p.id, bedId: bed.id, inv, l0: toLocal(e, inv),
        orig: { start: p.start, offset: p.offset, span: p.span }, span0: spanOf(p, bed) };
      return;
    }
    if (bedEl) {
      const bed = find.bed(Number(bedEl.dataset.bed));
      if (locked()) {
        // gesperrt: das Beet bleibt liegen, Ziehen bewegt den Ausschnitt, Antippen wählt das Beet
        gesture = { ...base, type: "pan", view0: { ...view }, tap: { type: "bed", id: bed.id } };
        svg.classList.add("panning");
        return;
      }
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
      case "draw": {
        const r = fitDraft(drawRect(gesture.w0, toWorld(e)), gesture.kind);
        showDraft(r);
        break;
      }
      case "pan":
      case "place": {
        const k = upp();
        view = { ...gesture.view0, x: gesture.view0.x - dxPx * k, y: gesture.view0.y - dyPx * k };
        applyView();
        break;
      }
      case "move-bed": {
        const bed = find.bed(gesture.id);
        if (!(state.sel?.type === "bed" && state.sel.id === bed.id)) select({ type: "bed", id: bed.id });
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
          ang = e.shiftKey ? snap(ang, 1) : (snapToEdges(ang) ?? snap(ang, 15));
          ang = round2(((ang % 360) + 360) % 360);
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
        const local = { x: l.x / U, y: l.y / U };
        const mode = state.mode;
        setMode(null);
        if (mode?.type === "crop") await placeCrop(mode.id, bed, local, spotAt(bed, local));
        else if (mode?.type === "planting") await assignPlanting(mode.id, bed, local, spotAt(bed, local));
        return;
      }
      if (g.type === "draw") {
        const [len, wid] = DEFAULT_BED_SIZE[g.kind] || DEFAULT_BED_SIZE.bed;
        await createBedRect(g.kind, round2(snap(g.w0.x / U - len / 2, 0.1)), round2(snap(g.w0.y / U - wid / 2, 0.1)), len, wid);
        return;
      }
      if (g.type === "pan" && !g.tap) {
        if (state.mode) setMode(null);
        else if (state.sel) select(null);
        return;
      }
      // Antippen: wählen (bei Sperre erst jetzt, damit Ziehen die Auswahl nicht ändert), doppelt öffnet den Dialog
      const tap = g.tap ?? (g.type === "move-pl" ? { type: "planting", id: g.id } : g.type === "move-bed" ? { type: "bed", id: g.id } : null);
      if (!tap) return;
      if (!(state.sel?.type === tap.type && state.sel.id === tap.id)) select(tap);
      const key = `${tap.type}:${tap.id}`;
      const now = performance.now();
      if (lastTap.key === key && now - lastTap.time < 380) {
        lastTap = { time: 0, key: null };
        openEditorFor(tap);
      } else {
        lastTap = { time: now, key };
      }
      return;
    }

    switch (g.type) {
      case "draw": {
        hideDraft();
        const r = fitDraft(drawRect(g.w0, toWorld(e)), g.kind);
        if (r.w < 0.2 || r.h < 0.2) { toast("Zu klein: mindestens 20 × 20 cm aufziehen"); break; }
        if (r.h > r.w) {
          // Hochkant aufgezogen: als Beet mit der langen Seite als Länge anlegen und um 90° drehen
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          await createBedRect(g.kind, round2(cx - r.h / 2), round2(cy - r.w / 2), r.h, r.w, 90);
        } else {
          await createBedRect(g.kind, r.x, r.y, r.w, r.h);
        }
        break;
      }
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
        const goal = g.type === "move-pl" ? blockGoalOf(p) : null;
        if (goal) {
          // Satz im Block: die ganze Satzfolge rückt mit
          const dx = round2((p.start || 0) - (g.orig.start || 0));
          Object.assign(p, g.orig);
          schedule("svg");
          await moveBlock(goal, dx);
          break;
        }
        await commit("plantings", p, g.orig, ["start", "len", "offset", "span"],
          g.type === "move-pl" ? `${crop?.name ?? "Satz"} verschoben` : `${crop?.name ?? "Satz"} angepasst`);
        break;
      }
      default:
        break;
    }
  }

  function openEditorFor(tap) {
    if (tap.type === "planting") openPlantingEditor(find.planting(tap.id));
    else if (tap.type === "bed") openBedEditor(find.bed(tap.id));
  }

  // Entwurf zurücksetzen und als eine Änderung speichern (dann klappt auch Rückgängig)
  async function commit(kind, item, orig, keys, label) {
    const changes = {};
    for (const k of keys) if (item[k] !== orig[k] && k in orig) changes[k] = item[k];
    for (const k of Object.keys(orig)) item[k] = orig[k];
    if (!Object.keys(changes).length) { schedule("svg"); return; }
    try { await patch(kind, item.id, changes, { undoLabel: label }); } catch { /* Meldung kam schon */ }
  }

  // Rechteck zum Aufziehen neuer Flächen, auf 10 cm gerastet, in Metern
  // Gleiche Beetbreite: die kurze Seite des aufgezogenen Rechtecks ist immer die Beetbreite
  function fitDraft(r, kind) {
    const uw = uniformWidth(kind);
    if (!uw) return r;
    return r.w >= r.h
      ? { ...r, y: round2(r.y + r.h / 2 - uw / 2), h: uw, w: Math.max(r.w, 0.3) }
      : { ...r, x: round2(r.x + r.w / 2 - uw / 2), w: uw, h: Math.max(r.h, 0.3) };
  }

  function drawRect(a, b) {
    const x0 = snap(Math.min(a.x, b.x) / U, 0.1), x1 = snap(Math.max(a.x, b.x) / U, 0.1);
    const y0 = snap(Math.min(a.y, b.y) / U, 0.1), y1 = snap(Math.max(a.y, b.y) / U, 0.1);
    return { x: round2(x0), y: round2(y0), w: round2(x1 - x0), h: round2(y1 - y0) };
  }

  let draft = null;
  function showDraft(r) {
    const k = upp();
    if (!draft) {
      draft = s("g", { class: "draft", "pointer-events": "none" },
        s("rect", { "vector-effect": "non-scaling-stroke" }), s("text", {}));
    }
    if (!draft.isConnected) svg.append(draft);
    const [rect, text] = draft.children;
    rect.setAttribute("x", r.x * U); rect.setAttribute("y", r.y * U);
    rect.setAttribute("width", r.w * U); rect.setAttribute("height", r.h * U);
    text.setAttribute("x", (r.x + r.w / 2) * U);
    text.setAttribute("y", (r.y + r.h) * U + 16 * k);
    text.setAttribute("style", `font-size:${12.5 * k}px; stroke-width:${3 * k}px`);
    text.textContent = `${fmtNum(r.w)} × ${fmtNum(r.h)} m`;
  }
  function hideDraft() { draft?.remove(); }

  function revert(g) {
    if (g?.type === "draw") { hideDraft(); return; }
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
        if (locked()) return; // gesperrte Beete bleiben auch mit den Pfeiltasten liegen
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

  // ------------------------------------------------------------ Seitenleiste

  function renderPanel() {
    const sel = state.sel;
    const parts = [];
    if (sel?.type === "planting" && find.planting(sel.id)) parts.push(...plantingPanel(find.planting(sel.id)));
    else if (sel?.type === "bed" && find.bed(sel.id)) parts.push(...bedPanel(find.bed(sel.id)));
    else parts.push(...overviewPanel());
    replaceKeepingFocus(panel, parts);
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
        h("span", { class: "name" }, c?.name ?? "Kultur", varietyText(p) ? h("span", { class: "muted" }, ` ${varietyText(p)}`) : null),
        h("span", { class: "when" }, when(p))));
    }));

    const loose = orphans();
    const out = [section(
      h("div", { class: "panel-title" }, h("h2", {}, state.settings.garden_name || "Garten")),
      h("p", { class: "status-line", style: { margin: 0 } },
        state.beds.length
          ? `${onBeds.length} ${onBeds.length === 1 ? "Satz steht" : "Sätze stehen"} am Stichtag im Beet, ${Math.round(occ * 100)} % der Anbaufläche sind belegt.`
          : "Lege zuerst Beete an."),
    )];
    if (loose.length) {
      out.push(h("section", { class: "panel-section orphans" },
        h("h3", {}, loose.length === 1 ? "1 Satz ohne Beet" : `${loose.length} Sätze ohne Beet`),
        h("p", { class: "muted small", style: { margin: 0 } }, "Ziehe einen Satz auf ein Beet, oder tippe ihn an und danach auf das Beet."),
        h("div", { class: "orphan-list" }, loose.map(orphanChip))));
    }
    if (nursery.length) {
      out.push(section(h("h3", {}, "In Anzucht"),
        h("p", { class: "muted small", style: { margin: 0 } }, "Diese Jungpflanzen stehen noch nicht im Beet und erscheinen nicht auf der Karte."),
        list(nursery, (p) => `pflanzen ${fmtDay(phases(p).plant)}`)));
    }
    if (soon.length) out.push(section(h("h3", {}, "Aussaat in den nächsten 14 Tagen"), list(soon, (p) => fmtDay(phases(p).sow))));
    const feeds = feedDueList(day);
    if (feeds) out.push(section(h("h3", {}, "Düngen in den nächsten 14 Tagen"), feeds));
    out.push(cropSection(null));
    out.push(section(h("h3", {}, "Fläche anlegen"),
      h("p", { class: "muted small", style: { margin: 0 } }, "Art wählen und auf der Karte aufziehen. Das geht auch über das + unten rechts."),
      h("div", { class: "actions" }, Object.entries(KIND_LABEL).map(([k, label]) =>
        h("button", { type: "button", class: "btn btn-sm", "aria-pressed": state.mode?.type === "bed" && state.mode.kind === k ? "true" : "false",
          onclick: () => setMode({ type: "bed", kind: k }) }, label)))));
    const g = state.geo;
    out.push(section(h("h3", {}, "Grundstück"),
      g ? h("p", { class: "muted small", style: { margin: 0 } },
        `${fmtNum(g.area, 0)} m² auf dem Luftbild festgelegt.${g.image_missing ? " Das Luftbild fehlt, du kannst es in den Einstellungen neu laden." : ""}`)
        : h("p", { class: "muted small", style: { margin: 0 } },
          "Zeichne die Grenze auf dem Luftbild ein. Die Beete liegen dann am richtigen Ort, und das Luftbild lässt sich hinter den Beeten einblenden."),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: openGeoSetup }, icon("parcel"), g ? "Grenze bearbeiten" : "Auf dem Luftbild festlegen"))));
    return out;
  }

  function cropSection(bed) {
    const plantable = bed && PLANTABLE.has(bed.kind);
    const q = cropQuery.trim().toLowerCase();
    const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.family || "").toLowerCase().includes(q));
    const chips = h("div", { class: "chips" }, crops.map((c) => cropChip(c, plantable ? bed : null)));
    const search = h("input", { class: "input crop-search", type: "search", placeholder: "Kultur suchen", value: cropQuery, "data-focus-key": "crop-search",
      "aria-label": "Kultur suchen",
      oninput: (e) => { cropQuery = e.target.value; schedule("panel"); } });
    return section(
      h("h3", {}, plantable ? `Kultur in ${bed.name} setzen` : "Kulturen"),
      h("p", { class: "muted small", style: { margin: 0 } }, plantable
        ? "Antippen setzt die Kultur an die erste freie Stelle. Ziehen setzt sie genau dorthin, wo du loslässt."
        : "Ziehe eine Kultur auf ein Beet, oder tippe sie an und danach auf das Beet. Termine richten sich nach dem Stichtag."),
      search, chips);
  }

  // Element, das sich auf ein Beet ziehen oder antippen lässt
  function draggable(el, { label, color, onTap, onDrop }) {
    let start = null;
    let ghost = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      start = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
        ghost = h("div", { class: "drag-ghost", style: { background: color, color: textColor(color) } }, label);
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
        await onDrop(target, { x: l.x / U, y: l.y / U });
        return;
      }
      if (e.type === "pointercancel") return;
      await onTap();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTap(); }
    });
    return el;
  }

  function cropChip(crop, bed) {
    const active = state.mode?.type === "crop" && state.mode.id === crop.id;
    const chip = h("button", { type: "button", class: "chip", "aria-pressed": active ? "true" : "false", title: crop.family || null },
      h("span", { class: "dot", style: { background: crop.color } }), crop.name);
    return draggable(chip, {
      label: crop.name,
      color: crop.color,
      onTap: () => (bed ? placeCrop(crop.id, bed) : setMode(active ? null : { type: "crop", id: crop.id })),
      onDrop: (target, local) => placeCrop(crop.id, target, local, spotAt(target, local)),
    });
  }

  function orphanChip(p) {
    const crop = find.crop(p.crop_id);
    const ph = phases(p);
    const active = state.mode?.type === "planting" && state.mode.id === p.id;
    const name = `${crop?.name ?? "Satz"}${varietyText(p) ? " " + varietyText(p) : ""}`;
    const el = h("button", { type: "button", class: "orphan", "aria-pressed": active ? "true" : "false" },
      h("span", { class: "dot", style: { background: crop?.color } }),
      h("span", { class: "name" }, crop?.name ?? "Satz", varietyText(p) ? h("span", { class: "muted" }, ` ${varietyText(p)}`) : null),
      h("span", { class: "when" }, `${ph.plant != null ? "pflanzen" : "säen"} ${fmtDay(ph.fieldStart)}`),
      h("span", { class: "size" }, `${fmtNum(p.len)} m`));
    return draggable(el, {
      label: name,
      color: crop?.color || "#6a9b3c",
      // Antippen: zum Tag springen, an dem der Satz ins Beet kommt, und dann aufs Beet tippen
      onTap: () => {
        if (active) { setMode(null); return; }
        setMode({ type: "planting", id: p.id });
        setDay(ph.fieldStart);
      },
      onDrop: (target, local) => assignPlanting(p.id, target, local, spotAt(target, local)),
    });
  }

  function bedPanel(bed) {
    const out = [bedSummary(bed, {
      actions: [
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => openBedEditor(bed), title: "Name, Größe, Lage und Notizen ändern" }, icon("edit"), "Bearbeiten"),
        h("button", { type: "button", class: "btn btn-sm", disabled: locked(), title: locked() ? "Beete sind gesperrt" : null,
          onclick: () => patch("beds", bed.id, { rotation: ((bed.rotation || 0) + 90) % 360 }, { undoLabel: `${bed.name} gedreht` }) }, icon("rotate"), "90° drehen"),
        PLANTABLE.has(bed.kind) ? h("button", { type: "button", class: "btn btn-sm", title: "Folgesätze aus der Erntemenge je Woche, als Block auf diesem Beet",
          onclick: () => openGoalEditor(null, { year: yearOf(state.day), bed_id: bed.id }) }, "Satzweise anbauen") : null,
        h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: deleteSelected }, icon("trash"), "Löschen"),
      ],
    })];
    if (locked()) {
      out.push(h("section", { class: "panel-section lock-note" },
        h("span", { class: "lock-note-text" }, icon("lock"), "Beete sind gesperrt: Ziehen verschiebt den Ausschnitt, nicht das Beet."),
        h("button", { type: "button", class: "btn btn-sm", onclick: toggleLock }, "Entsperren")));
    }
    const series = (state.goals || []).filter((x) => x.bed_id === bed.id);
    if (series.length) {
      out.push(h("section", { class: "panel-section" }, h("h3", {}, "Satzweiser Anbau"),
        h("ul", { class: "plain-list" }, series.map((x) => {
          const c = find.crop(x.crop_id);
          return h("li", {}, h("span", { class: "dot", style: { background: c?.color } }), " ",
            link(`${c?.name ?? "Kultur"}${x.variety ? ` ${x.variety}` : ""}`, () => openGoalOverview(x)),
            h("span", { class: "muted small" }, ` · ${fmtNum(x.amount)} ${x.unit} je Woche, ${fmtNum(x.block_len || 0, 2)} m ab ${fmtNum(x.block_start || 0, 2)} m`));
        }))));
    }
    out.push(...bedUsage(bed, { onPlanting: (p) => select({ type: "planting", id: p.id }) }));
    if (PLANTABLE.has(bed.kind)) out.push(cropSection(bed));
    return out;
  }

  // Sätze, die vor und nach diesem auf (überwiegend) derselben Stelle stehen
  function neighbours(p, bed) {
    const r = rectOf(p, bed), ph = phases(p);
    const same = state.plantings.filter((q) => q.id !== p.id && q.bed_id === bed.id).filter((q) => {
      const o = rectOf(q, bed);
      return overlapArea(r, o) > 0.3 * Math.min(r.w * r.h, o.w * o.h);
    });
    return {
      before: same.filter((q) => phases(q).he < ph.fieldStart).sort((a, b) => phases(b).he - phases(a).he)[0] ?? null,
      after: same.filter((q) => phases(q).fieldStart > ph.he).sort((a, b) => phases(a).fieldStart - phases(b).fieldStart)[0] ?? null,
    };
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
    const visible = onBedAt(p, day);
    const year = yearOf(day);
    const series = goalSeries(p);
    const goal = series ? (state.goals || []).find((g) => g.id === p.goal_id) : null;

    const around = bed ? neighbours(p, bed) : {};
    const other = (q, when) => [link(find.crop(q.crop_id)?.name ?? "Satz", () => select({ type: "planting", id: q.id })),
      h("span", { class: "muted" }, ` ${when}`)];
    const kv = h("dl", { class: "kv", style: { margin: 0 } },
      h("dt", {}, "Beet"), h("dd", {}, bed ? bed.name : "Ohne Beet"),
      h("dt", {}, "Fläche"), h("dd", {}, `${fmtNum(p.len)} × ${fmtNum(spanOf(p, bed))} m, ab ${fmtNum(p.start)} m`),
      h("dt", {}, "Pflanzen"), h("dd", {}, isMixed(p)
        ? `${mixPlan(p, crop, bed).total} auf ${plantCount(p, crop, bed)} Plätzen in ${plural(rowCount(p, crop, bed), "Reihe", "Reihen")}`
        : `${plantCount(p, crop, bed)} in ${plural(rowCount(p, crop, bed), "Reihe", "Reihen")}`),
      h("dt", {}, "Abstände"), h("dd", {}, `${sp.row} × ${sp.plant} cm`),
      h("dt", {}, "Aussaat"), h("dd", {}, fmtDay(ph.sow, { year: true })),
      ph.plant != null ? h("dt", {}, "Pflanzung") : null, ph.plant != null ? h("dd", {}, fmtDay(ph.plant, { year: true })) : null,
      h("dt", {}, "Ernte"), h("dd", {}, `${fmtDay(ph.hs)} bis ${fmtDay(ph.he, { year: true })}`),
      // was vorher und nachher auf derselben Stelle steht – die Karte zeigt davon immer nur eines
      around.before ? h("dt", {}, "Davor") : null,
      around.before ? h("dd", {}, ...other(around.before, `bis ${fmtDay(phases(around.before).he, { year: yearOf(phases(around.before).he) !== year })}`)) : null,
      around.after ? h("dt", {}, "Danach") : null,
      around.after ? h("dd", {}, ...other(around.after, `ab ${fmtDay(phases(around.after).fieldStart, { year: yearOf(phases(around.after).fieldStart) !== year })}`)) : null,
    );

    const out = [section(
      h("div", { class: "panel-title" },
        h("h2", { style: { display: "flex", alignItems: "center", gap: "8px" } }, cropLink(crop)),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openPlantingEditor(p) }, icon("edit"), "Bearbeiten")),
      varietyText(p) ? h("p", { class: "muted", style: { margin: "-6px 0 0" } },
        (isMixed(p) ? p.varieties.map((v) => v.name) : [p.variety]).flatMap((n, i) => [i ? ", " : "", varietyLink(p.crop_id, n)])) : null,
      h("p", { class: "status-line", style: { margin: 0 } }, status),
      miniTimeline(p, year),
      !visible && bed ? h("div", {},
        h("button", { type: "button", class: "btn btn-sm", onclick: () => setDay(ph.fieldStart) },
          `Zum ${ph.plant != null ? "Pflanztag" : "Saattag"} springen (${fmtDay(ph.fieldStart)})`)) : null,
      issues.length ? h("ul", { class: "issues" }, issues.map((i) => h("li", { class: i.kind }, i.text))) : null,
      kv,
      p.notes ? h("p", { class: "small", style: { margin: 0, whiteSpace: "pre-wrap" } }, p.notes) : null,
      series && goal ? h("p", { class: "small", style: { margin: 0 } }, `Satz ${series.pos + 1} von ${series.total} im satzweisen Anbau `,
        link(`${fmtNum(goal.amount)} ${goal.unit} je Woche`, () => openGoalOverview(goal)),
        blockGoalOf(p) ? ". Er liegt im Block der Folge: Ziehen verschiebt die ganze Folge, Größe und Lage ändert die Folge." : null) : null,
      bed ? null : h("div", {},
        h("button", { type: "button", class: "btn btn-sm btn-primary", title: `Springt zum ${ph.plant != null ? "Pflanztag" : "Saattag"}; danach aufs Beet tippen`,
          onclick: () => { setMode({ type: "planting", id: p.id }); setDay(ph.fieldStart); } }, "Auf ein Beet setzen")),
      h("div", { class: "actions" },
        series
          ? (series.next ? h("button", { type: "button", class: "btn btn-sm", onclick: () => followUp(p, { place: true }),
            title: `Satz ${series.pos + 2} von ${series.total} des Ernteziels: Stichtag springt zu seiner ${phases(series.next).plant != null ? "Pflanzung" : "Aussaat"}${series.next.bed_id ? "" : ", danach aufs Beet tippen"}` },
          icon("right"), `Nächster Satz (${series.pos + 2}/${series.total})`) : null)
          : h("button", { type: "button", class: "btn btn-sm", onclick: () => followUp(p, { place: true }), title: "Gleiche Kultur 14 Tage später, Stichtag springt mit" }, icon("copy"), "Folgesatz"),
        crop?.trait_group ? h("button", { type: "button", class: "btn btn-sm", onclick: () => openBonitur(p.id), title: "Pflanzen dieses Satzes bonitieren" }, "Bonitieren") : null,
        bed ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => select({ type: "bed", id: bed.id }) }, `${bed.name} zeigen`) : null,
        h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: deleteSelected }, icon("trash"), "Löschen")),
    )];
    if (isMixed(p)) {
      out.push(section(
        h("div", { class: "panel-title" }, h("h3", {}, "Sorten"),
          h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => downloadPlan(p, crop, bed),
            title: "Reihe, Platz und Sorte als Tabelle (CSV)" }, "Pflanzplan herunterladen")),
        mixLegend(p, crop, bed)));
    }
    const feed = feedBlock(p);
    if (feed) out.push(section(h("h3", {}, "Düngung"), feed));
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
      if (state.refit) {
        state.refit = false;
        empty.replaceChildren();
        if (size.w > 1) fit();
      }
      if (reason === "day") schedule("svg", "panel", "scrub");
      else if (reason === "select") schedule("svg", "panel");
      else schedule("svg", "panel", "scrub", "area");
    },
    destroy() {
      ro.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDocPointer, true);
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
