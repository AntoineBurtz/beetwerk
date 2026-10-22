// Grundstück auf dem Luftbild festlegen: Ort suchen, Grenze anklicken, Ausrichtung wählen.
import { state, api, replaceAll } from "./store.js";
import { h, fmtNum } from "./util.js";
import { toast, icon } from "./ui.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const START_VIEW = { center: [48.95, 11.4], zoom: 7 }; // Bayern, passend zur Standardquelle

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

function metersPerDegree(lat) {
  const p = (lat * Math.PI) / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

function measure(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const m = metersPerDegree(lat0);
  const enu = points.map((p) => [(p.lng - lon0) * m.lon, (p.lat - lat0) * m.lat]);
  const edges = enu.map((a, i) => {
    const b = enu[(i + 1) % enu.length];
    const de = b[0] - a[0], dn = b[1] - a[1];
    return { length: Math.hypot(de, dn), bearing: ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360 };
  });
  let area = 0;
  for (let i = 0; i < enu.length; i++) {
    const [x1, y1] = enu[i], [x2, y2] = enu[(i + 1) % enu.length];
    area += x1 * y2 - x2 * y1;
  }
  return { edges, area: Math.abs(area) / 2 };
}

// Kurs der x-Achse, damit die Kante waagrecht liegt und Süden eher unten ist
function bearingForEdge(edgeBearing) {
  return ((edgeBearing % 180) + 180) % 180;
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
  const custom = { type: "wms", url: "", layers: "", attribution: "", max_zoom: 19, ...(state.imagery?.custom || {}) };
  const existing = state.geo;
  let sourceId = existing?.source || "bayern-dop20";
  if (sourceId === "custom" && !custom.url) sourceId = "bayern-dop20";

  // Zustand der Zeichnung
  let points = existing ? existing.boundary.map(([lat, lng]) => L.latLng(lat, lng)) : [];
  let closed = points.length >= 3;
  let orient = "edge";
  let refEdge = 0;
  let saving = false;
  let editCustom = !custom.url;

  if (existing && closed) {
    const { edges } = measure(points);
    const b = existing.frame.bearing;
    const diff = (a, c) => { const d = Math.abs(a - c) % 180; return Math.min(d, 180 - d); };
    const match = edges.findIndex((e) => diff(bearingForEdge(e.bearing), b) < 0.5);
    if (match >= 0) refEdge = match;
    else if (diff(b, 90) < 0.01) orient = "north";
    else refEdge = longestEdge();
  }

  // ------------------------------------------------------------ Gerüst

  const mapEl = h("div", { class: "geo-map" });
  const results = h("ul", { class: "geo-results", hidden: true, role: "listbox" });
  const searchInput = h("input", { type: "search", class: "input", placeholder: "Adresse oder Ort", "aria-label": "Adresse oder Ort suchen", autocomplete: "off" });
  const searchForm = h("form", { class: "geo-search", role: "search" },
    searchInput, h("button", { type: "submit", class: "btn" }, "Suchen"), results);
  const sourceSel = h("select", { class: "input geo-source", "aria-label": "Kartenquelle" },
    sources.map((s) => h("option", { value: s.id, selected: s.id === sourceId }, s.label)),
    h("option", { value: "custom", selected: sourceId === "custom" }, "Eigene Quelle"));
  const panel = h("aside", { class: "geo-panel", "aria-live": "polite" });
  const closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Schließen", title: "Schließen" }, icon("close"));
  const root = h("div", { class: "geo-setup", role: "dialog", "aria-modal": "true", "aria-label": "Grundstück festlegen" },
    h("header", { class: "geo-head" }, h("h2", {}, "Grundstück festlegen"), searchForm, sourceSel, closeBtn),
    h("div", { class: "geo-body" }, mapEl, panel));
  document.body.append(root);
  document.body.classList.add("geo-open");

  const map = L.map(mapEl, { zoomControl: true, maxZoom: 22, doubleClickZoom: false });
  map.attributionControl.setPrefix(false);
  if (window.beetwerk) window.beetwerk.geoMap = map; // für die Fehlersuche
  if (closed) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 21 });
  else map.setView(START_VIEW.center, START_VIEW.zoom);

  let baseLayer = null;
  function currentSource() {
    return sourceId === "custom" ? { id: "custom", label: "Eigene Quelle", snapshot: true, ...custom } : sources.find((s) => s.id === sourceId);
  }
  function setBase() {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = null;
    const src = currentSource();
    if (!src || !src.url) return;
    if (src.type === "wms") {
      baseLayer = L.tileLayer.wms(src.url, { layers: src.layers, format: "image/jpeg", version: "1.1.1",
        tileSize: 512, maxZoom: 22, attribution: src.attribution });
    } else {
      baseLayer = L.tileLayer(src.url, { maxZoom: 22, maxNativeZoom: src.max_zoom || 19, attribution: src.attribution });
    }
    baseLayer.addTo(map);
  }
  setBase();

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
      L.polyline([p, q], { color: isRef ? "#ffffff" : "#f2c200", weight: isRef ? 5 : 3, interactive: false }).addTo(shapeLayer);
      const hit = L.polyline([p, q], { color: "#000", opacity: 0, weight: 18 });
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
        setBase();
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

  function renderPanel() {
    const parts = [];
    const src = currentSource();
    if (sourceId === "custom") {
      parts.push(editCustom ? customForm() : h("div", { class: "geo-source-line" },
        h("span", { title: custom.url }, `Eigene Quelle: ${custom.url}`),
        h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { editCustom = true; renderPanel(); } }, "Ändern")));
    }

    if (!closed) {
      parts.push(h("section", { class: "geo-step" },
        h("h3", {}, "Grenze zeichnen"),
        h("p", {}, points.length === 0
          ? "Suche deinen Garten und zoome nah heran. Tippe dann die Ecken der Reihe nach an."
          : points.length < 3
            ? `${points.length} von mindestens 3 Ecken gesetzt.`
            : "Tippe auf die erste Ecke (größerer Punkt), um die Grenze zu schließen."),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn btn-sm", disabled: !points.length, onclick: () => { points.pop(); redraw(); } }, "Letzte Ecke entfernen"),
          points.length >= 3 ? h("button", { type: "button", class: "btn btn-sm", onclick: closeShape }, "Grenze schließen") : null)));
    } else {
      const { edges, area } = measure(points);
      const perimeter = edges.reduce((s, e) => s + e.length, 0);
      const radio = (value, label) => h("label", { class: "check" },
        h("input", { type: "radio", name: "geo-orient", value, checked: orient === value,
          onchange: () => { orient = value; redrawShape(); renderPanel(); } }), label);
      parts.push(h("section", { class: "geo-step" },
        h("h3", {}, "Grundstück"),
        h("p", { class: "geo-figures" }, h("strong", {}, `${fmtNum(area, 0)} m²`), ` · Umfang ${fmtNum(perimeter)} m · ${points.length} Ecken`),
        h("p", { class: "muted small" }, "Ecken lassen sich noch verschieben.")));
      parts.push(h("section", { class: "geo-step" },
        h("h3", {}, "Ausrichtung der Beetkarte"),
        radio("edge", "An einer Kante ausrichten"),
        orient === "edge" ? h("p", { class: "muted small geo-indent" }, `Die weiß markierte Kante (${fmtNum(edges[refEdge].length)} m) liegt waagrecht. Tippe auf eine andere Kante, um zu wechseln.`) : null,
        radio("north", "Norden oben")));
      const stores = src?.snapshot !== false && src?.url;
      parts.push(h("section", { class: "geo-step" },
        h("h3", {}, "Luftbild"),
        h("p", { class: "muted small" }, stores
          ? `Ein Ausschnitt aus „${src.label}“ wird auf deinem Server gespeichert und erscheint hinter den Beeten.`
          : "Diese Quelle dient nur zur Orientierung. Wähle oben ein Luftbild, damit es hinter den Beeten erscheint.")));
      parts.push(h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { points = []; closed = false; redraw(); } }, "Neu zeichnen")));
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
        results.replaceChildren(h("li", { class: "muted" }, "Nichts gefunden. Versuch es mit Straße und Ort."));
        return;
      }
      results.replaceChildren(...list.map((r) => h("li", {},
        h("button", { type: "button", role: "option", onclick: () => {
          results.hidden = true;
          const bb = r.boundingbox?.map(Number);
          if (bb && bb[1] - bb[0] < 0.01) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 20 });
          else map.setView([Number(r.lat), Number(r.lon)], 19);
        } }, r.display_name))));
    } catch (err) {
      results.replaceChildren(h("li", { class: "muted" }, `Die Suche ist gerade nicht erreichbar (${err.message}). Du kannst auch direkt in der Karte navigieren.`));
    }
  });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") results.hidden = true; });

  sourceSel.addEventListener("change", () => {
    sourceId = sourceSel.value;
    setBase();
    renderPanel();
  });

  // ------------------------------------------------------------ Speichern und Schließen

  async function save() {
    if (!closed || saving) return;
    const { edges } = measure(points);
    const bearing = orient === "north" ? 90 : bearingForEdge(edges[refEdge].bearing);
    const body = { boundary: points.map((p) => [p.lat, p.lng]), bearing, source: sourceId };
    if (sourceId === "custom") body.custom = { ...custom };
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

  redraw();
  setTimeout(() => map.invalidateSize(), 0);
  if (!closed) searchInput.focus();
}
