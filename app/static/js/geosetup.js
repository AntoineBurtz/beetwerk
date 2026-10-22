// Grundstück festlegen: Ort suchen, Grenze auf der Karte anklicken, eine Seite für die Ausrichtung wählen.
import { state, api, replaceAll } from "./store.js";
import { h, s, fmtNum } from "./util.js";
import { toast, icon } from "./ui.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const START_VIEW = { center: [48.95, 11.4], zoom: 7 }; // Bayern, passend zu den Standardquellen
const SIDES = [
  ["bottom", "unten"],
  ["left", "links"],
  ["right", "rechts"],
  ["top", "oben"],
];
// Kurs der x-Achse = Kurs der Außennormale der Seite + Versatz je nach Lage in der Beetkarte
const SIDE_OFFSET = { bottom: -90, top: 90, left: -180, right: 0 };

let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = h("link", { rel: "stylesheet", href: "vendor/leaflet/leaflet.css" });
    const js = h("script", { src: "vendor/leaflet/leaflet.js" });
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletPromise = null; reject(new Error("Die Kartenbibliothek konnte nicht geladen werden")); };
    document.head.append(css, js);
  });
  return leafletPromise;
}

// ---------------------------------------------------------------- Geometrie (lokale Ebene in Metern)

const norm360 = (a) => ((a % 360) + 360) % 360;

function metersPerDegree(lat) {
  const p = (lat * Math.PI) / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

// Ost/Nord-Meter um den Schwerpunkt, Kanten mit Länge und Kurs, Fläche, Umlaufsinn
function measure(points) {
  const lat0 = points.reduce((t, p) => t + p.lat, 0) / points.length;
  const lon0 = points.reduce((t, p) => t + p.lng, 0) / points.length;
  const m = metersPerDegree(lat0);
  const enu = points.map((p) => [(p.lng - lon0) * m.lon, (p.lat - lat0) * m.lat]);
  const edges = enu.map((a, i) => {
    const b = enu[(i + 1) % enu.length];
    const de = b[0] - a[0], dn = b[1] - a[1];
    return { length: Math.hypot(de, dn), bearing: norm360((Math.atan2(de, dn) * 180) / Math.PI) };
  });
  let twice = 0;
  for (let i = 0; i < enu.length; i++) {
    const [x1, y1] = enu[i], [x2, y2] = enu[(i + 1) % enu.length];
    twice += x1 * y2 - x2 * y1;
  }
  return { enu, edges, area: Math.abs(twice) / 2, ccw: twice > 0 };
}

// Kurs der x-Achse, damit die Seite an der gewünschten Bildschirmkante liegt und das Grundstück innen
function bearingFor(geom, edgeIndex, side) {
  const outward = geom.edges[edgeIndex].bearing + (geom.ccw ? 90 : -90);
  return norm360(outward + SIDE_OFFSET[side]);
}

function toLocal(enu, bearing) {
  const b = (bearing * Math.PI) / 180;
  const sn = Math.sin(b), cs = Math.cos(b);
  return enu.map(([e, n]) => [e * sn + n * cs, e * cs - n * sn]);
}

// Ecke der Seite, die auf dem Bildschirm zuerst kommt (links bzw. oben) – dort beginnt das Raster
function anchorFor(local, edgeIndex) {
  const a = edgeIndex, b = (edgeIndex + 1) % local.length;
  return local[a][0] + local[a][1] <= local[b][0] + local[b][1] + 1e-9 ? a : b;
}

// Wie der Server: Grenze beginnt bei (0, 0), die Ecke liegt auf vollen Metern
function placeLocal(local, anchor) {
  let ox = Math.min(...local.map((p) => p[0]));
  let oy = Math.min(...local.map((p) => p[1]));
  if (anchor != null) {
    const shift = (v) => Math.round(v) - v;
    ox -= shift(local[anchor][0] - ox);
    oy -= shift(local[anchor][1] - oy);
  }
  return local.map(([x, y]) => [x - ox, y - oy]);
}

// ---------------------------------------------------------------- Oberfläche

export async function openGeoSetup() {
  let L;
  try {
    L = await loadLeaflet();
  } catch (e) {
    toast(e.message, { error: true });
    return;
  }

  const sources = state.imagery?.sources || [];
  const overlay = (state.imagery?.overlays || [])[0] || null;
  const mapSources = sources.filter((x) => x.kind === "map");
  const aerialSources = sources.filter((x) => x.kind !== "map");
  const custom = { type: "wms", url: "", layers: "", attribution: "", max_zoom: 19, ...(state.imagery?.custom || {}) };
  const existing = state.geo;

  // Kartenansicht
  let base = existing ? "aerial" : "map";
  let mapId = mapSources[0]?.id || "osm";
  let aerialId = aerialSources[0]?.id || "custom";
  if (existing?.source && (existing.source === "custom" || aerialSources.some((x) => x.id === existing.source))) aerialId = existing.source;
  if (aerialId === "custom" && !custom.url) aerialId = aerialSources[0]?.id || "custom";
  let labelsOn = true;
  let editCustom = !custom.url;

  // Zeichnung und Ausrichtung
  let points = existing ? existing.boundary.map(([lat, lng]) => L.latLng(lat, lng)) : [];
  let closed = points.length >= 3;
  let orient = existing?.orient === "north" ? "north" : "edge";
  let refEdge = 0;
  let refSide = "bottom";
  let saving = false;

  if (existing && closed) {
    if (existing.ref_edge != null && existing.ref_edge < points.length) {
      refEdge = existing.ref_edge;
      refSide = existing.ref_side || "bottom";
    } else {
      // Ältere Grenzen ohne gespeicherte Seite: passende Kante zur Ausrichtung suchen
      const geom = measure(points);
      const b = existing.frame.bearing;
      let found = false;
      geom.edges.forEach((_, i) => SIDES.forEach(([side]) => {
        if (!found && Math.abs(((bearingFor(geom, i, side) - b + 540) % 360) - 180) < 0.5) {
          refEdge = i; refSide = side; found = true;
        }
      }));
      if (!found) {
        if (Math.abs(b - 90) < 0.01) orient = "north";
        else refEdge = longestEdge();
      }
    }
  }

  // ------------------------------------------------------------ Gerüst

  const mapEl = h("div", { class: "geo-map" });
  const layersEl = h("div", { class: "geo-layers" });
  const results = h("ul", { class: "geo-results", hidden: true, role: "listbox" });
  const searchInput = h("input", { type: "search", class: "input", placeholder: "Adresse oder Ort suchen, z. B. Hauptstraße 5, Augsburg",
    "aria-label": "Adresse oder Ort suchen", autocomplete: "off", enterkeyhint: "search" });
  const searchForm = h("form", { class: "geo-search", role: "search" },
    h("span", { class: "geo-search-icon", "aria-hidden": "true" }, searchSvg()),
    searchInput, h("button", { type: "submit", class: "btn btn-primary" }, "Suchen"), results);
  const panel = h("aside", { class: "geo-panel", "aria-live": "polite" });
  const closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Schließen", title: "Schließen" }, icon("close"));
  const root = h("div", { class: "geo-setup", role: "dialog", "aria-modal": "true", "aria-label": "Grundstück festlegen" },
    h("header", { class: "geo-head" }, h("h2", {}, "Grundstück festlegen"), searchForm, closeBtn),
    h("div", { class: "geo-body" }, h("div", { class: "geo-mapwrap" }, mapEl, layersEl), panel));
  document.body.append(root);
  document.body.classList.add("geo-open");

  const map = L.map(mapEl, { zoomControl: true, maxZoom: 22, doubleClickZoom: false, attributionControl: false });
  L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);
  if (window.beetwerk) window.beetwerk.geoMap = map; // für die Fehlersuche
  if (closed) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 21 });
  else map.setView(START_VIEW.center, START_VIEW.zoom);

  // ------------------------------------------------------------ Kartenebenen

  let baseLayer = null;
  let labelLayer = null;

  function aerialSource() {
    return aerialId === "custom" ? { id: "custom", label: "Eigene Quelle", snapshot: true, ...custom } : aerialSources.find((x) => x.id === aerialId);
  }

  function tileLayer(src) {
    if (src.tiles) {
      return L.tileLayer(src.tiles, { subdomains: src.subdomains || "abc", maxNativeZoom: src.max_zoom || 19, maxZoom: 22, attribution: src.attribution });
    }
    if (src.type === "wms") {
      return L.tileLayer.wms(src.url, { layers: src.layers, format: "image/jpeg", version: "1.1.1", tileSize: 512, maxZoom: 22, attribution: src.attribution });
    }
    return L.tileLayer(src.url, { subdomains: src.subdomains || "abc", maxNativeZoom: src.max_zoom || 19, maxZoom: 22, attribution: src.attribution });
  }

  function setLayers() {
    if (baseLayer) map.removeLayer(baseLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    baseLayer = labelLayer = null;
    const src = base === "map" ? mapSources.find((x) => x.id === mapId) : aerialSource();
    if (src?.url || src?.tiles) baseLayer = tileLayer(src).addTo(map);
    if (base === "aerial" && labelsOn && overlay) {
      labelLayer = tileLayer(overlay).addTo(map);
      labelLayer.setZIndex(5);
    }
    renderLayers();
  }

  function setBase(kind) {
    base = kind;
    setLayers();
    renderPanel();
  }

  function renderLayers() {
    const seg = h("div", { class: "geo-seg", role: "radiogroup", "aria-label": "Kartenart" },
      ...[["map", "Karte"], ["aerial", "Luftbild"]].map(([k, label]) => h("button", {
        type: "button", role: "radio", "aria-checked": base === k ? "true" : "false", onclick: () => setBase(k),
      }, label)));
    const list = base === "map" ? mapSources : aerialSources;
    const sel = h("select", { class: "input", "aria-label": base === "map" ? "Karte wählen" : "Luftbild wählen",
      onchange: (e) => {
        if (base === "map") mapId = e.target.value;
        else { aerialId = e.target.value; if (aerialId === "custom") editCustom = !custom.url; }
        setLayers();
        renderPanel();
      } },
    list.map((x) => h("option", { value: x.id, selected: x.id === (base === "map" ? mapId : aerialId) }, x.label)),
    base === "aerial" ? h("option", { value: "custom", selected: aerialId === "custom" }, "Eigene Quelle") : null);
    const labels = base === "aerial" && overlay
      ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: labelsOn,
        onchange: (e) => { labelsOn = e.target.checked; setLayers(); } }), overlay.label)
      : null;
    layersEl.replaceChildren(...[seg, sel, labels].filter(Boolean));
  }

  // ------------------------------------------------------------ Zeichnen

  const shapeLayer = L.layerGroup().addTo(map);
  const vertexLayer = L.layerGroup().addTo(map);

  function longestEdge() {
    const { edges } = measure(points);
    return edges.reduce((best, e, i) => (e.length > edges[best].length ? i : best), 0);
  }

  function redrawShape() {
    shapeLayer.clearLayers();
    if (!points.length) return;
    if (!closed) {
      L.polyline(points, { color: "#f2c200", weight: 3, dashArray: "6 6", interactive: false }).addTo(shapeLayer);
      return;
    }
    L.polygon(points, { color: "#f2c200", weight: 2, fillColor: "#f2c200", fillOpacity: 0.12, interactive: false }).addTo(shapeLayer);
    const { edges } = measure(points);
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      const isRef = orient === "edge" && i === refEdge;
      L.polyline([p, q], { color: isRef ? "#ffffff" : "#f2c200", weight: isRef ? 6 : 3, interactive: false }).addTo(shapeLayer);
      const hit = L.polyline([p, q], { color: "#000", opacity: 0, weight: 22 });
      hit.on("click", (e) => {
        L.DomEvent.stop(e);
        orient = "edge";
        refEdge = i;
        redrawShape();
        renderPanel();
      });
      hit.addTo(shapeLayer);
      const mid = L.latLng((p.lat + q.lat) / 2, (p.lng + q.lng) / 2);
      L.tooltip({ permanent: true, direction: "center", className: `geo-len${isRef ? " ref" : ""}`, interactive: false })
        .setLatLng(mid).setContent(`${fmtNum(edges[i].length)} m`).addTo(shapeLayer);
    });
  }

  function redrawVertices() {
    vertexLayer.clearLayers();
    points.forEach((p, i) => {
      const first = i === 0 && !closed && points.length >= 3;
      const marker = L.marker(p, {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({ className: `geo-vertex${first ? " first" : ""}`, iconSize: first ? [22, 22] : [16, 16] }),
      });
      marker.on("drag", (e) => { points[i] = e.target.getLatLng(); redrawShape(); });
      marker.on("dragend", () => renderPanel());
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        if (i === 0 && !closed && points.length >= 3) closeShape();
      });
      marker.addTo(vertexLayer);
    });
  }

  function closeShape() {
    closed = true;
    refEdge = longestEdge();
    refSide = "bottom";
    orient = "edge";
    redraw();
  }

  function redraw() {
    redrawShape();
    redrawVertices();
    renderPanel();
  }

  map.on("click", (e) => {
    if (closed || saving) return;
    points.push(e.latlng);
    redraw();
  });
  map.on("zoomend", () => { if (!closed && points.length === 0) renderPanel(); });

  // ------------------------------------------------------------ Ausrichtung berechnen

  function orientation() {
    const geom = measure(points);
    if (orient === "north") return { geom, bearing: 90, anchor: null };
    const bearing = bearingFor(geom, refEdge, refSide);
    const anchor = anchorFor(toLocal(geom.enu, bearing), refEdge);
    return { geom, bearing, anchor };
  }

  // Vorschau der späteren Beetkarte: Grenze, Raster, gewählte Seite, Nordpfeil
  function preview() {
    const { geom, bearing, anchor } = orientation();
    const pts = placeLocal(toLocal(geom.enu, bearing), anchor);
    const X0 = Math.min(0, ...pts.map((p) => p[0])), Y0 = Math.min(0, ...pts.map((p) => p[1]));
    const W = Math.max(...pts.map((p) => p[0])) - X0;
    const H = Math.max(...pts.map((p) => p[1])) - Y0;
    const BW = 300, BH = 170, pad = 14;
    const k = Math.min((BW - 2 * pad) / W, (BH - 2 * pad) / H);
    const ox = (BW - W * k) / 2 - X0 * k, oy = (BH - H * k) / 2 - Y0 * k;
    const P = ([x, y]) => [ox + x * k, oy + y * k];
    const step = Math.max(W, H) <= 30 ? 1 : Math.max(W, H) <= 80 ? 5 : 10;
    const grid = s("g", { stroke: "rgba(29,43,36,.13)", "stroke-width": 1 });
    for (let x = Math.floor(X0); x <= X0 + W + 1e-6; x += step) grid.append(s("line", { x1: P([x, 0])[0], x2: P([x, 0])[0], y1: 0, y2: BH }));
    for (let y = Math.floor(Y0); y <= Y0 + H + 1e-6; y += step) grid.append(s("line", { y1: P([0, y])[1], y2: P([0, y])[1], x1: 0, x2: BW }));
    const poly = pts.map(P).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const clipId = "geo-prev-clip";
    const svg = s("svg", { viewBox: `0 0 ${BW} ${BH}`, class: "geo-preview", role: "img",
      "aria-label": "Vorschau der Beetkarte mit Raster" },
    s("defs", {}, s("clipPath", { id: clipId }, s("polygon", { points: poly }))),
    s("rect", { x: 0.5, y: 0.5, width: BW - 1, height: BH - 1, rx: 6, fill: "#eef1ea", stroke: "#cfd7cb" }),
    s("polygon", { points: poly, fill: "#e2e9d9" }),
    s("g", { "clip-path": `url(#${clipId})` }, grid),
    s("polygon", { points: poly, fill: "none", stroke: "#7f9772", "stroke-width": 1.5, "stroke-linejoin": "round" }));
    if (orient === "edge") {
      const a = P(pts[refEdge]), b = P(pts[(refEdge + 1) % pts.length]);
      svg.append(s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "#f2c200", "stroke-width": 5, "stroke-linecap": "round" }));
      if (anchor != null) {
        const c = P(pts[anchor]);
        svg.append(s("circle", { cx: c[0], cy: c[1], r: 3.5, fill: "#1d2b24" }));
      }
    }
    // Nordpfeil oben rechts
    svg.append(s("g", { transform: `translate(${BW - 18} 20) rotate(${90 - bearing})` },
      s("path", { d: "M0 -11 L5 4 L0 1 L-5 4 Z", fill: "#536359" }),
      s("text", { y: 14, "text-anchor": "middle", style: "font: 700 8px var(--font)", fill: "#536359", transform: `rotate(${bearing - 90} 0 11)` }, "N")));
    return svg;
  }

  // ------------------------------------------------------------ Seitenleiste

  function customForm() {
    const type = h("select", { class: "input" },
      h("option", { value: "wms", selected: custom.type === "wms" }, "WMS"),
      h("option", { value: "xyz", selected: custom.type === "xyz" }, "Kacheln (XYZ)"));
    const url = h("input", { class: "input", value: custom.url, placeholder: "https://…" });
    const layers = h("input", { class: "input", value: custom.layers, placeholder: "Layer-Name" });
    const attr = h("input", { class: "input", value: custom.attribution, placeholder: "z. B. © Landesamt …" });
    const layersField = h("label", { class: "field" }, h("span", {}, "Layer"), layers);
    const syncType = () => {
      layersField.hidden = type.value !== "wms";
      url.placeholder = type.value === "wms" ? "https://…/wms" : "https://…/{z}/{x}/{y}.png";
    };
    type.addEventListener("change", syncType);
    syncType();
    return h("form", {
      class: "geo-custom", onsubmit: (e) => {
        e.preventDefault();
        Object.assign(custom, { type: type.value, url: url.value.trim(), layers: layers.value.trim(), attribution: attr.value.trim() });
        if (!/^https?:\/\//.test(custom.url)) { toast("Die Adresse muss mit http:// oder https:// beginnen", { error: true }); return; }
        if (custom.type === "wms" && !custom.layers) { toast("Für WMS fehlt der Layer-Name", { error: true }); return; }
        editCustom = false;
        setLayers();
        renderPanel();
      },
    },
      h("h3", {}, "Eigene Luftbildquelle"),
      h("p", { class: "muted small" }, "Zum Beispiel der WMS-Dienst für Orthofotos deines Bundeslands. Achte auf die Nutzungsbedingungen der Quelle."),
      h("label", { class: "field" }, h("span", {}, "Art"), type),
      h("label", { class: "field" }, h("span", {}, "Adresse"), url),
      layersField,
      h("label", { class: "field" }, h("span", {}, "Quellenangabe"), attr),
      h("button", { type: "submit", class: "btn btn-sm" }, "Anzeigen"));
  }

  function step(n, title, ...children) {
    return h("section", { class: "geo-step" }, h("h3", {}, h("span", { class: "geo-num" }, n), title), ...children);
  }

  function renderPanel() {
    const parts = [];
    if (base === "aerial" && aerialId === "custom") {
      parts.push(editCustom ? customForm() : h("div", { class: "geo-source-line" },
        h("span", { title: custom.url }, `Eigene Quelle: ${custom.url}`),
        h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { editCustom = true; renderPanel(); } }, "Ändern")));
    }

    if (!closed) {
      if (points.length === 0) {
        const near = map.getZoom() >= 16;
        parts.push(step(1, "Garten finden",
          h("p", {}, "Suche oben nach der Adresse oder zoome in der Karte heran."),
          base === "map"
            ? h("div", {},
              h("p", { class: "muted small" }, near ? "Zum genauen Zeichnen aufs Luftbild wechseln." : "Nach der Suche wechselt die Karte automatisch zum Luftbild."),
              near ? h("button", { type: "button", class: "btn btn-sm", onclick: () => setBase("aerial") }, "Luftbild zeigen") : null)
            : null));
      }
      parts.push(step(2, "Grenze zeichnen",
        h("p", {}, points.length === 0
          ? "Tippe die Ecken des Gartens der Reihe nach an."
          : points.length < 3
            ? `${points.length} von mindestens 3 Ecken gesetzt.`
            : "Tippe auf die erste Ecke (größerer Punkt), um die Grenze zu schließen."),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn btn-sm", disabled: !points.length, onclick: () => { points.pop(); redraw(); } }, "Letzte Ecke entfernen"),
          points.length >= 3 ? h("button", { type: "button", class: "btn btn-sm", onclick: closeShape }, "Grenze schließen") : null)));
    } else {
      const { edges, area } = measure(points);
      const perimeter = edges.reduce((t, e) => t + e.length, 0);
      parts.push(h("section", { class: "geo-step" },
        h("p", { class: "geo-figures" }, h("strong", {}, `${fmtNum(area, 0)} m²`), ` · Umfang ${fmtNum(perimeter)} m · ${points.length} Ecken`),
        h("p", { class: "muted small" }, "Ecken lassen sich noch verschieben."),
        h("div", {}, h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { points = []; closed = false; redraw(); } }, "Neu zeichnen"))));

      const sideButtons = h("div", { class: "geo-sides", role: "radiogroup", "aria-label": "Lage der Seite in der Beetkarte" },
        SIDES.map(([side, label]) => h("button", {
          type: "button", role: "radio", "aria-checked": orient === "edge" && refSide === side ? "true" : "false",
          onclick: () => { orient = "edge"; refSide = side; redrawShape(); renderPanel(); },
        }, h("span", { class: `geo-side-icon side-${side}`, "aria-hidden": "true" }), label)));
      parts.push(step(3, "Ausrichtung wählen",
        h("p", {}, orient === "edge"
          ? `Tippe auf eine Seite des Gartens. Die weiß markierte Seite (${fmtNum(edges[refEdge].length)} m) liegt in der Beetkarte:`
          : "Die Beetkarte ist nach Norden ausgerichtet."),
        sideButtons,
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: orient === "north",
          onchange: (e) => { orient = e.target.checked ? "north" : "edge"; redrawShape(); renderPanel(); } }), "Stattdessen Norden oben"),
        preview(),
        h("p", { class: "muted small" }, orient === "edge"
          ? "Das Raster verläuft parallel zu dieser Seite und beginnt an ihrer Ecke (Punkt)."
          : "Das Raster verläuft in Nord-Süd- und Ost-West-Richtung.")));

      const src = aerialSource();
      parts.push(step(4, "Luftbild",
        h("p", { class: "muted small" }, src?.url
          ? `Ein Ausschnitt aus „${src.label}“ wird auf deinem Server gespeichert und erscheint hinter den Beeten.`
          : "Wähle oben rechts ein Luftbild, damit es hinter den Beeten erscheint.")));
    }

    if (state.beds.length && existing) {
      parts.push(h("p", { class: "muted small" }, "Deine Beete bleiben an ihrer Stelle im Garten, auch wenn sich Grenze oder Ausrichtung ändern."));
    }

    const saveBtn = h("button", { type: "button", class: "btn btn-primary", disabled: !closed || saving, onclick: save },
      saving ? "Luftbild wird geladen …" : "Grundstück übernehmen");
    parts.push(h("div", { class: "geo-foot" },
      h("button", { type: "button", class: "btn btn-quiet", onclick: close }, "Abbrechen"), saveBtn));
    panel.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ Suche

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    results.hidden = false;
    results.replaceChildren(h("li", { class: "muted" }, "Suche …"));
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=6&accept-language=de&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Fehler ${res.status}`);
      const list = await res.json();
      if (!list.length) {
        results.replaceChildren(h("li", { class: "muted" }, "Nichts gefunden. Versuch es mit Straße, Hausnummer und Ort."));
        return;
      }
      results.replaceChildren(...list.map((r) => h("li", {},
        h("button", { type: "button", role: "option", onclick: () => {
          results.hidden = true;
          if (!closed && base === "map") setBase("aerial");
          const bb = r.boundingbox?.map(Number);
          if (bb && bb[1] - bb[0] < 0.01) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 20 });
          else map.setView([Number(r.lat), Number(r.lon)], 19);
        } }, r.display_name))));
      results.querySelector("button")?.focus();
    } catch (err) {
      results.replaceChildren(h("li", { class: "muted" }, `Die Suche ist gerade nicht erreichbar (${err.message}). Du kannst auch direkt in der Karte navigieren.`));
    }
  });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") results.hidden = true; });

  // ------------------------------------------------------------ Speichern und Schließen

  async function save() {
    if (!closed || saving) return;
    const { bearing, anchor } = orientation();
    const body = {
      boundary: points.map((p) => [p.lat, p.lng]), bearing, source: aerialId, orient,
      ref_edge: orient === "edge" ? refEdge : null, ref_side: orient === "edge" ? refSide : null, anchor,
    };
    if (aerialId === "custom") body.custom = { ...custom };
    saving = true;
    renderPanel();
    try {
      const data = await api.put("/api/garden/geo", body);
      const { warning, ...rest } = data;
      state.refit = true;
      replaceAll(rest);
      close();
      if (warning) toast(warning, { error: true, ms: 9000 });
      else toast(rest.geo?.image ? "Grundstück und Luftbild gespeichert" : "Grundstück gespeichert");
    } catch (err) {
      saving = false;
      renderPanel();
      toast(err.message, { error: true });
    }
  }

  function onKey(e) {
    if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
      if (!results.hidden) results.hidden = true;
      else close();
    }
  }
  document.addEventListener("keydown", onKey, true);

  function close() {
    document.removeEventListener("keydown", onKey, true);
    map.remove();
    root.remove();
    document.body.classList.remove("geo-open");
  }
  closeBtn.addEventListener("click", close);

  setLayers();
  redraw();
  setTimeout(() => map.invalidateSize(), 0);
  if (!closed) searchInput.focus();
}

function searchSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "path");
  c.setAttribute("d", "M8.5 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z M12.5 12.5L17 17");
  svg.append(c);
  return svg;
}
