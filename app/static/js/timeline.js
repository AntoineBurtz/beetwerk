// Zeitleiste: jede Zeile ein Beet, jeder Balken ein Satz mit Anzucht, Kultur und Ernte.
// Sätze eines Ernteziels stehen als eine Satzfolge in einer Spur. Erster Klick markiert, zweiter öffnet die Übersicht.
import { state, find, select, patch, remove, setDay, issuesOf, mark, patchMany } from "./store.js";
import {
  h, phases, mix, textOn, clamp, fmtDay, fmtNum, isoOf, yearOf, yearStart, isoWeek, plural,
  MONTHS, MONTHS_SHORT, PLANTABLE, KIND_LABEL, spanOf, todayNum, dayNum, isMixed, varietyText, monthStarts,
} from "./util.js";
import { openPlantingEditor, openBedEditor, firstFreeStart, openSettings } from "./editor.js";
import { iconBtn, icon, confirmDialog, replaceKeepingFocus } from "./ui.js";
import { bedSummary, bedUsage } from "./bedpanel.js";
import { openPlantingOverview, openGoalOverview, plantingStatus } from "./overview.js";
import { bulkBar, markedPlantings } from "./bulk.js";
import { openGoalEditor } from "./goals.js";
import { weatherSpan, weatherBand, weatherEnabled, frostFor, frostSpan, frostOverlay, WX_H } from "./weather.js";

const ZOOMS = [1.3, 2, 3, 4.6, 7, 11];
let zoomIdx = 2;
let lastScroll = null; // { year, left, top }
let anchorYear = null; // erstes gezeigtes Jahr, bleibt stehen, solange der Stichtag im Bereich liegt
const HEAD_H = 46;
const DAY_MS = 86400000;

// Wie viel die Zeitleiste zeigt: immer ab Januar, auf Wunsch bis ins Folgejahr
const SPANS = [
  [12, "1 Jahr", "Das Jahr des Stichtags"],
  [18, "1½ Jahre", "Dazu das erste Halbjahr des Folgejahres"],
  [24, "2 Jahre", "Dazu das ganze Folgejahr"],
];

function wxVisible() {
  try { return localStorage.getItem("beetwerk.wx") !== "0"; } catch { return true; }
}

function spanMonths() {
  try {
    const v = Number(localStorage.getItem("beetwerk.tlSpan"));
    return SPANS.some(([m]) => m === v) ? v : 12;
  } catch { return 12; }
}

const rangeEnd = (year, months) => Math.floor(Date.UTC(year, months, 1) / DAY_MS);

const LANE_H = 26;
const ROW_PAD = 5;

export function mountTimeline(root) {
  const zoomLabel = h("span", { class: "muted small num tl-zoom-label", style: { minWidth: "70px" } });
  const wxToggle = h("button", { type: "button", class: "btn btn-sm btn-quiet wx-toggle", title: "Wetterband ein- oder ausblenden",
    onclick: () => {
      const on = !wxVisible();
      try { localStorage.setItem("beetwerk.wx", on ? "1" : "0"); } catch { /* nur für diese Sitzung */ }
      render();
    } }, icon("drop"), h("span", { class: "lbl" }, "Wetter"));
  // Zeitraum: Umschalter, auf dem Handy als Auswahlliste
  let sessionSpan = spanMonths();
  const setSpan = (months) => {
    try { localStorage.setItem("beetwerk.tlSpan", String(months)); } catch { /* nur für diese Sitzung */ }
    sessionSpan = months;
    render();
  };
  const spanSeg = h("div", { class: "seg seg-sm tl-span", role: "radiogroup", "aria-label": "Zeitraum" },
    SPANS.map(([months, label, title]) => {
      const input = h("input", { type: "radio", name: "tl-span", value: months, checked: months === sessionSpan });
      input.addEventListener("change", () => setSpan(months));
      return h("label", { title }, input, label);
    }));
  const spanSelect = h("select", { class: "input tl-span-select", "aria-label": "Zeitraum" },
    SPANS.map(([months, label]) => h("option", { value: months, selected: months === sessionSpan }, label)));
  spanSelect.addEventListener("change", () => setSpan(Number(spanSelect.value)));
  const toolbar = h("div", { class: "toolbar" },
    iconBtn("minus", "Zeitachse stauchen", () => setZoom(zoomIdx - 1)),
    iconBtn("plus", "Zeitachse strecken", () => setZoom(zoomIdx + 1)),
    zoomLabel,
    spanSeg,
    spanSelect,
    wxToggle,
    h("div", { class: "legend", "aria-hidden": "true" },
      h("span", {}, h("i", { class: "l-nursery" }), "Anzucht"),
      h("span", {}, h("i", { class: "l-field" }), "im Beet"),
      h("span", {}, h("i", { class: "l-harvest" }), "Ernte")),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => openPlantingEditor(null, { anchor: state.day }) }, "Neuer Satz"),
  );
  const scroll = h("div", { class: "tl-scroll" });
  const side = h("aside", { class: "panel tl-panel", "aria-label": "Beet bearbeiten", hidden: true });
  const selbar = h("div", { class: "tl-selbar", role: "status", hidden: true });
  const el = h("div", { class: "tlview" }, toolbar, h("div", { class: "tl-main" }, scroll, side, selbar));
  root.append(el);

  // Markierung: ein Satz (state.sel, wie auf der Karte), eine Satzfolge (nur hier, als Ernteziel-ID)
  // oder mehrere Sätze (state.marked, mit Strg/Umschalt oder nach „Mehrere“) zum gemeinsamen Ändern
  let seriesSel = null;
  let multiMode = false; // nach „Mehrere“: jeder Klick schaltet einen Satz dazu oder weg
  const goalOf = (id) => (state.goals || []).find((g) => g.id === id);
  const isMarked = (p) => (state.sel?.type === "planting" && state.sel.id === p.id) || state.marked.has(p.id);

  function markSeries(id) {
    seriesSel = id;
    state.marked.clear();
    if (state.sel) select(null); else { render(); renderSel(); }
  }

  function clearMarks() {
    const had = seriesSel != null || state.marked.size > 0;
    seriesSel = null;
    multiMode = false;
    state.marked.clear();
    if (state.sel) select(null); else if (had) { render(); renderSel(); }
  }

  // Sätze zur Mehrfachauswahl dazu oder weg; die bisherige Einzelmarkierung kommt mit hinein
  function toggleMulti(ids) {
    if (!state.marked.size) {
      if (state.sel?.type === "planting") state.marked.add(state.sel.id);
      if (seriesSel != null) {
        for (const el of scroll.querySelectorAll(`.bar.series[data-goal="${seriesSel}"]`)) {
          for (const id of el.dataset.members.split(",")) state.marked.add(Number(id));
        }
      }
    }
    seriesSel = null;
    if (state.sel?.type === "planting") state.sel = null;
    mark(ids);
    if (!state.marked.size) multiMode = false;
  }

  // Leiste unten: was markiert ist, mit „Details“ – auf dem Handy der zweite Weg zur Übersicht
  function renderSel() {
    if (state.marked.size) {
      selbar.hidden = false;
      selbar.classList.add("multi");
      selbar.replaceChildren(...bulkBar(markedPlantings()));
      return;
    }
    selbar.classList.remove("multi");
    const p = state.sel?.type === "planting" ? find.planting(state.sel.id) : null;
    const goal = !p && seriesSel != null ? goalOf(seriesSel) : null;
    if (!goal) seriesSel = null;
    if (!p && !goal) { selbar.hidden = true; selbar.replaceChildren(); return; }
    const crop = find.crop((p || goal).crop_id);
    const variety = p ? varietyText(p) : goal.variety;
    const members = goal ? state.plantings.filter((q) => q.goal_id === goal.id) : [];
    const sub = p
      ? `${find.bed(p.bed_id)?.name ?? "Ohne Beet"} · ${plantingStatus(p)}`
      : `Ernteziel ${fmtNum(goal.amount)} ${goal.unit} je Woche · ${plural(members.length, "Satz", "Sätze")}`;
    const grouped = p?.goal_id && state.seriesOpen.has(p.goal_id);
    selbar.hidden = false;
    selbar.replaceChildren(...[
      h("span", { class: "dot", style: { background: crop?.color } }),
      h("span", { class: "tl-selbar-text" },
        h("strong", {}, `${crop?.name ?? "Kultur"}${variety ? ` ${variety}` : ""}`),
        h("span", { class: "muted small" }, sub)),
      grouped ? h("button", { type: "button", class: "btn btn-sm btn-quiet", title: "Die Sätze dieses Ernteziels wieder in einer Zeile zeigen",
        onclick: () => { state.seriesOpen.delete(p.goal_id); render(); renderSel(); } }, "Zusammenfassen") : null,
      h("button", { type: "button", class: "btn btn-sm btn-quiet", title: "Weitere Sätze dazu markieren, um sie gemeinsam zu ändern oder zu löschen (am Rechner auch mit Strg- oder Umschalt-Klick)",
        onclick: () => { multiMode = true; toggleMulti([]); } }, "Mehrere"),
      h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => (p ? openPlantingOverview(p) : openGoalOverview(goal)) }, "Details"),
      iconBtn("close", "Markierung aufheben", clearMarks)].filter(Boolean));
  }

  function onKey(e) {
    if (e.key !== "Escape" || (seriesSel == null && !state.marked.size) || state.sel || document.querySelector("dialog[open]")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    clearMarks();
  }
  document.addEventListener("keydown", onKey);

  // Seitenleiste mit den Eigenschaften des gewählten Beets
  function renderSide() {
    const bed = state.sel?.type === "bed" ? find.bed(state.sel.id) : null;
    side.hidden = !bed;
    if (!bed) { side.replaceChildren(); return; }
    replaceKeepingFocus(side, [
      bedSummary(bed, {
        onClose: () => select(null),
        actions: [
          h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => openBedEditor(bed), title: "Name, Größe, Lage und Notizen ändern" }, icon("edit"), "Bearbeiten"),
          PLANTABLE.has(bed.kind) ? h("button", { type: "button", class: "btn btn-sm", title: "Folgesätze aus der Erntemenge je Woche, als Block auf diesem Beet",
            onclick: () => openGoalEditor(null, { year: yearOf(state.day), bed_id: bed.id }) }, "Satzweise anbauen") : null,
          h("button", { type: "button", class: "btn btn-sm", onclick: () => { location.hash = "karte"; } }, "Auf der Karte zeigen"),
          h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => deleteBed(bed) }, icon("trash"), "Löschen"),
        ],
      }),
      ...bedUsage(bed, { onPlanting: (p) => openPlantingOverview(p) }),
    ]);
  }

  async function deleteBed(bed) {
    const count = state.plantings.filter((p) => p.bed_id === bed.id).length;
    const ok = await confirmDialog(count
      ? `${bed.name} wird gelöscht. Die ${count} Sätze darin bleiben erhalten und stehen danach unter „Ohne Beet“.`
      : `${bed.name} wird gelöscht.`, { title: "Beet löschen?" });
    if (ok) await remove("beds", bed.id, { undoLabel: `${bed.name} gelöscht` });
  }

  let geo = null; // aktuelle Geometrie: { year, years, ys, len, ppd, labelW }
  let band = null; // Wetterband, solange sichtbar
  const onWeather = () => { if (!drag) render(); };
  let drag = null;
  let frame = 0;

  function setZoom(i) {
    const ni = clamp(i, 0, ZOOMS.length - 1);
    if (ni === zoomIdx || !geo) return;
    // Mitte des sichtbaren Bereichs festhalten
    const centerDay = (scroll.scrollLeft + (scroll.clientWidth - geo.labelW) / 2) / geo.ppd;
    zoomIdx = ni;
    render();
    scroll.scrollLeft = centerDay * geo.ppd - (scroll.clientWidth - geo.labelW) / 2;
  }

  function labelWidth() { return window.innerWidth < 760 ? 96 : 156; }

  function render() {
    const months = sessionSpan;
    if (anchorYear == null || state.day < yearStart(anchorYear) || state.day >= rangeEnd(anchorYear, months)) anchorYear = yearOf(state.day);
    const year = anchorYear;
    const ys = yearStart(year);
    const len = rangeEnd(year, months) - ys;
    const years = Array.from({ length: Math.ceil(months / 12) }, (_, i) => year + i);
    const ppd = ZOOMS[zoomIdx];
    const labelW = labelWidth();
    const prevYear = geo?.year;
    geo = { year, years, ys, len, ppd, labelW };
    for (const input of spanSeg.querySelectorAll("input")) input.checked = Number(input.value) === months;
    spanSelect.value = String(months);
    zoomLabel.textContent = ppd >= 4.6 ? "Wochen" : ppd >= 2 ? "Monate" : "Jahr";

    const keep = { left: scroll.scrollLeft, top: scroll.scrollTop };
    const width = labelW + len * ppd;
    const grid = h("div", { class: "tl-grid", style: { width: `${width}px` } });

    // Kopf mit Monaten und Kalenderwochen
    const scale = h("div", { class: "tl-scale", style: { width: `${len * ppd}px` } });
    const multi = years.length > 1;
    for (const { day, year: y, month } of monthStarts(ys, len)) {
      const a = day - ys;
      const b = Math.floor(Date.UTC(y, month + 1, 1) / DAY_MS) - ys;
      const w = (b - a) * ppd;
      // Im Januar steht bei mehreren Jahren die Jahreszahl dabei
      const text = multi && month === 0
        ? (w > 96 ? `${MONTHS[0]} ${y}` : w > 62 ? `Jan ${y}` : String(y))
        : w > 70 ? MONTHS[month] : MONTHS_SHORT[month];
      scale.append(h("div", { class: `tl-month${multi && month === 0 && a > 0 ? " ystart" : ""}`, style: { left: `${a * ppd}px`, width: `${w}px` } }, text));
    }
    const firstMonday = ys + ((8 - new Date(ys * 86400000).getUTCDay()) % 7);
    const weekW = 7 * ppd;
    for (let d = firstMonday; d < ys + len; d += 7) {
      const showNum = weekW >= 16 || isoWeek(d) % 2 === 1;
      scale.append(h("div", { class: "tl-week", style: { left: `${(d - ys) * ppd}px`, width: `${weekW}px`, borderLeftColor: weekW < 12 ? "transparent" : null } },
        showNum && weekW >= 9 ? String(isoWeek(d)) : ""));
    }
    const dayX = (state.day - ys + 0.5) * ppd;
    scale.append(h("div", { class: "tl-day-tag", style: { position: "absolute", left: `${dayX}px`, top: 0 } },
      h("span", { title: "Stichtag verschieben" }, fmtDay(state.day))));
    scale.addEventListener("pointerdown", onScaleDown);

    // Wetterband unter dem Kalenderkopf, bleibt beim Scrollen stehen
    band?.hide();
    band = null;
    wxToggle.hidden = !weatherEnabled();
    wxToggle.setAttribute("aria-pressed", String(wxVisible()));
    const fm = weatherEnabled() ? frostSpan(frostFor(onWeather), years) : null;
    if (weatherEnabled() && wxVisible()) {
      band = weatherBand(geo, weatherSpan(years, onWeather), { onSettings: () => openSettings(), frost: fm });
    }
    grid.style.setProperty("--head-h", `${HEAD_H + (band ? WX_H + 1 : 0)}px`);
    grid.append(h("div", { class: "tl-head" },
      h("div", { class: "tl-head-row" },
        h("div", { class: "tl-corner", style: { width: `${labelW}px` } }, multi ? `${year}–${String(years.at(-1)).slice(2)}` : String(year)), scale),
      band?.row));

    // Hintergrundlinien
    const bg = h("div", { class: "tl-bg", style: { left: `${labelW}px`, width: `${len * ppd}px` } });
    for (const { day, month } of monthStarts(ys + 1, len - 1)) {
      bg.append(h("div", { class: `mline${month === 0 ? " yline" : ""}`, style: { left: `${(day - ys) * ppd}px` } }));
    }
    if (weekW >= 16) for (let d = firstMonday; d < ys + len; d += 7) bg.append(h("div", { class: "wline", style: { left: `${(d - ys) * ppd}px` } }));
    if (fm) bg.prepend(frostOverlay(geo, fm));
    grid.append(bg);

    // Zeilen
    const beds = state.beds.filter((b) => PLANTABLE.has(b.kind)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"));
    const inRange = (p) => { const ph = phases(p); return ph.sow < ys + len && ph.he >= ys; };
    for (const bed of beds) grid.append(row(bed, state.plantings.filter((p) => p.bed_id === bed.id && inRange(p))));
    const loose = state.plantings.filter((p) => (p.bed_id == null || !find.bed(p.bed_id) || !PLANTABLE.has(find.bed(p.bed_id).kind)) && inRange(p));
    if (loose.length || !beds.length) grid.append(row(null, loose));

    // Heute und Stichtag
    const today = todayNum();
    if (today >= ys && today < ys + len) grid.append(h("div", { class: "tl-now", style: { left: `${labelW + (today - ys + 0.5) * ppd}px` }, title: "Heute" }));
    grid.append(h("div", { class: "tl-day", style: { left: `${labelW + dayX}px` } }));

    scroll.replaceChildren(grid);
    bars = [...grid.querySelectorAll(".bar")].map((b) => ({ b, label: b.querySelector(".bar-label"),
      left: Number(b.dataset.left), fx: Number(b.dataset.fx), width: parseFloat(b.style.width) }));

    if (prevYear === year) {
      scroll.scrollLeft = keep.left;
      scroll.scrollTop = keep.top;
    } else if (lastScroll && lastScroll.year === year && prevYear === undefined) {
      scroll.scrollLeft = lastScroll.left;
      scroll.scrollTop = lastScroll.top;
    } else {
      scroll.scrollLeft = Math.max(0, dayX - (scroll.clientWidth - labelW) * 0.35);
    }
    placeLabels();
  }

  // Beschriftungen bleiben am linken Rand sichtbar, wenn der Balken angeschnitten ist
  let bars = [];
  let labelFrame = 0;
  function placeLabels() {
    const s0 = scroll.scrollLeft;
    for (const it of bars) {
      if (!it.label) continue;
      const want = Math.max(it.fx, s0 - it.left + 4);
      it.label.style.left = `${Math.min(want, Math.max(it.fx, it.width - 60))}px`;
    }
  }
  scroll.addEventListener("scroll", () => {
    if (labelFrame) return;
    labelFrame = requestAnimationFrame(() => { labelFrame = 0; placeLabels(); });
  }, { passive: true });

  function row(bed, plantings) {
    // Sätze eines Ernteziels als eine Satzfolge zusammenfassen, wenn mehrere in dieser Zeile stehen
    const byGoal = new Map();
    for (const p of plantings) {
      if (p.goal_id == null || state.seriesOpen.has(p.goal_id) || !goalOf(p.goal_id)) continue;
      byGoal.set(p.goal_id, [...(byGoal.get(p.goal_id) || []), p]);
    }
    const items = [];
    for (const p of plantings) if (!(byGoal.get(p.goal_id)?.length > 1)) items.push({ p, ph: phases(p) });
    for (const [id, ps] of byGoal) {
      if (ps.length < 2) continue;
      const members = ps.map((p) => ({ p, ph: phases(p) })).sort((a, b) => a.ph.sow - b.ph.sow || a.p.id - b.p.id);
      items.push({ series: { goal: goalOf(id), members },
        ph: { sow: members[0].ph.sow, he: Math.max(...members.map((m) => m.ph.he)) } });
    }
    items.sort((a, b) => a.ph.sow - b.ph.sow);
    // Spuren vergeben, damit sich Balken nicht überdecken
    const laneEnds = [];
    for (const it of items) {
      let lane = laneEnds.findIndex((end) => end < it.ph.sow);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = it.ph.he;
      it.lane = lane;
    }
    const lanes = Math.max(1, laneEnds.length);
    const height = lanes * LANE_H + ROW_PAD * 2;
    const track = h("div", { class: "tl-track", style: { width: `${geo.len * geo.ppd}px`, height: `${height}px`, overflow: "hidden" } });
    for (const it of items) track.append(it.series ? seriesBar(it.series, it.ph, it.lane) : bar(it.p, it.ph, it.lane, bed));
    track.addEventListener("click", (e) => {
      if (e.target !== track) return;
      // Ist etwas markiert, hebt ein Klick daneben nur die Markierung auf
      if (state.sel?.type === "planting" || seriesSel != null || state.marked.size) { clearMarks(); return; }
      const day = geo.ys + Math.floor((e.clientX - track.getBoundingClientRect().left) / geo.ppd);
      openPlantingEditor(null, { bed_id: bed?.id ?? null, anchor: day });
    });
    const labelText = bed ? bed.name : "Ohne Beet";
    const selected = !!bed && state.sel?.type === "bed" && state.sel.id === bed.id;
    const label = h("div", { class: "tl-label", style: { width: `${geo.labelW}px` } },
      bed
        ? h("button", { type: "button", title: `${labelText} bearbeiten`, "aria-pressed": selected ? "true" : "false",
          onclick: () => select(selected ? null : { type: "bed", id: bed.id }) }, labelText)
        : h("span", { class: "muted" }, labelText),
      bed ? h("span", { class: "muted small", style: { display: "block", fontWeight: 400 } },
        `${bed.kind !== "bed" ? KIND_LABEL[bed.kind] + ", " : ""}${fmtNum(bed.length, 2)} × ${fmtNum(bed.width, 2)} m`) : null);
    return h("div", { class: `tl-row${selected ? " selected" : ""}`, "data-bed": bed ? bed.id : "" }, label, track);
  }

  function bar(p, ph, lane, bed) {
    const crop = find.crop(p.crop_id);
    const color = crop?.color || "#6a9b3c";
    const { ys, ppd } = geo;
    const issues = issuesOf(p.id);
    const conflict = issues.some((i) => i.kind === "conflict");
    const left = (ph.sow - ys) * ppd;
    const width = (ph.he - ph.sow + 1) * ppd;
    const fieldColor = mix(color, "#ffffff", 0.48);
    const textColor = textOn(fieldColor);
    const selected = isMarked(p);
    const el = h("div", {
      class: `bar${conflict ? " conflict" : ""}${selected ? " selected" : ""}${left < 0 ? " clip-l" : ""}${left + width > geo.len * ppd ? " clip-r" : ""}`,
      style: { left: `${left}px`, width: `${Math.max(width, 3)}px`, top: `${ROW_PAD + lane * LANE_H}px` },
      "data-pid": p.id,
      title: tooltip(p, ph, crop, bed, issues) + (selected ? "\n\nNochmal klicken für die Übersicht" : ""),
    });
    if (ph.plant != null && ph.plant > ph.sow) {
      el.append(h("div", { class: "seg seg-nursery", style: { left: 0, width: `${(ph.plant - ph.sow) * ppd}px`, background: mix(color, "#ffffff", 0.2) } }));
    }
    const fx = (ph.fieldStart - ph.sow) * ppd;
    el.append(h("div", { class: "seg seg-field", style: { left: `${fx}px`, width: `${Math.max(0, (ph.hs - ph.fieldStart) * ppd)}px`, background: fieldColor } }));
    el.append(h("div", { class: "seg seg-harvest", style: { left: `${(ph.hs - ph.sow) * ppd}px`, width: `${(ph.he - ph.hs + 1) * ppd}px`, background: color } }));
    el.dataset.left = left;
    el.dataset.fx = fx;
    el.append(h("div", { class: "bar-label", style: { left: `${fx}px`, right: 0, color: textColor,
      textShadow: textColor === "#ffffff" ? "0 0 3px rgba(0,0,0,.35)" : "0 0 3px rgba(255,255,255,.7)" } },
      h("span", {}, crop?.name ?? "Kultur"), varietyText(p) ? h("span", { class: "v" }, varietyText(p)) : null));
    if (issues.length) {
      el.append(h("span", { class: `flag ${conflict ? "conflict" : "rotation"}`, style: { right: "3px", top: "3.5px" } }, "!"));
    }
    el.append(h("div", { class: "edge edge-l", "data-edge": "l" }), h("div", { class: "edge edge-r", "data-edge": "r" }));
    el.addEventListener("pointerdown", (e) => onBarDown(e, p, el));
    return el;
  }

  // Satzfolge: helle Fläche über die ganze Zeit, Erntefenster in Kulturfarbe mit Trennstrich,
  // kleine Marken, wo ein Satz ins Beet kommt (Aussaat oder Pflanzung)
  function seriesBar({ goal, members }, span, lane) {
    const crop = find.crop(goal.crop_id);
    const color = crop?.color || "#6a9b3c";
    const { ys, ppd } = geo;
    const x = (d) => (d - span.sow) * ppd;
    const left = (span.sow - ys) * ppd;
    const width = (span.he - span.sow + 1) * ppd;
    const fieldColor = mix(color, "#ffffff", 0.48);
    const textColor = textOn(fieldColor);
    const issues = members.flatMap((m) => issuesOf(m.p.id));
    const conflict = issues.some((i) => i.kind === "conflict");
    const field0 = Math.min(...members.map((m) => m.ph.fieldStart));
    const allMarked = members.every((m) => state.marked.has(m.p.id));
    const selected = seriesSel === goal.id || allMarked;
    const inside = !selected && members.some((m) => isMarked(m.p));
    const el = h("div", {
      class: `bar series${conflict ? " conflict" : ""}${selected ? " selected" : ""}${inside ? " has-selected" : ""}`
        + `${left < 0 ? " clip-l" : ""}${left + width > geo.len * ppd ? " clip-r" : ""}`,
      style: { left: `${left}px`, width: `${Math.max(width, 3)}px`, top: `${ROW_PAD + lane * LANE_H}px` },
      "data-goal": goal.id,
      "data-members": members.map((m) => m.p.id).join(","),
      title: seriesTip(goal, members, crop, issues) + (selected ? "\n\nNochmal klicken für das Ernteziel" : "\n\nKlicken markiert, zweiter Klick zeigt das Ernteziel"),
    });
    if (field0 > span.sow) el.append(h("div", { class: "sr sr-nursery", style: { left: 0, width: `${x(field0)}px`, background: mix(color, "#ffffff", 0.2) } }));
    el.append(h("div", { class: "sr sr-field", style: { left: `${x(field0)}px`, right: 0, background: fieldColor } }));
    for (const m of members) {
      el.append(h("div", { class: "sr sr-harvest", style: { left: `${x(m.ph.hs)}px`, width: `${(m.ph.he - m.ph.hs + 1) * ppd}px`, background: color } }));
    }
    members.forEach((m, i) => {
      if (i && m.ph.hs > members[i - 1].ph.hs) el.append(h("div", { class: "sr-cut", style: { left: `${x(m.ph.hs) - 1}px` } }));
      const onHarvest = members.some((o) => o !== m && m.ph.fieldStart >= o.ph.hs && m.ph.fieldStart <= o.ph.he);
      el.append(h("div", { class: `sr-tick${onHarvest ? " light" : ""}${m.p.sown_done ? " done" : ""}`, style: { left: `${x(m.ph.fieldStart) + ppd / 2 - 4}px` } }));
    });
    const fx = x(field0);
    el.dataset.left = left;
    el.dataset.fx = fx;
    el.append(h("div", { class: "bar-label", style: { left: `${fx}px`, right: 0, color: textColor,
      textShadow: textColor === "#ffffff" ? "0 0 3px rgba(0,0,0,.35)" : "0 0 3px rgba(255,255,255,.8)" } },
      h("span", {}, crop?.name ?? "Kultur"), h("span", { class: "v" }, `${goal.variety ? `${goal.variety} · ` : ""}${members.length} Sätze`)));
    if (issues.length) el.append(h("span", { class: `flag ${conflict ? "conflict" : "rotation"}`, style: { right: "3px", top: "3.5px" } }, "!"));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // Mehrfachauswahl: alle Sätze dieser Satzfolge dazu oder weg
      if (e.ctrlKey || e.metaKey || e.shiftKey || multiMode) toggleMulti(members.map((m) => m.p.id));
      else if (seriesSel === goal.id) openGoalOverview(goal);
      else markSeries(goal.id);
    });
    return el;
  }

  function seriesTip(goal, members, crop, issues) {
    const lines = [`${crop?.name ?? "Kultur"}${goal.variety ? ` ${goal.variety}` : ""} – Ernteziel ${fmtNum(goal.amount)} ${goal.unit} je Woche`,
      `${plural(members.length, "Satz", "Sätze")}, Ernte ${fmtDay(Math.min(...members.map((m) => m.ph.hs)))} bis ${fmtDay(Math.max(...members.map((m) => m.ph.he)))}`];
    for (const [i, m] of members.slice(0, 14).entries()) {
      lines.push(`${i + 1}. ${m.ph.plant != null ? `pflanzen ${fmtDay(m.ph.plant)}` : `säen ${fmtDay(m.ph.sow)}`}, Ernte ${fmtDay(m.ph.hs)} bis ${fmtDay(m.ph.he)}`);
    }
    if (members.length > 14) lines.push(`und ${members.length - 14} weitere`);
    for (const t of new Set(issues.map((i) => i.text))) lines.push(`⚠ ${t}`);
    return lines.join("\n");
  }

  function tooltip(p, ph, crop, bed, issues) {
    const lines = [`${crop?.name ?? "Kultur"}${varietyText(p) ? " " + varietyText(p) : ""}`];
    if (isMixed(p) && p.varieties.length > 1) {
      const shown = p.varieties.slice(0, 12).map((v) => `${v.name} (${v.count})`);
      if (p.varieties.length > 12) shown.push(`und ${p.varieties.length - 12} weitere`);
      lines.push(shown.join(", "));
    }
    lines.push(bed ? `${bed.name}, ${fmtNum(p.len)} × ${fmtNum(spanOf(p, bed))} m` : "Ohne Beet");
    lines.push(`Aussaat ${fmtDay(ph.sow)}${ph.plant != null ? `, Pflanzung ${fmtDay(ph.plant)}` : ""}`);
    lines.push(`Ernte ${fmtDay(ph.hs)} bis ${fmtDay(ph.he, { year: yearOf(ph.he) !== yearOf(ph.sow) })}`);
    for (const i of issues) lines.push(`⚠ ${i.text}`);
    return lines.join("\n");
  }

  // ------------------------------------------------------------ Ziehen

  function onBarDown(e, p, el) {
    if (e.button > 0) return;
    e.stopPropagation();
    const edge = e.target.dataset?.edge || null;
    drag = { p, el, edge, x0: e.clientX, y0: e.clientY, moved: false, touch: e.pointerType === "touch",
      left0: parseFloat(el.style.left), width0: parseFloat(el.style.width), dd: 0, targetRow: null,
      multi: e.ctrlKey || e.metaKey || e.shiftKey, group: null };
    // Einen von mehreren markierten Sätzen ziehen: alle wandern gemeinsam in der Zeit
    if (!edge && state.marked.size > 1 && state.marked.has(p.id)) {
      drag.group = [...scroll.querySelectorAll(".bar[data-pid]")].filter((b) => state.marked.has(Number(b.dataset.pid)))
        .map((b) => ({ el: b, left0: parseFloat(b.style.left) }));
    }
    if (!drag.touch) {
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    el.addEventListener("pointermove", onBarMove);
    el.addEventListener("pointerup", onBarUp, { once: true });
    el.addEventListener("pointercancel", onBarCancel, { once: true });
  }

  function onBarMove(e) {
    if (!drag || drag.touch) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.classList.add("dragging");
      drag.el.style.pointerEvents = "none";
    }
    const ph = phases(drag.p);
    let dd = Math.round(dx / geo.ppd);
    if (drag.group) {
      for (const g of drag.group) {
        g.el.style.left = `${g.left0 + dd * geo.ppd}px`;
        g.el.classList.add("dragging");
      }
      drag.dd = dd;
      drag.el.title = `${plural(state.marked.size, "Satz", "Sätze")} um ${plural(Math.abs(dd), "Tag", "Tage")} ${dd < 0 ? "früher" : "später"}`;
      return;
    }
    if (drag.edge === "r") {
      dd = Math.max(dd, ph.hs - ph.he);
      drag.el.style.width = `${Math.max(3, drag.width0 + dd * geo.ppd)}px`;
    } else if (drag.edge === "l") {
      dd = Math.min(dd, (ph.plant ?? ph.hs) - ph.sow - (ph.plant != null ? 1 : 0));
      drag.el.style.left = `${drag.left0 + dd * geo.ppd}px`;
      drag.el.style.width = `${Math.max(3, drag.width0 - dd * geo.ppd)}px`;
    } else {
      drag.el.style.left = `${drag.left0 + dd * geo.ppd}px`;
      // Beet wechseln durch senkrechtes Ziehen
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".tl-row");
      if (under !== drag.targetRow) {
        drag.targetRow?.classList.remove("drop-target");
        drag.targetRow = under || null;
        const own = String(drag.p.bed_id ?? "");
        if (drag.targetRow && drag.targetRow.dataset.bed !== own) drag.targetRow.classList.add("drop-target");
      }
    }
    drag.dd = dd;
    showDragDay(drag);
  }

  function showDragDay(d) {
    const ph = phases(d.p);
    const day = d.edge === "r" ? ph.he + d.dd : ph.sow + d.dd;
    d.el.title = d.edge === "r" ? `Ernte bis ${fmtDay(day)}` : d.edge === "l" ? `Aussaat ${fmtDay(day)}` : `Aussaat ${fmtDay(day)}`;
  }

  async function onBarUp() {
    const d = drag;
    drag = null;
    if (!d) return;
    d.el.removeEventListener("pointermove", onBarMove);
    d.targetRow?.classList.remove("drop-target");
    if (!d.moved) {
      if (d.multi || multiMode) { toggleMulti([d.p.id]); return; }
      if (state.marked.size) { state.marked.clear(); seriesSel = null; select({ type: "planting", id: d.p.id }); return; }
      // Erster Klick markiert, zweiter auf denselben Satz öffnet die Übersicht
      if (isMarked(d.p)) openPlantingOverview(find.planting(d.p.id));
      else { seriesSel = null; select({ type: "planting", id: d.p.id }); }
      return;
    }
    if (d.group) {
      const n = d.dd;
      if (!n) { render(); return; }
      const shift = (iso) => (iso ? isoOf(dayNum(iso) + n) : iso);
      const ids = [...state.marked];
      await patchMany("plantings", ids.map((id) => ({ id, changes: (q) => ({
        sow_date: shift(q.sow_date), plant_date: shift(q.plant_date), harvest_start: shift(q.harvest_start), harvest_end: shift(q.harvest_end),
      }) })), { undoLabel: `${plural(ids.length, "Satz", "Sätze")} um ${plural(Math.abs(n), "Tag", "Tage")} ${n < 0 ? "früher" : "später"}` });
      return;
    }
    const p = d.p;
    const crop = find.crop(p.crop_id);
    const shift = (iso, n) => (iso ? isoOf(dayNum(iso) + n) : iso);
    const changes = {};
    if (d.edge === "r") {
      changes.harvest_end = shift(p.harvest_end, d.dd);
    } else if (d.edge === "l") {
      changes.sow_date = shift(p.sow_date, d.dd);
    } else {
      if (d.dd) {
        changes.sow_date = shift(p.sow_date, d.dd);
        if (p.plant_date) changes.plant_date = shift(p.plant_date, d.dd);
        changes.harvest_start = shift(p.harvest_start, d.dd);
        changes.harvest_end = shift(p.harvest_end, d.dd);
      }
      const targetBed = d.targetRow ? (d.targetRow.dataset.bed ? Number(d.targetRow.dataset.bed) : null) : p.bed_id;
      if (d.targetRow && targetBed !== p.bed_id) {
        changes.bed_id = targetBed;
        const nb = find.bed(targetBed);
        if (nb) {
          const ph = phases({ ...p, ...changes });
          const span = p.span != null ? Math.min(p.span, nb.width) : null;
          const offset = Math.min(p.offset || 0, Math.max(0, nb.width - (span ?? 0.1)));
          const len = Math.min(p.len, nb.length);
          const x = firstFreeStart(nb, len, { offset, span, from: ph.fieldStart, to: ph.he, excludeId: p.id });
          Object.assign(changes, { start: x ?? 0, len, offset, span });
        }
      }
    }
    if (!Object.keys(changes).length) { render(); return; }
    const what = crop?.name ?? "Satz";
    const label = changes.bed_id !== undefined
      ? `${what} nach ${find.bed(changes.bed_id)?.name ?? "Ohne Beet"} verschoben`
      : d.edge ? `${what}: Termin geändert` : `${what} um ${Math.abs(d.dd)} ${Math.abs(d.dd) === 1 ? "Tag" : "Tage"} verschoben`;
    try { await patch("plantings", p.id, changes, { undoLabel: label }); } catch { render(); }
  }

  function onBarCancel() {
    if (!drag) return;
    drag.targetRow?.classList.remove("drop-target");
    drag.el.removeEventListener("pointermove", onBarMove);
    drag = null;
    render();
  }

  // Stichtag über den Kopf verschieben
  function onScaleDown(e) {
    const scale = e.currentTarget;
    const setFrom = (ev) => {
      const r = scale.getBoundingClientRect();
      const day = geo.ys + clamp(Math.floor((ev.clientX - r.left) / geo.ppd), 0, geo.len - 1);
      setDay(day);
    };
    scale.setPointerCapture(e.pointerId);
    setFrom(e);
    const move = (ev) => setFrom(ev);
    const up = () => {
      scale.removeEventListener("pointermove", move);
      scale.removeEventListener("pointerup", up);
      scale.removeEventListener("pointercancel", up);
    };
    scale.addEventListener("pointermove", move);
    scale.addEventListener("pointerup", up);
    scale.addEventListener("pointercancel", up);
  }

  // Nur Stichtag-Linie und Etikett bewegen, wenn sich sonst nichts geändert hat
  function moveDayMarker() {
    if (!geo || state.day < geo.ys || state.day >= geo.ys + geo.len) { render(); return; }
    const dayX = (state.day - geo.ys + 0.5) * geo.ppd;
    const line = scroll.querySelector(".tl-day");
    const tag = scroll.querySelector(".tl-day-tag");
    if (line) line.style.left = `${geo.labelW + dayX}px`;
    if (tag) { tag.style.left = `${dayX}px`; tag.firstChild.textContent = fmtDay(state.day); }
    band?.setDay(state.day);
    const viewLeft = scroll.scrollLeft, viewRight = viewLeft + scroll.clientWidth - geo.labelW;
    if (dayX < viewLeft + 10 || dayX > viewRight - 10) {
      scroll.scrollTo({ left: Math.max(0, dayX - (scroll.clientWidth - geo.labelW) * 0.35), behavior: "smooth" });
    }
  }

  function onResize() { if (geo && labelWidth() !== geo.labelW) render(); }
  window.addEventListener("resize", onResize);

  render();
  renderSide();
  renderSel();

  return {
    update(reason) {
      if (drag) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (state.sel) seriesSel = null;
        if (reason === "day") moveDayMarker();
        else render();
        renderSide();
        renderSel();
      });
    },
    destroy() {
      if (geo) lastScroll = { year: geo.year, left: scroll.scrollLeft, top: scroll.scrollTop };
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
      band?.hide();
    },
  };
}
