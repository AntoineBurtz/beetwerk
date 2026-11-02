// Wetter in der Zeitleiste: Regen, Frost und Wasserbilanz. Daten von Open-Meteo (CC BY 4.0),
// abgerufen und zwischengespeichert vom eigenen Server.
import { state, api } from "./store.js";
import { h, s, dayNum, fmtDay, fmtDayLong, fmtNum, clamp } from "./util.js";

export const WX_H = 44;
const RAIN_TOP = 7;     // Platz oben für Frostmarken
const RAIN_H = 24;      // Balkenhöhe bei RAIN_MAX
const RAIN_MAX = 20;    // mm/Tag, darüber wird gekappt
const STRIP_Y = 35;
const STRIP_H = 7;

// Nutzbare Feldkapazität (nFK) im Wurzelraum von 30 cm, grobe Richtwerte je Bodenart.
// Geisenheimer Bewässerungssteuerung für Gemüse: gießen bei 60 % nFK, auffüllen auf 90 % nFK.
export const SOILS = {
  sand: { label: "Sand", nfk: 30 },
  loamy_sand: { label: "lehmiger Sand", nfk: 45 },
  loam: { label: "Lehm oder Schluff", nfk: 60 },
};

export function soilOf(settings = state.settings) {
  const soil = SOILS[settings.weather_soil] || SOILS.loamy_sand;
  return { ...soil, threshold: soil.nfk * 0.4, refill: soil.nfk * 0.3 };
}

export const LEVELS = [
  { label: "feucht", color: "#8cc1a4" },
  { label: "trocknet ab", color: "#e8c34a" },
  { label: "gießen", color: "#d9632b" },
];

// Bodenspeicher: Verdunstung zehrt, Regen füllt auf. Erreicht das Defizit die Schwelle, ist das
// ein Gießtag; danach rechnet das Modell so weiter, als wäre wie empfohlen gegossen worden.
// So zeigt das Band, wann gegossen werden sollte, statt den ganzen Sommer nur "trocken".
export function waterBalance(days, soil = soilOf()) {
  let deficit = 0;
  return days.map((d) => {
    deficit = clamp(deficit + (d.et0 ?? 0) - (d.precip ?? 0), 0, soil.nfk);
    const water = deficit >= soil.threshold;
    const out = { ...d, n: dayNum(d.day), deficit, water, level: water ? 2 : deficit >= soil.threshold * 0.5 ? 1 : 0 };
    if (water) deficit = Math.max(0, deficit - soil.refill);
    return out;
  });
}

// Nächster Gießtag ab einem Tag (auch in der Vorhersage), sonst null
export function nextWatering(balance, from) {
  return balance.find((d) => d.n >= from && d.water) ?? null;
}

// ---------------------------------------------------------------- Laden

const cache = new Map();
const MAX_AGE = 30 * 60 * 1000;

function cacheKey(year) {
  const st = state.settings;
  return [year, st.weather_lat, st.weather_lon, state.geo?.boundary?.[0]?.join(",") ?? ""].join("|");
}

export function weatherEnabled() {
  return state.settings.weather_enabled !== "0";
}

// Liefert, was schon da ist (oder null), und lädt bei Bedarf nach; onLoad meldet neue Daten.
function load(key, url, onLoad, onError) {
  let entry = cache.get(key);
  if (!entry || (!entry.loading && Date.now() - entry.at > MAX_AGE)) {
    entry = { data: entry?.data ?? null, at: entry?.at ?? 0, loading: true, waiters: new Set() };
    cache.set(key, entry);
    const done = (data) => {
      // Mit Fehlermeldung nach zwei Minuten erneut fragen, der Server versucht es dann wieder
      const at = data?.error ? Date.now() - MAX_AGE + 2 * 60 * 1000 : Date.now();
      Object.assign(entry, { data, at, loading: false });
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      for (const fn of waiters) fn();
    };
    api.get(url).then(done).catch((err) => done(entry.data ?? onError(err)));
  }
  if (entry.loading && onLoad) entry.waiters.add(onLoad);
  return entry.data;
}

// Mittelwerte der letzten 20 Jahre (je Tag und Monat)
export function climateFor(onLoad) {
  if (!weatherEnabled()) return { status: "off" };
  return load(`c|${cacheKey("")}`, "/api/climate", onLoad, (err) => ({ status: "error", error: err.message }));
}

export function weatherFor(year, onLoad) {
  if (!weatherEnabled()) return { status: "off", days: [] };
  return load(`w|${cacheKey(year)}`, `/api/weather?year=${year}`, onLoad,
    (err) => ({ status: "error", error: err.message, days: [] }));
}

// ---------------------------------------------------------------- Frost: letzte und erste Frosttage der Vorjahre

export const FROST_COLOR = "#7b62c9";
export const FROST_OPTIONS = [
  ["0", "0 °C – Frost in 2 m Höhe"],
  ["2", "+2 °C – vorsichtig, Bodenfrost möglich"],
  ["-2", "−2 °C – nur stärkerer Frost"],
];

export function frostFor(onLoad) {
  if (!weatherEnabled()) return { status: "off" };
  const th = state.settings.weather_frost ?? "0";
  return load(`f|${cacheKey("")}|${th}`, `/api/frost?threshold=${th}`, onLoad,
    (err) => ({ status: "error", error: err.message }));
}

// Frostdaten auf ein bestimmtes Jahr übertragen; null, wenn (noch) nichts da ist
export function frostModel(frost, year) {
  if (frost?.status !== "ok" || !frost.n || !frost.stats?.spring_median) return null;
  const at = (mmdd) => (mmdd ? dayNum(`${year}-${mmdd}`) : null);
  const springs = frost.spring.map(at);
  const autumns = frost.autumn.map(at);
  const st = frost.stats;
  const mid = dayNum(`${year}-07-31`);
  return {
    n: frost.n,
    years: frost.years,
    threshold: frost.threshold,
    // Zahl der Jahre mit Frost an diesem Tag oder später (Frühjahr) bzw. bis zu diesem Tag (Herbst)
    count: (d) => (d <= mid
      ? springs.filter((v) => v != null && v >= d).length
      : autumns.filter((v) => v != null && v <= d).length),
    spring: at(st.spring_median),
    springSafe: at(st.spring_safe),
    springLatest: at(st.spring_latest),
    autumn: at(st.autumn_median),
    autumnSafe: at(st.autumn_safe),
    autumnEarliest: at(st.autumn_earliest),
    frostFree: st.frost_free_median,
    stats: st,
  };
}

export function frostTipLine(fm, d) {
  const k = fm.count(d);
  const spring = d <= dayNum(`${new Date(d * 86400000).getUTCFullYear()}-07-31`);
  if (spring) return k ? `Frost an diesem Tag oder später noch in ${k} von ${fm.n} Jahren` : `Kein Frost mehr ab hier, in allen ${fm.n} Jahren`;
  return k ? `Erster Frost bis hier schon in ${k} von ${fm.n} Jahren` : `Bis hier frostfrei, in allen ${fm.n} Jahren`;
}

const fmtMmdd = (mmdd) => (mmdd ? fmtDay(dayNum(`2001-${mmdd}`)) : "–");

// Zusammenfassung in Sätzen, z. B. für die Einstellungen
export function frostSummary(frost) {
  if (!frost) return ["Frostdaten werden geladen …"];
  if (frost.status === "off") return [];
  if (frost.status === "no_location") return ["Für die Frostdaten fehlt der Standort."];
  if (frost.status !== "ok" || !frost.stats?.spring_median) return [frost.error || "Keine Frostdaten verfügbar."];
  const st = frost.stats, n = frost.n;
  const safeCount = frost.spring.filter((v) => v == null || v <= st.spring_safe).length;
  const earlyCount = frost.autumn.filter((v) => v != null && v <= st.autumn_safe).length;
  const th = frost.threshold > 0 ? `+${fmtNum(frost.threshold)}` : fmtNum(frost.threshold);
  return [
    `Ausgewertet: ${frost.years[0]}–${frost.years[1]}, Tiefstwert ${th} °C oder kälter.`,
    `Letzter Frost im Frühjahr: in der Hälfte der Jahre bis ${fmtMmdd(st.spring_median)}, `
      + (safeCount >= n || st.spring_safe === st.spring_latest
        ? `in allen Jahren bis ${fmtMmdd(st.spring_latest)}.`
        : `in ${safeCount} von ${n} Jahren bis ${fmtMmdd(st.spring_safe)}, spätestens am ${fmtMmdd(st.spring_latest)}.`),
    st.autumn_median
      ? `Erster Frost im Herbst: in der Hälfte der Jahre bis ${fmtMmdd(st.autumn_median)}; `
        + (earlyCount
          ? `bis ${fmtMmdd(st.autumn_safe)} nur in ${earlyCount} von ${n} Jahren, frühestens am ${fmtMmdd(st.autumn_earliest)}.`
          : `vor dem ${fmtMmdd(st.autumn_earliest)} in keinem Jahr.`)
      : "Im Herbst gab es bis Jahresende in keinem Jahr Frost.",
    st.frost_free_median != null ? `Frostfrei im Mittel ${st.frost_free_median} Tage.` : null,
  ].filter(Boolean);
}

// Frostrisiko als Schattierung hinter den Beeten, dazu die mittleren Termine als Linien
export function frostOverlay(geo, fm) {
  const { ys, len, ppd } = geo;
  const svg = s("svg", { class: "frost-overlay", width: len * ppd, height: "100%", "aria-hidden": "true" });
  let run = null;
  const flush = () => {
    if (run && run.k > 0) {
      svg.append(s("rect", { x: (run.from - ys) * ppd, y: 0, width: (run.to - run.from + 1) * ppd, height: "100%",
        fill: FROST_COLOR, "fill-opacity": (0.04 + 0.18 * (run.k / fm.n)).toFixed(3) }));
    }
    run = null;
  };
  for (let d = ys; d < ys + len; d++) {
    const k = fm.count(d);
    if (run && run.k === k) { run.to = d; continue; }
    flush();
    run = { from: d, to: d, k };
  }
  flush();
  for (const d of [fm.spring, fm.autumn]) {
    if (d == null || d < ys || d >= ys + len) continue;
    const x = (d - ys + 0.5) * ppd;
    svg.append(s("line", { x1: x, x2: x, y1: 0, y2: "100%", class: "frost-median" }));
  }
  return svg;
}

// ---------------------------------------------------------------- Band in der Zeitleiste

const ATTR_URL = "https://open-meteo.com/";

function attributionLink(text = "Open-Meteo") {
  return h("a", { class: "wx-attr", href: ATTR_URL, target: "_blank", rel: "noopener", title: "Wetterdaten: Open-Meteo.com, Lizenz CC BY 4.0" }, text);
}

function levelChip(level, short = false) {
  const lv = LEVELS[level];
  return h("span", { class: "wx-level" }, h("i", { style: { background: lv.color } }), short ? null : lv.label);
}

// geo: { year, ys, len, ppd, labelW }; onSettings öffnet die Einstellungen
export function weatherBand(geo, data, { onSettings, frost: fm = null } = {}) {
  const { ys, len, ppd, labelW } = geo;
  const narrow = labelW < 120;
  const status = h("span", { class: "wx-status" });
  const title = h("span", { class: "wx-title" }, "Wetter", status);
  const corner = h("div", { class: "tl-wx-corner", style: { width: `${labelW}px` } }, title, attributionLink());
  const track = h("div", { class: "tl-wx-track", style: { width: `${len * ppd}px` } });
  const row = h("div", { class: "tl-wx-row" }, corner, track);
  let balance = [];
  const byDay = new Map();

  const note = (...children) => track.append(h("div", { class: "wx-note-wrap" }, h("div", { class: "wx-note" }, ...children)));
  if (data?.status === "ok" && data.days.length) {
    balance = waterBalance(data.days);
    for (const d of balance) byDay.set(d.n, d);
  }
  if (balance.length || fm) track.append(drawBand(geo, balance, data?.today ? dayNum(data.today) : null, fm));
  if (!data) {
    note("Wetter wird geladen …");
  } else if (data.status === "no_location") {
    status.replaceChildren();
    note("Für das Wetter fehlt der Standort. ",
      h("button", { type: "button", class: "btn btn-sm", onclick: () => onSettings?.() }, "Standort festlegen"));
  } else if (data.status === "error" || (data.status === "ok" && !data.days.length)) {
    note(data.error || "Für dieses Jahr gibt es noch keine Wetterdaten.");
  } else if (data.error) {
    title.append(h("span", { class: "wx-warn", title: `${data.error}. Angezeigt werden die zuletzt gespeicherten Werte.` }, "!"));
  }

  function setDay(day) {
    const d = byDay.get(day);
    if (!d) { status.replaceChildren(); return; }
    const next = d.water ? d : nextWatering(balance, day);
    const inDays = next ? next.n - day : null;
    const text = d.water ? "heute gießen" : inDays != null && inDays <= 3 ? `gießen in ${inDays} ${inDays === 1 ? "Tag" : "Tagen"}` : LEVELS[d.level].label;
    status.replaceChildren(h("span", { class: "wx-level" }, h("i", { style: { background: LEVELS[d.level].color } }), narrow ? null : text));
    status.title = `${fmtDayLong(day)}: ${d.water ? "gießen" : LEVELS[d.level].label}, Bodenwasser-Defizit ${fmtNum(d.deficit, 0)} mm`
      + (next && !d.water ? `. Nächster Gießtag: ${fmtDayLong(next.n)}${next.forecast ? " (laut Vorhersage)" : ""}` : "");
  }
  setDay(state.day);

  // Tagesdetails beim Überfahren oder Antippen
  const tip = h("div", { class: "wx-tip", role: "status", hidden: true });
  const cursor = h("div", { class: "wx-cursor", hidden: true });
  track.append(cursor);
  function show(ev) {
    const r = track.getBoundingClientRect();
    const n = ys + clamp(Math.floor((ev.clientX - r.left) / ppd), 0, len - 1);
    const d = byDay.get(n);
    if (!d && !fm) { hide(); return; }
    const soil = soilOf();
    cursor.hidden = false;
    cursor.style.left = `${(n - ys) * ppd}px`;
    cursor.style.width = `${Math.max(ppd, 2)}px`;
    const frostLine = fm ? h("span", { class: "wx-tip-frost" }, frostTipLine(fm, n)) : null;
    tip.replaceChildren(...(!d ? [
      h("strong", {}, fmtDayLong(n)),
      frostLine,
      h("span", { class: "wx-tip-src" }, `Frost: Auswertung ${fm.years[0]}–${fm.years[1]}, Open-Meteo.com`),
    ] : [
      h("strong", {}, fmtDayLong(n), d.forecast ? h("span", { class: "muted" }, " · Vorhersage") : null),
      h("span", {}, `Regen ${fmtNum(d.precip ?? 0)} mm`),
      d.tmin != null ? h("span", {}, `${fmtNum(d.tmin, 0)} bis ${fmtNum(d.tmax, 0)} °C${d.tmin <= 0 ? ", Frost" : ""}`) : null,
      d.et0 != null ? h("span", {}, `Verdunstung ${fmtNum(d.et0)} mm`) : null,
      h("span", { class: "wx-tip-level" }, levelChip(d.level),
        d.deficit >= 0.5 ? ` · Defizit ${fmtNum(d.deficit, 0)} mm` : ""),
      d.water ? h("strong", { class: "wx-tip-water" }, `Gießtag: etwa ${fmtNum(soil.refill, 0)} l/m²`)
        : h("span", { class: "muted" }, `Gießen ab ${fmtNum(soil.threshold, 0)} mm Defizit`),
      frostLine,
      h("span", { class: "wx-tip-src" }, "Wetterdaten: Open-Meteo.com"),
    ]).filter(Boolean));
    document.body.append(tip);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = clamp(ev.clientX + 14, 8, window.innerWidth - tw - 8);
    const y = r.bottom + 6 + th > window.innerHeight ? r.top - th - 6 : r.bottom + 6;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  function hide() {
    tip.hidden = true;
    cursor.hidden = true;
    tip.remove();
  }
  if (balance.length || fm) {
    track.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") show(e); });
    track.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    track.addEventListener("click", (e) => {
      show(e);
      const off = (ev) => {
        if (track.contains(ev.target)) return;
        hide();
        document.removeEventListener("pointerdown", off, true);
      };
      document.addEventListener("pointerdown", off, true);
    });
  }

  return { row, setDay, hide };
}

function drawBand(geo, balance, today, fm) {
  const { year, ys, len, ppd } = geo;
  const W = len * ppd;
  const svg = s("svg", { class: "wx-svg", width: W, height: WX_H, viewBox: `0 0 ${W} ${WX_H}`, "aria-hidden": "true" });
  // Monatslinien
  for (let m = 1; m < 12; m++) {
    const x = (Math.floor(Date.UTC(year, m, 1) / 86400000) - ys) * ppd;
    svg.append(s("line", { x1: x, x2: x, y1: 0, y2: WX_H, class: "wx-mline" }));
  }
  // Vorhersagezeitraum hinterlegen
  const fc = balance.filter((d) => d.forecast);
  if (fc.length) {
    const x0 = (fc[0].n - ys) * ppd, x1 = (fc.at(-1).n - ys + 1) * ppd;
    svg.append(s("rect", { x: x0, y: 0, width: x1 - x0, height: WX_H, class: "wx-fc-bg" }));
    if (x1 - x0 > 70) svg.append(s("text", { x: x0 + 3, y: 9, class: "wx-fc-label" }, "Vorhersage"));
  }
  if (today != null && today >= ys && today < ys + len) {
    const x = (today - ys + 0.5) * ppd;
    svg.append(s("line", { x1: x, x2: x, y1: 0, y2: WX_H, class: "wx-today" }));
  }
  // Regen
  const base = RAIN_TOP + RAIN_H;
  const bw = Math.max(1, ppd - (ppd >= 3 ? 1 : 0));
  for (const d of balance) {
    const x = (d.n - ys) * ppd;
    if (d.precip >= 0.1) {
      const hgt = Math.max(1.5, (Math.min(d.precip, RAIN_MAX) / RAIN_MAX) * RAIN_H);
      svg.append(s("rect", { x, y: base - hgt, width: bw, height: hgt, class: d.forecast ? "wx-rain fc" : "wx-rain" }));
      if (d.precip > RAIN_MAX) svg.append(s("rect", { x, y: base - RAIN_H - 2.5, width: bw, height: 1.5, class: "wx-rain-cap" }));
    }
    if (d.tmin != null && d.tmin <= 0) {
      svg.append(s("rect", { x, y: 1, width: Math.max(bw, 2), height: 4, rx: 1, class: d.forecast ? "wx-frost fc" : "wx-frost" }));
    }
  }
  svg.append(s("line", { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: "wx-base" }));
  // Mittlere Frosttermine der Vorjahre
  if (fm) {
    for (const [d, text, anchor] of [[fm.spring, "Ø letzter Frost", "start"], [fm.autumn, "Ø erster Frost", "end"]]) {
      if (d == null || d < ys || d >= ys + len) continue;
      const x = (d - ys + 0.5) * ppd;
      svg.append(s("line", { x1: x, x2: x, y1: 0, y2: WX_H, class: "wx-frost-median" }));
      svg.append(s("text", { x: anchor === "start" ? x + 4 : x - 4, y: 16, "text-anchor": anchor, class: "wx-frost-label" },
        `${text} ${fmtDay(d)}`));
    }
  }
  // Wasserbilanz als Streifen, gleiche Tage zusammengefasst
  let run = null;
  const flush = () => {
    if (!run) return;
    svg.append(s("rect", { x: (run.from - ys) * ppd, y: STRIP_Y, width: (run.to - run.from + 1) * ppd, height: STRIP_H,
      fill: LEVELS[run.level].color, class: run.forecast ? "wx-strip fc" : "wx-strip" }));
    run = null;
  };
  for (const d of balance) {
    const level = d.water ? 1 : d.level;
    if (run && run.level === level && run.forecast === d.forecast && d.n === run.to + 1) { run.to = d.n; continue; }
    flush();
    run = { from: d.n, to: d.n, level, forecast: !!d.forecast };
  }
  flush();
  for (const d of balance) {
    if (!d.water) continue;
    svg.append(s("rect", { x: (d.n - ys) * ppd, y: STRIP_Y - 3, width: Math.max(ppd, 2.5), height: STRIP_H + 3, rx: 1,
      fill: LEVELS[2].color, class: d.forecast ? "wx-water fc" : "wx-water" }));
  }
  return svg;
}
