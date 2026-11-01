// Wetter-Seite: Niederschlag, Temperatur, Wasserbilanz und Frost im Jahresverlauf, dazu Monatswerte
// und die nächsten Tage. Vergleich jeweils mit dem Mittel der letzten 20 Jahre.
import { state, setDay } from "./store.js";
import {
  h, s, dayNum, isoOf, todayNum, yearOf, yearStart, yearLength, MONTHS, MONTHS_SHORT, fmtDay, fmtDayLong, fmtNum, clamp,
} from "./util.js";
import {
  weatherFor, climateFor, frostFor, weatherEnabled, waterBalance, soilOf, frostSummary, nextWatering,
} from "./weather.js";
import { openSettings } from "./editor.js";

const C = {
  rain: "#2f7ab8",
  temp: "#c8553d",
  frost: "#7b62c9",
  water: "#d9632b",
  free: "#3f9a6b",
  normal: "#8a958d",
  wash: "rgba(138, 149, 141, .16)",
};
const WEEKDAY = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Tag im Jahr ohne Schalttag (Index in die Mittelwerte)
function normIndex(n) {
  const d = new Date(n * 86400000);
  const m = d.getUTCMonth();
  const day = m === 1 ? Math.min(d.getUTCDate(), 28) : d.getUTCDate();
  return (Date.UTC(2001, m, day) - Date.UTC(2001, 0, 1)) / 86400000;
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks.at(-1) < max) ticks.push(+(ticks.at(-1) + step).toFixed(6));
  return ticks;
}

function rangeTicks(min, max, step) {
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

const r1 = (v) => Math.round(v * 10) / 10;  // Summen gleich runden, damit Kacheln und Tabelle übereinstimmen
const pct = (a, b) => (b > 0 ? Math.round((a / b - 1) * 100) : null);
const signed = (v, unit = "") => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmtNum(Math.abs(v), 0)}${unit}`;

export function mountWeather(root) {
  const page = h("div", { class: "page wx-page" });
  const inner = h("div", { class: "page-inner" });
  page.append(inner);
  root.append(page);

  const tip = h("div", { class: "wx-tip chart-tip", role: "status", hidden: true });
  let charts = [];     // { el, draw(width), cursor(day) }
  let frame = 0;
  let lastWidth = 0;

  const rerender = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); };

  function note(...children) {
    inner.replaceChildren(head(yearOf(state.day)), h("div", { class: "empty-note" }, ...children));
  }

  function head(year) {
    const go = (dy) => {
      const d = new Date(state.day * 86400000);
      const target = Date.UTC(d.getUTCFullYear() + dy, d.getUTCMonth(), Math.min(d.getUTCDate(), 28));
      setDay(target / 86400000);
    };
    return h("div", { class: "page-head" },
      h("h1", {}, `Wetter ${year}`),
      h("div", { class: "wx-year" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => go(-1), "aria-label": "Jahr zurück" }, `‹ ${year - 1}`),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => go(1), "aria-label": "Jahr vor" }, `${year + 1} ›`)));
  }

  function render() {
    hideTip();
    const year = yearOf(state.day);
    if (!weatherEnabled()) {
      note("Wetterdaten sind abgeschaltet. ", h("button", { type: "button", class: "btn btn-sm", onclick: () => openSettings() }, "Einstellungen"));
      return;
    }
    const wx = weatherFor(year, rerender);
    const cl = climateFor(rerender);
    const fr = frostFor(rerender);
    if (!wx || wx.status === "no_location") {
      if (!wx) note("Wetterdaten werden geladen …");
      else note("Für das Wetter fehlt der Standort. ", h("button", { type: "button", class: "btn btn-sm", onclick: () => openSettings() }, "Standort festlegen"));
      return;
    }
    const ys = yearStart(year), len = yearLength(year);
    const today = todayNum();
    const bal = wx.status === "ok" ? waterBalance(wx.days) : [];
    const byDay = new Map(bal.map((d) => [d.n, d]));
    const obs = bal.filter((d) => !d.forecast);
    const fc = bal.filter((d) => d.forecast);
    const normals = cl?.status === "ok" && cl.daily ? cl : null;
    const nYears = normals ? `${normals.years[0]}–${normals.years[1]}` : "";
    const ctx = { year, ys, len, today, bal, byDay, obs, fc, normals, nYears, frost: fr?.status === "ok" ? fr : null };

    const out = [head(year)];
    const meta = [];
    if (wx.location) meta.push(`Standort ${fmtNum(wx.location.lat, 2)}° N, ${fmtNum(wx.location.lon, 2)}° O`);
    if (normals) meta.push(`Vergleich: Mittel ${nYears}`);
    out.push(h("p", { class: "muted small wx-meta" }, meta.join(" · "), meta.length ? " · " : "",
      h("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "Wetterdaten: Open-Meteo.com (CC BY 4.0)")));
    if (wx.error) out.push(h("div", { class: "empty-note" }, `${wx.error}. Angezeigt werden die zuletzt gespeicherten Werte.`));
    if (!bal.length) {
      out.push(h("div", { class: "empty-note" }, year > yearOf(today)
        ? `Für ${year} gibt es noch keine Wetterdaten. Unten stehen die Mittelwerte und Frosttermine der letzten Jahre.`
        : wx.error || `Für ${year} gibt es keine Wetterdaten.`));
    }

    out.push(kpis(ctx));
    charts = [];
    const daily = [];
    if (bal.length || normals) {
      daily.push(chartCard("Niederschlag seit 1. Januar", cumulativeChart(ctx), ctx.normals ? legend([
        ["line", C.rain, String(year)], ["line", C.normal, `Mittel ${nYears}`]]) : null));
    }
    out.push(...daily);
    if (bal.length || normals) out.push(chartCard("Niederschlag je Monat", monthlyChart(ctx), legend([
      ["rect", C.rain, String(year)], ["line", C.normal, `Mittel ${nYears}`]].filter((x, i) => i === 0 || normals))));
    if (bal.length || normals) out.push(chartCard("Temperatur", temperatureChart(ctx), legend([
      ["rect", C.temp, `${year}: Tiefst bis Höchst`], ["rect", C.frost, "unter 0 °C"],
      ...(normals ? [["wash", C.wash, `Mittel ${nYears}`]] : [])])));
    if (bal.length) {
      const soil = soilOf();
      out.push(chartCard("Bodenwasser-Defizit", waterChart(ctx), legend([
        ["line", C.water, "Defizit (je höher, desto trockener)"], ["dot", C.water, "Gießtag"],
        ["dash", C.normal, `Gießen ab ${fmtNum(soil.threshold, 0)} mm`]]),
      `Regen minus Verdunstung als Bodenspeicher, ${soil.label}. Ab der Schwelle ist ein Gießtag; danach rechnet das Modell so weiter, als wäre mit etwa ${fmtNum(soil.refill, 0)} l/m² gegossen worden.`));
    }
    out.push(monthTable(ctx));
    if (fc.length) out.push(forecastTable(ctx));
    if (ctx.frost?.per_year?.length) {
      out.push(chartCard("Frostfreie Zeit je Jahr", frostChart(ctx), legend([
        ["rect", C.free, "frostfrei"], ["dot", C.frost, "letzter und erster Frost"], ["dash", C.frost, "Mitte"]]),
      null, frostSummary(ctx.frost).map((l) => h("p", {}, l))));
    }
    inner.replaceChildren(...out);
    drawCharts();
  }

  // ------------------------------------------------------------ Kennzahlen

  function kpis(ctx) {
    const { year, today, obs, normals, byDay } = ctx;
    if (!obs.length) return null;
    const last = obs.at(-1);
    const ref = Math.min(last.n, year === yearOf(today) ? today : last.n);
    const sum = (from, to) => r1(obs.filter((d) => d.n >= from && d.n <= to).reduce((t, d) => t + (d.precip ?? 0), 0));
    const ncum = (n) => (normals ? normals.daily.precip_cum[normIndex(n)] : null);
    const total = sum(ctx.ys, ref);
    const totalNorm = ncum(ref);
    const last30 = sum(ref - 29, ref);
    const norm30 = normals ? (ref - 29 >= ctx.ys ? ncum(ref) - ncum(ref - 30) : null) : null;
    const tiles = [
      tile(`Regen seit 1. Januar`, `${fmtNum(total, 0)} mm`,
        totalNorm ? `${signed(pct(total, totalNorm), " %")} gegenüber dem Mittel (${fmtNum(totalNorm, 0)} mm)` : null),
      year === yearOf(today)
        ? tile("Regen in den letzten 30 Tagen", `${fmtNum(last30, 0)} mm`, norm30 != null ? `Mittel: ${fmtNum(norm30, 0)} mm` : null)
        : tile("Regentage", String(obs.filter((x) => (x.precip ?? 0) >= 1).length),
          normals ? `mindestens 1 mm, Mittel: ${fmtNum(normals.months.reduce((t, m) => t + m.rain_days, 0), 0)}` : "mindestens 1 mm"),
    ];
    const d = byDay.get(ref);
    if (d && year === yearOf(today)) {
      const next = d.water ? d : nextWatering(ctx.bal, ref);
      const inDays = next ? next.n - ref : null;
      tiles.push(tile("Gießen", d.water ? "heute" : inDays != null ? (inDays === 1 ? "morgen" : `in ${inDays} Tagen`) : "nicht nötig",
        `Defizit ${fmtNum(d.deficit, 0)} mm${next && !d.water ? `, Gießtag ${fmtDay(next.n)}${next.forecast ? " (Vorhersage)" : ""}` : ""}`));
    } else {
      const waterDays = obs.filter((x) => x.water).length;
      tiles.push(tile("Gießtage", String(waterDays), "nach dem Modell im ganzen Jahr"));
    }
    const fr = ctx.frost?.stats;
    const frostDays = obs.filter((x) => x.tmin != null && x.tmin < 0);
    const springFrost = frostDays.filter((x) => new Date(x.n * 86400000).getUTCMonth() <= 6).at(-1);
    const autumnFrost = frostDays.find((x) => new Date(x.n * 86400000).getUTCMonth() >= 7);
    const fcFrost = ctx.fc.find((x) => x.tmin != null && x.tmin < 0);
    let frostTile;
    if (fcFrost) frostTile = tile("Frost", `${WEEKDAY[new Date(fcFrost.n * 86400000).getUTCDay()]}, ${fmtDay(fcFrost.n)}`, `laut Vorhersage ${fmtNum(fcFrost.tmin, 1)} °C`);
    else if (autumnFrost) frostTile = tile("Erster Frost im Herbst", fmtDay(autumnFrost.n), fr?.autumn_median ? `Mittel: ${fmtDay(dayNum(`2001-${fr.autumn_median}`))}` : null);
    else if (new Date(ref * 86400000).getUTCMonth() >= 7 && fr?.autumn_median) frostTile = tile("Erster Frost im Herbst", "noch keiner", `Mittel: ${fmtDay(dayNum(`2001-${fr.autumn_median}`))}`);
    else if (springFrost) frostTile = tile("Letzter Frost bisher", fmtDay(springFrost.n), fr?.spring_median ? `Mittel: ${fmtDay(dayNum(`2001-${fr.spring_median}`))}` : null);
    if (frostTile) tiles.push(frostTile);
    return h("div", { class: "kpi-row" }, tiles);
  }

  function tile(label, value, sub) {
    return h("div", { class: "kpi" }, h("span", { class: "kpi-label" }, label), h("span", { class: "kpi-value" }, value),
      sub ? h("span", { class: "kpi-sub" }, sub) : null);
  }

  function legend(items) {
    return h("div", { class: "chart-legend" }, items.map(([kind, color, label]) => h("span", {},
      h("i", { class: `key key-${kind}`, style: `--c:${color}` }), label)));
  }

  function chartCard(title, chart, legendEl, subtitle, extra) {
    const box = h("div", { class: "chart-box" });
    charts.push({ ...chart, box });
    return h("section", { class: "section chart-card" },
      h("div", { class: "section-head" }, h("h2", {}, title)),
      subtitle ? h("p", { class: "muted small", style: { margin: 0 } }, subtitle) : null,
      legendEl, box, extra ? h("div", { class: "frost-summary" }, extra) : null);
  }

  function drawCharts() {
    const w = inner.clientWidth;
    lastWidth = w;
    for (const c of charts) {
      const width = c.box.clientWidth || w;
      c.box.replaceChildren(c.draw(width));
    }
  }

  // ------------------------------------------------------------ Gemeinsame Zeitachse

  const M = { l: 46, r: 70, t: 22, b: 26 };

  function timeFrame(ctx, width, height) {
    const pw = Math.max(80, width - M.l - M.r);
    const x = (n) => M.l + ((n - ctx.ys + 0.5) / ctx.len) * pw;
    const svg = s("svg", { class: "chart", width, height: height + M.t + M.b, viewBox: `0 0 ${width} ${height + M.t + M.b}` });
    const grid = s("g", { class: "grid" });
    const axis = s("g", { class: "axis" });
    const short = pw / 12 < 30;
    for (let m = 0; m < 12; m++) {
      const a = Math.floor(Date.UTC(ctx.year, m, 1) / 86400000);
      const b = Math.floor(Date.UTC(ctx.year, m + 1, 1) / 86400000);
      const xa = M.l + ((a - ctx.ys) / ctx.len) * pw;
      const xb = M.l + ((b - ctx.ys) / ctx.len) * pw;
      if (m > 0) grid.append(s("line", { x1: xa, x2: xa, y1: M.t, y2: M.t + height }));
      axis.append(s("text", { x: (xa + xb) / 2, y: M.t + height + 17, "text-anchor": "middle" }, short ? MONTHS_SHORT[m][0] : MONTHS_SHORT[m]));
    }
    svg.append(grid, axis);
    return { svg, x, pw, height, grid, axis };
  }

  function yAxis(f, ticks, y, fmt = (v) => fmtNum(v)) {
    for (const v of ticks) {
      const yy = y(v);
      f.grid.append(s("line", { x1: M.l, x2: M.l + f.pw, y1: yy, y2: yy, class: v === 0 ? "zero" : null }));
      f.axis.append(s("text", { x: M.l - 6, y: yy + 4, "text-anchor": "end" }, fmt(v)));
    }
  }

  // Fadenkreuz und Tooltip über einem Zeitdiagramm
  function hoverLayer(ctx, f, rows) {
    const cursor = s("line", { class: "cursor", y1: M.t, y2: M.t + f.height, visibility: "hidden" });
    const hit = s("rect", { x: M.l, y: 0, width: f.pw, height: f.height + M.t + M.b, fill: "transparent", class: "hit" });
    f.svg.append(cursor, hit);
    const dayAt = (ev) => {
      const r = hit.getBoundingClientRect();
      return ctx.ys + clamp(Math.floor(((ev.clientX - r.left) / r.width) * ctx.len), 0, ctx.len - 1);
    };
    const show = (ev) => {
      const n = dayAt(ev);
      const content = rows(n);
      for (const c of charts) c.cursor?.(n);
      if (!content) { hideTip(); return; }
      showTip(ev, content);
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") { hideTip(); for (const c of charts) c.cursor?.(null); } });
    return (n) => {
      if (n == null || n < ctx.ys || n >= ctx.ys + ctx.len) { cursor.setAttribute("visibility", "hidden"); return; }
      const xx = f.x(n);
      cursor.setAttribute("x1", xx); cursor.setAttribute("x2", xx);
      cursor.setAttribute("visibility", "visible");
    };
  }

  function showTip(ev, content) {
    tip.replaceChildren(...content.filter(Boolean));
    if (!tip.isConnected) document.body.append(tip);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = ev.clientX + 16 + tw > window.innerWidth - 8 ? ev.clientX - tw - 16 : ev.clientX + 16;
    const y = clamp(ev.clientY - th / 2, 8, window.innerHeight - th - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${y}px`;
  }

  function hideTip() {
    tip.hidden = true;
    tip.remove();
  }

  const row = (color, value, label, kind = "line") => h("span", { class: "tip-row" },
    h("i", { class: `key key-${kind}`, style: `--c:${color}` }), h("strong", {}, value), ` ${label}`);
  const dateLine = (n, forecast) => h("span", { class: "tip-date" }, fmtDayLong(n), forecast ? " · Vorhersage" : "");

  // ------------------------------------------------------------ Niederschlag kumuliert

  function cumulativeChart(ctx) {
    return {
      draw(width) {
        const H = 190;
        const f = timeFrame(ctx, width, H);
        const { obs, fc, normals, ys, len } = ctx;
        const cum = new Map();
        let t = 0;
        for (const d of obs) { t += d.precip ?? 0; cum.set(d.n, t); }
        const lastObs = obs.at(-1);
        const fcCum = new Map();
        let tf = t;
        for (const d of fc) { tf += d.precip ?? 0; fcCum.set(d.n, tf); }
        const normal = (n) => (normals ? normals.daily.precip_cum[normIndex(n)] : null);
        const max = Math.max(tf, normals ? normals.daily.precip_cum.at(-1) : 0, 10);
        const ticks = niceTicks(max);
        const y = (v) => M.t + H - (v / ticks.at(-1)) * H;
        yAxis(f, ticks, y, (v) => fmtNum(v, 0));
        f.axis.append(s("text", { x: M.l - 6, y: M.t - 12, "text-anchor": "end", class: "unit" }, "mm"));
        const path = (pts) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
        const labels = [];
        if (normals) {
          const pts = [];
          for (let n = ys; n < ys + len; n++) pts.push([f.x(n), y(normal(n))]);
          f.svg.append(s("path", { d: path(pts), class: "line", stroke: C.normal }));
          labels.push({ y: y(normal(ys + len - 1)), text: `Mittel ${fmtNum(normal(ys + len - 1), 0)}`, x: f.x(ys + len - 1) });
        }
        if (obs.length) {
          const pts = obs.map((d) => [f.x(d.n), y(cum.get(d.n))]);
          f.svg.append(s("path", { d: path(pts), class: "line", stroke: C.rain }));
          if (fc.length) {
            const fpts = [[f.x(lastObs.n), y(t)], ...fc.map((d) => [f.x(d.n), y(fcCum.get(d.n))])];
            f.svg.append(s("path", { d: path(fpts), class: "line forecast", stroke: C.rain }));
          }
          const ex = f.x(lastObs.n), ey = y(t);
          f.svg.append(s("circle", { cx: ex, cy: ey, r: 4, fill: C.rain, class: "end-dot" }));
          labels.push({ y: ey, text: `${ctx.year}: ${fmtNum(r1(t), 0)}`, x: ex });
        }
        // Endbeschriftungen rechts, bei Überschneidung auseinanderschieben
        labels.sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
        for (const l of labels) f.svg.append(s("text", { x: Math.max(l.x, M.l + f.pw) + 8, y: l.y + 4, class: "end-label" }, `${l.text} mm`));
        this.cursor = hoverLayer(ctx, f, (n) => {
          const c = cum.get(n) ?? fcCum.get(n);
          const nv = normal(n);
          const d = ctx.byDay.get(n);
          if (c == null && nv == null) return null;
          return [dateLine(n, d?.forecast),
            c != null ? row(C.rain, `${fmtNum(c, 0)} mm`, `seit 1. Januar ${ctx.year}`) : null,
            nv != null ? row(C.normal, `${fmtNum(nv, 0)} mm`, "im Mittel") : null,
            c != null && nv ? h("span", { class: "muted" }, `${signed(pct(c, nv), " %")} gegenüber dem Mittel`) : null,
            d ? h("span", { class: "muted" }, `Regen an diesem Tag: ${fmtNum(d.precip ?? 0)} mm`) : null];
        });
        return f.svg;
      },
    };
  }

  // ------------------------------------------------------------ Niederschlag je Monat

  function monthStats(ctx) {
    const out = [];
    for (let m = 0; m < 12; m++) {
      const days = ctx.obs.filter((d) => new Date(d.n * 86400000).getUTCMonth() === m);
      const a = Math.floor(Date.UTC(ctx.year, m, 1) / 86400000);
      const b = Math.floor(Date.UTC(ctx.year, m + 1, 1) / 86400000);
      const complete = days.length >= b - a;
      const tx = days.filter((d) => d.tmax != null), tn = days.filter((d) => d.tmin != null);
      out.push({
        m, days: days.length, complete,
        until: days.length ? days.at(-1).n : null,
        precip: r1(days.reduce((t, d) => t + (d.precip ?? 0), 0)),
        rain_days: days.filter((d) => (d.precip ?? 0) >= 1).length,
        tmax: tx.length ? tx.reduce((t, d) => t + d.tmax, 0) / tx.length : null,
        tmin: tn.length ? tn.reduce((t, d) => t + d.tmin, 0) / tn.length : null,
        frost_days: days.filter((d) => d.tmin != null && d.tmin < 0).length,
        et0: days.reduce((t, d) => t + (d.et0 ?? 0), 0),
        water_days: days.filter((d) => d.water).length,
        normal: ctx.normals?.months?.[m] ?? null,
      });
    }
    return out;
  }

  function monthlyChart(ctx) {
    return {
      draw(width) {
        const H = 170;
        const pw = Math.max(80, width - M.l - M.r);
        const svg = s("svg", { class: "chart", width, height: H + M.t + M.b, viewBox: `0 0 ${width} ${H + M.t + M.b}` });
        const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
        svg.append(grid, axis);
        const ms = monthStats(ctx);
        const max = Math.max(10, ...ms.map((m) => Math.max(m.precip, m.normal?.precip ?? 0)));
        const ticks = niceTicks(max);
        const y = (v) => M.t + H - (v / ticks.at(-1)) * H;
        for (const v of ticks) {
          grid.append(s("line", { x1: M.l, x2: M.l + pw, y1: y(v), y2: y(v), class: v === 0 ? "zero" : null }));
          axis.append(s("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, fmtNum(v, 0)));
        }
        axis.append(s("text", { x: M.l - 6, y: M.t - 12, "text-anchor": "end", class: "unit" }, "mm"));
        const slot = pw / 12;
        const bw = Math.min(24, slot * 0.5);
        for (const m of ms) {
          const cx = M.l + slot * (m.m + 0.5);
          axis.append(s("text", { x: cx, y: M.t + H + 17, "text-anchor": "middle" }, slot < 30 ? MONTHS_SHORT[m.m][0] : MONTHS_SHORT[m.m]));
          const g = s("g", { class: "bar-slot", tabindex: "0" });
          if (m.days) {
            const top = y(m.precip), base = y(0);
            const hgt = base - top;
            const r = Math.min(4, hgt / 2, bw / 2);
            const x0 = cx - bw / 2;
            g.append(s("path", {
              d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z`,
              fill: C.rain, "fill-opacity": m.complete ? 1 : 0.5, class: "bar",
            }));
          }
          if (m.normal) {
            const ny = y(m.normal.precip);
            g.append(s("line", { x1: cx - bw / 2 - 5, x2: cx + bw / 2 + 5, y1: ny, y2: ny, stroke: C.normal, "stroke-width": 2, "stroke-linecap": "round" }));
          }
          g.append(s("rect", { x: M.l + slot * m.m, y: M.t, width: slot, height: H + M.b, fill: "transparent" }));
          const content = () => [
            h("span", { class: "tip-date" }, `${MONTHS[m.m]} ${ctx.year}${m.days && !m.complete ? ` (bis ${fmtDay(m.until)})` : ""}`),
            m.days ? row(C.rain, `${fmtNum(m.precip, 0)} mm`, `${m.rain_days} Regentage`, "rect") : h("span", { class: "muted" }, "noch keine Werte"),
            m.normal ? row(C.normal, `${fmtNum(m.normal.precip, 0)} mm`, `im Mittel, ${fmtNum(m.normal.rain_days, 0)} Regentage`) : null,
          ];
          g.addEventListener("pointermove", (ev) => showTip(ev, content()));
          g.addEventListener("pointerdown", (ev) => showTip(ev, content()));
          g.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hideTip(); });
          g.addEventListener("focus", () => {
            const r = g.getBoundingClientRect();
            showTip({ clientX: r.right, clientY: r.top + r.height / 2 }, content());
          });
          g.addEventListener("blur", hideTip);
          svg.append(g);
        }
        return svg;
      },
    };
  }

  // ------------------------------------------------------------ Temperatur

  function temperatureChart(ctx) {
    return {
      draw(width) {
        const H = 200;
        const f = timeFrame(ctx, width, H);
        const { bal, normals, ys, len } = ctx;
        const vals = bal.flatMap((d) => [d.tmin, d.tmax]).filter((v) => v != null);
        if (normals) vals.push(...normals.daily.tmin, ...normals.daily.tmax);
        const lo = Math.min(-5, ...vals), hi = Math.max(25, ...vals);
        const step = hi - lo > 40 ? 10 : 5;
        const ticks = rangeTicks(Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step);
        const t0 = ticks[0], t1 = ticks.at(-1);
        const y = (v) => M.t + H - ((v - t0) / (t1 - t0)) * H;
        yAxis(f, ticks, y, (v) => `${v > 0 ? "" : v < 0 ? "−" : ""}${Math.abs(v)}`);
        f.axis.append(s("text", { x: M.l - 6, y: M.t - 12, "text-anchor": "end", class: "unit" }, "°C"));
        if (normals) {
          const top = [], bottom = [];
          for (let n = ys; n < ys + len; n++) {
            const i = normIndex(n);
            top.push([f.x(n), y(normals.daily.tmax[i])]);
            bottom.push([f.x(n), y(normals.daily.tmin[i])]);
          }
          const d = `M${top.map((p) => p.map((v) => v.toFixed(1)).join(",")).join("L")}L${bottom.reverse().map((p) => p.map((v) => v.toFixed(1)).join(",")).join("L")}Z`;
          f.svg.append(s("path", { d, fill: C.wash }));
        }
        const bw = Math.max(1, (f.pw / len) - (f.pw / len >= 3 ? 1 : 0.3));
        const g = s("g");
        const zero = y(0);
        for (const d of bal) {
          if (d.tmin == null || d.tmax == null) continue;
          const x0 = f.x(d.n) - bw / 2;
          const yt = y(d.tmax), yb = y(d.tmin);
          const op = d.forecast ? 0.4 : 0.85;
          if (d.tmin < 0) {
            const split = Math.min(zero, yb);
            if (d.tmax > 0) g.append(s("rect", { x: x0, y: yt, width: bw, height: Math.max(0.5, split - yt), fill: C.temp, "fill-opacity": op }));
            g.append(s("rect", { x: x0, y: Math.max(yt, zero), width: bw, height: Math.max(1, yb - Math.max(yt, zero)), fill: C.frost, "fill-opacity": op }));
          } else {
            g.append(s("rect", { x: x0, y: yt, width: bw, height: Math.max(1, yb - yt), fill: C.temp, "fill-opacity": op }));
          }
        }
        f.svg.append(g);
        this.cursor = hoverLayer(ctx, f, (n) => {
          const d = ctx.byDay.get(n);
          const i = normIndex(n);
          if (!d && !normals) return null;
          return [dateLine(n, d?.forecast),
            d?.tmin != null ? row(d.tmin < 0 ? C.frost : C.temp, `${fmtNum(d.tmin, 0)} bis ${fmtNum(d.tmax, 0)} °C`, d.tmin < 0 ? "Frost" : "", "rect") : null,
            normals ? row(C.normal, `${fmtNum(normals.daily.tmin[i], 0)} bis ${fmtNum(normals.daily.tmax[i], 0)} °C`, "im Mittel", "wash") : null];
        });
        return f.svg;
      },
    };
  }

  // ------------------------------------------------------------ Wasserbilanz

  function waterChart(ctx) {
    return {
      draw(width) {
        const H = 150;
        const f = timeFrame(ctx, width, H);
        const soil = soilOf();
        const ticks = niceTicks(soil.nfk, 3);
        const y = (v) => M.t + H - (v / ticks.at(-1)) * H;
        yAxis(f, ticks, y, (v) => fmtNum(v, 0));
        f.axis.append(s("text", { x: M.l - 6, y: M.t - 12, "text-anchor": "end", class: "unit" }, "mm"));
        const ty = y(soil.threshold);
        f.svg.append(s("line", { x1: M.l, x2: M.l + f.pw, y1: ty, y2: ty, stroke: C.normal, "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
        f.svg.append(s("text", { x: M.l + f.pw + 8, y: ty + 4, class: "end-label" }, `Gießen ab ${fmtNum(soil.threshold, 0)}`));
        const path = (list) => list.map((d, i) => `${i ? "L" : "M"}${f.x(d.n).toFixed(1)},${y(d.deficit).toFixed(1)}`).join("");
        const { obs, fc } = ctx;
        if (obs.length) f.svg.append(s("path", { d: path(obs), class: "line", stroke: C.water }));
        if (fc.length) f.svg.append(s("path", { d: path([obs.at(-1), ...fc].filter(Boolean)), class: "line forecast", stroke: C.water }));
        for (const d of ctx.bal) {
          if (!d.water) continue;
          f.svg.append(s("circle", { cx: f.x(d.n), cy: y(d.deficit), r: 4, fill: C.water, class: "end-dot", "fill-opacity": d.forecast ? 0.5 : 1 }));
        }
        this.cursor = hoverLayer(ctx, f, (n) => {
          const d = ctx.byDay.get(n);
          if (!d) return null;
          return [dateLine(n, d.forecast),
            row(C.water, `${fmtNum(d.deficit, 0)} mm`, "Defizit"),
            h("span", { class: "muted" }, `Regen ${fmtNum(d.precip ?? 0)} mm, Verdunstung ${fmtNum(d.et0 ?? 0)} mm`),
            d.water ? h("strong", { class: "wx-tip-water" }, `Gießtag: etwa ${fmtNum(soil.refill, 0)} l/m²`) : null];
        });
        return f.svg;
      },
    };
  }

  // ------------------------------------------------------------ Frost je Jahr

  function frostChart(ctx) {
    return {
      draw(width) {
        const fr = ctx.frost;
        const rows = fr.per_year.map((r) => ({ year: r.year, spring: r.spring, autumn: r.autumn, done: true }));
        // laufendes Jahr aus den Wetterdaten, soweit schon bekannt
        if (ctx.year === yearOf(ctx.today) && ctx.obs.length) {
          const frosts = ctx.obs.filter((d) => d.tmin != null && d.tmin <= fr.threshold);
          const sp = frosts.filter((d) => new Date(d.n * 86400000).getUTCMonth() <= 6).at(-1);
          const au = frosts.find((d) => new Date(d.n * 86400000).getUTCMonth() >= 7);
          rows.push({ year: ctx.year, spring: sp ? isoOf(sp.n) : null, autumn: au ? isoOf(au.n) : null, done: false, until: ctx.obs.at(-1).n });
        }
        const RH = 16;
        const H = rows.length * RH;
        const ref = { year: 2001, ys: dayNum("2001-01-01"), len: 365 };
        const f = timeFrame(ref, width, H);
        const pos = (iso) => f.x(dayNum(`2001-${iso.slice(5)}`));
        rows.forEach((r, i) => {
          const cy = M.t + i * RH + RH / 2;
          f.axis.append(s("text", { x: M.l - 6, y: cy + 4, "text-anchor": "end", class: r.done ? null : "current" }, String(r.year)));
          const x0 = r.spring ? pos(r.spring) : M.l;
          const x1 = r.autumn ? pos(r.autumn) : r.done ? M.l + f.pw : f.x(dayNum(`2001-${isoOf(r.until).slice(5)}`));
          const g = s("g", { class: "frost-row", tabindex: "0" });
          g.append(s("rect", { x: x0, y: cy - 3, width: Math.max(0, x1 - x0), height: 6, rx: 3, fill: C.free, "fill-opacity": r.done ? 0.85 : 0.45 }));
          if (r.spring) g.append(s("circle", { cx: x0, cy, r: 4, fill: C.frost, class: "end-dot" }));
          if (r.autumn) g.append(s("circle", { cx: x1, cy, r: 4, fill: C.frost, class: "end-dot" }));
          g.append(s("rect", { x: M.l, y: cy - RH / 2, width: f.pw, height: RH, fill: "transparent" }));
          const days = r.spring && r.autumn ? (dayNum(r.autumn) - dayNum(r.spring) - 1) : null;
          const content = () => [
            h("span", { class: "tip-date" }, `${r.year}${r.done ? "" : " (bisher)"}`),
            row(C.frost, r.spring ? fmtDay(dayNum(r.spring)) : "kein Frost", "letzter Frost im Frühjahr", "dot"),
            row(C.frost, r.autumn ? fmtDay(dayNum(r.autumn)) : r.done ? "kein Frost bis Jahresende" : "noch keiner", "erster Frost im Herbst", "dot"),
            days != null ? row(C.free, `${days} Tage`, "frostfrei", "rect") : null];
          g.addEventListener("pointermove", (ev) => showTip(ev, content()));
          g.addEventListener("pointerdown", (ev) => showTip(ev, content()));
          g.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hideTip(); });
          g.addEventListener("focus", () => { const b = g.getBoundingClientRect(); showTip({ clientX: b.left + b.width / 2, clientY: b.top }, content()); });
          g.addEventListener("blur", hideTip);
          f.svg.append(g);
        });
        for (const [mmdd, text] of [[fr.stats.spring_median, "Mitte letzter Frost"], [fr.stats.autumn_median, "Mitte erster Frost"]]) {
          if (!mmdd) continue;
          const x = f.x(dayNum(`2001-${mmdd}`));
          f.grid.append(s("line", { x1: x, x2: x, y1: M.t - 4, y2: M.t + H, stroke: C.frost, "stroke-width": 1.5, "stroke-dasharray": "4 3", class: "median" }));
          f.svg.append(s("text", { x, y: M.t + H + 17, "text-anchor": "middle", class: "median-label" }, fmtDay(dayNum(`2001-${mmdd}`))));
        }
        // Monatsbeschriftung würde mit den Medianen kollidieren: nur die Medianwerte unten zeigen
        f.axis.querySelectorAll("text").forEach((t) => { if (!/^\d{4}$/.test(t.textContent)) t.remove(); });
        for (let m = 0; m < 12; m++) {
          const a = Math.floor(Date.UTC(2001, m, 1) / 86400000);
          const xx = f.x(a) + (f.pw / 365) * 15;
          f.axis.append(s("text", { x: xx, y: M.t - 2, "text-anchor": "middle" }, f.pw / 12 < 30 ? MONTHS_SHORT[m][0] : MONTHS_SHORT[m]));
        }
        f.svg.setAttribute("height", H + M.t + M.b + 8);
        f.svg.setAttribute("viewBox", `0 -8 ${width} ${H + M.t + M.b + 8}`);
        return f.svg;
      },
    };
  }

  // ------------------------------------------------------------ Tabellen

  // Mittlerer Regen vom Monatsanfang bis zu einem Tag (für angebrochene Monate)
  function normalRain(ctx, month, until) {
    const cum = ctx.normals?.daily?.precip_cum;
    if (!cum) return null;
    const first = Math.floor(Date.UTC(ctx.year, month, 1) / 86400000);
    const before = normIndex(first) - 1;
    return cum[normIndex(until)] - (before >= 0 ? cum[before] : 0);
  }

  function monthTable(ctx) {
    const ms = monthStats(ctx);
    const v = (x, digits = 0, unit = "") => (x == null ? h("span", { class: "muted" }, "–") : `${fmtNum(x, digits)}${unit}`);
    const withNorm = (val, norm, digits = 0, unit = "") => h("span", {},
      val, norm != null ? h("span", { class: "norm" }, ` (${fmtNum(norm, digits)}${unit})`) : null);
    const body = ms.map((m) => {
      const has = m.days > 0;
      const n = m.normal;
      return h("tr", { class: has ? null : "future" },
        h("th", { scope: "row" }, MONTHS[m.m], has && !m.complete ? h("span", { class: "norm" }, ` bis ${fmtDay(m.until)}`) : null),
        h("td", { class: "r" }, withNorm(has ? v(m.precip) : v(null), n?.precip)),
        h("td", { class: "r" }, has && n?.precip ? signed(pct(m.precip, m.complete ? n.precip : normalRain(ctx, m.m, m.until)), " %") : v(null)),
        h("td", { class: "r" }, withNorm(has ? v(m.rain_days) : v(null), n?.rain_days)),
        h("td", { class: "r" }, withNorm(has ? v(m.tmax, 1, "°") : v(null), n?.tmax, 1, "°")),
        h("td", { class: "r" }, withNorm(has ? v(m.tmin, 1, "°") : v(null), n?.tmin, 1, "°")),
        h("td", { class: "r" }, withNorm(has ? v(m.frost_days) : v(null), n?.frost_days)),
        h("td", { class: "r" }, withNorm(has ? v(m.et0) : v(null), n?.et0)),
        h("td", { class: "r" }, has ? v(m.water_days) : v(null)));
    });
    const obsMonths = ms.filter((m) => m.days);
    const fullYear = ms.every((m) => m.complete);
    const tot = (k) => (k === "precip"
      ? r1(ctx.obs.reduce((t, d) => t + (d.precip ?? 0), 0))
      : r1(obsMonths.reduce((t, m) => t + m[k], 0)));
    // Mittel für denselben Zeitraum: volle Monate ganz, den angebrochenen anteilig
    const ntot = (k) => {
      if (!ctx.normals) return null;
      if (k === "precip") return ctx.normals.daily.precip_cum[normIndex(ctx.obs.at(-1).n)];
      return obsMonths.reduce((t, m) => {
        const n = ctx.normals.months[m.m][k];
        if (m.complete) return t + n;
        if (k === "precip") return t + (normalRain(ctx, m.m, m.until) ?? 0);
        const daysIn = new Date(Date.UTC(ctx.year, m.m + 1, 0)).getUTCDate();
        return t + (n * m.days) / daysIn;
      }, 0);
    };
    const foot = obsMonths.length ? h("tr", { class: "total" },
      h("th", { scope: "row" }, fullYear ? "Jahr" : `Jahr bis ${fmtDay(obsMonths.at(-1).until)}`),
      h("td", { class: "r" }, withNorm(v(tot("precip")), ntot("precip"))),
      h("td", { class: "r" }, ""),
      h("td", { class: "r" }, withNorm(v(tot("rain_days")), ntot("rain_days"))),
      h("td", { class: "r" }, ""), h("td", { class: "r" }, ""),
      h("td", { class: "r" }, withNorm(v(tot("frost_days")), ntot("frost_days"))),
      h("td", { class: "r" }, withNorm(v(tot("et0")), ntot("et0"))),
      h("td", { class: "r" }, v(tot("water_days")))) : null;
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, `Monatswerte ${ctx.year}`),
        ctx.normals ? h("span", { class: "muted small" }, `in Klammern das Mittel ${ctx.nYears}`) : null),
      h("div", { class: "table-wrap" }, h("table", { class: "data wx-table" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Monat"), h("th", { class: "r" }, "Regen mm"), h("th", { class: "r" }, "Abweichung"),
          h("th", { class: "r", title: "Tage mit mindestens 1 mm" }, "Regentage"), h("th", { class: "r" }, "Ø Höchst"),
          h("th", { class: "r" }, "Ø Tiefst"), h("th", { class: "r", title: "Tiefstwert unter 0 °C" }, "Frosttage"),
          h("th", { class: "r" }, "Verdunstung mm"), h("th", { class: "r" }, "Gießtage"))),
        h("tbody", {}, body), foot ? h("tfoot", {}, foot) : null)));
  }

  function forecastTable(ctx) {
    const soil = soilOf();
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, "Die nächsten Tage"), h("span", { class: "muted small" }, "Vorhersage, wird alle drei Stunden aktualisiert")),
      h("div", { class: "table-wrap" }, h("table", { class: "data wx-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Tag"), h("th", { class: "r" }, "Tiefst"), h("th", { class: "r" }, "Höchst"),
          h("th", { class: "r" }, "Regen mm"), h("th", { class: "r" }, "Verdunstung mm"), h("th", {}, "Hinweis"))),
        h("tbody", {}, ctx.fc.map((d) => {
          const notes = [];
          if (d.tmin != null && d.tmin < 0) notes.push(h("span", { class: "pill frost" }, "Frost"));
          if (d.water) notes.push(h("span", { class: "pill water" }, `gießen, etwa ${fmtNum(soil.refill, 0)} l/m²`));
          if ((d.precip ?? 0) >= 10) notes.push(h("span", { class: "pill rain" }, "viel Regen"));
          const dt = new Date(d.n * 86400000);
          return h("tr", { class: d.n === ctx.today ? "today" : null },
            h("th", { scope: "row" }, `${WEEKDAY[dt.getUTCDay()]}, ${fmtDay(d.n)}`),
            h("td", { class: "r" }, d.tmin != null ? `${fmtNum(d.tmin, 0)}°` : "–"),
            h("td", { class: "r" }, d.tmax != null ? `${fmtNum(d.tmax, 0)}°` : "–"),
            h("td", { class: "r" }, fmtNum(d.precip ?? 0)),
            h("td", { class: "r" }, d.et0 != null ? fmtNum(d.et0) : "–"),
            h("td", {}, notes));
        })))));
  }

  // ------------------------------------------------------------ Größe und Lebenszyklus

  const ro = new ResizeObserver(() => {
    if (Math.abs(inner.clientWidth - lastWidth) > 2) drawCharts();
  });
  ro.observe(inner);
  const offTip = (ev) => { if (!tip.hidden && !ev.target.closest?.(".chart")) hideTip(); };
  document.addEventListener("pointerdown", offTip, true);
  page.addEventListener("scroll", hideTip, { passive: true });

  render();
  return {
    update() { rerender(); },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", offTip, true);
      hideTip();
    },
  };
}
