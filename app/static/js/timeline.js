// Zeitleiste: jede Zeile ein Beet, jeder Balken ein Satz mit Anzucht, Kultur und Ernte.
import { state, find, select, patch, remove, setDay, issuesOf } from "./store.js";
import {
  h, phases, mix, textOn, clamp, fmtDay, fmtNum, isoOf, yearOf, yearStart, yearLength, isoWeek,
  MONTHS, MONTHS_SHORT, PLANTABLE, KIND_LABEL, spanOf, todayNum, dayNum, isMixed, varietyText,
} from "./util.js";
import { openPlantingEditor, openBedEditor, firstFreeStart } from "./editor.js";
import { iconBtn, icon, confirmDialog, replaceKeepingFocus } from "./ui.js";
import { bedProperties, bedUsage } from "./bedpanel.js";

const ZOOMS = [1.3, 2, 3, 4.6, 7, 11];
let zoomIdx = 2;
let lastScroll = null; // { year, left, top }

const LANE_H = 26;
const ROW_PAD = 5;

export function mountTimeline(root) {
  const zoomLabel = h("span", { class: "muted small num", style: { minWidth: "70px" } });
  const toolbar = h("div", { class: "toolbar" },
    iconBtn("minus", "Zeitachse stauchen", () => setZoom(zoomIdx - 1)),
    iconBtn("plus", "Zeitachse strecken", () => setZoom(zoomIdx + 1)),
    zoomLabel,
    h("div", { class: "legend", "aria-hidden": "true" },
      h("span", {}, h("i", { class: "l-nursery" }), "Anzucht"),
      h("span", {}, h("i", { class: "l-field" }), "im Beet"),
      h("span", {}, h("i", { class: "l-harvest" }), "Ernte")),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => openPlantingEditor(null, { anchor: state.day }) }, "Neuer Satz"),
  );
  const scroll = h("div", { class: "tl-scroll" });
  const side = h("aside", { class: "panel tl-panel", "aria-label": "Beet bearbeiten", hidden: true });
  const el = h("div", { class: "tlview" }, toolbar, h("div", { class: "tl-main" }, scroll, side));
  root.append(el);

  // Seitenleiste mit den Eigenschaften des gewählten Beets
  function renderSide() {
    const bed = state.sel?.type === "bed" ? find.bed(state.sel.id) : null;
    side.hidden = !bed;
    if (!bed) { side.replaceChildren(); return; }
    replaceKeepingFocus(side, [
      bedProperties(bed, {
        onClose: () => select(null),
        actions: [
          h("button", { type: "button", class: "btn btn-sm", onclick: () => { location.hash = "karte"; } }, "Auf der Karte zeigen"),
          h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => openBedEditor(bed), title: "Lage, Drehung und alle Eigenschaften" }, icon("edit"), "Mehr"),
          h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => deleteBed(bed) }, icon("trash"), "Löschen"),
        ],
      }),
      ...bedUsage(bed, { onPlanting: (p) => openPlantingEditor(p) }),
    ]);
  }

  async function deleteBed(bed) {
    const count = state.plantings.filter((p) => p.bed_id === bed.id).length;
    const ok = await confirmDialog(count
      ? `${bed.name} wird gelöscht. Die ${count} Sätze darin bleiben erhalten und stehen danach unter „Ohne Beet“.`
      : `${bed.name} wird gelöscht.`, { title: "Beet löschen?" });
    if (ok) await remove("beds", bed.id, { undoLabel: `${bed.name} gelöscht` });
  }

  let geo = null; // aktuelle Geometrie: { year, ys, len, ppd, labelW }
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
    const year = yearOf(state.day);
    const ys = yearStart(year);
    const len = yearLength(year);
    const ppd = ZOOMS[zoomIdx];
    const labelW = labelWidth();
    const prevYear = geo?.year;
    geo = { year, ys, len, ppd, labelW };
    zoomLabel.textContent = ppd >= 4.6 ? "Wochen" : ppd >= 2 ? "Monate" : "Jahr";

    const keep = { left: scroll.scrollLeft, top: scroll.scrollTop };
    const width = labelW + len * ppd;
    const grid = h("div", { class: "tl-grid", style: { width: `${width}px` } });

    // Kopf mit Monaten und Kalenderwochen
    const scale = h("div", { class: "tl-scale", style: { width: `${len * ppd}px` } });
    for (let m = 0; m < 12; m++) {
      const a = Math.floor(Date.UTC(year, m, 1) / 86400000) - ys;
      const b = Math.floor(Date.UTC(year, m + 1, 1) / 86400000) - ys;
      scale.append(h("div", { class: "tl-month", style: { left: `${a * ppd}px`, width: `${(b - a) * ppd}px` } },
        (b - a) * ppd > 70 ? MONTHS[m] : MONTHS_SHORT[m]));
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

    grid.append(h("div", { class: "tl-head" },
      h("div", { class: "tl-corner", style: { width: `${labelW}px` } }, String(year)), scale));

    // Hintergrundlinien
    const bg = h("div", { class: "tl-bg", style: { left: `${labelW}px`, width: `${len * ppd}px` } });
    for (let m = 1; m < 12; m++) {
      const a = Math.floor(Date.UTC(year, m, 1) / 86400000) - ys;
      bg.append(h("div", { class: "mline", style: { left: `${a * ppd}px` } }));
    }
    if (weekW >= 16) for (let d = firstMonday; d < ys + len; d += 7) bg.append(h("div", { class: "wline", style: { left: `${(d - ys) * ppd}px` } }));
    grid.append(bg);

    // Zeilen
    const beds = state.beds.filter((b) => PLANTABLE.has(b.kind)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"));
    const inYear = (p) => { const ph = phases(p); return ph.sow < ys + len && ph.he >= ys; };
    for (const bed of beds) grid.append(row(bed, state.plantings.filter((p) => p.bed_id === bed.id && inYear(p))));
    const loose = state.plantings.filter((p) => (p.bed_id == null || !find.bed(p.bed_id) || !PLANTABLE.has(find.bed(p.bed_id).kind)) && inYear(p));
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
    // Spuren vergeben, damit sich Balken nicht überdecken
    const items = plantings.map((p) => ({ p, ph: phases(p) })).sort((a, b) => a.ph.sow - b.ph.sow);
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
    for (const it of items) track.append(bar(it.p, it.ph, it.lane, bed));
    track.addEventListener("click", (e) => {
      if (e.target !== track) return;
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
        `${bed.kind !== "bed" ? KIND_LABEL[bed.kind] + ", " : ""}${fmtNum(bed.length)} × ${fmtNum(bed.width)} m`) : null);
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
    const selected = state.sel?.type === "planting" && state.sel.id === p.id;
    const el = h("div", {
      class: `bar${conflict ? " conflict" : ""}${selected ? " selected" : ""}${left < 0 ? " clip-l" : ""}${left + width > geo.len * ppd ? " clip-r" : ""}`,
      style: { left: `${left}px`, width: `${Math.max(width, 3)}px`, top: `${ROW_PAD + lane * LANE_H}px` },
      "data-pid": p.id,
      title: tooltip(p, ph, crop, bed, issues),
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
      left0: parseFloat(el.style.left), width0: parseFloat(el.style.width), dd: 0, targetRow: null };
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

  async function onBarUp(e) {
    const d = drag;
    drag = null;
    if (!d) return;
    d.el.removeEventListener("pointermove", onBarMove);
    d.targetRow?.classList.remove("drop-target");
    if (!d.moved) {
      select({ type: "planting", id: d.p.id });
      openPlantingEditor(find.planting(d.p.id));
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
    if (!geo || yearOf(state.day) !== geo.year) { render(); return; }
    const dayX = (state.day - geo.ys + 0.5) * geo.ppd;
    const line = scroll.querySelector(".tl-day");
    const tag = scroll.querySelector(".tl-day-tag");
    if (line) line.style.left = `${geo.labelW + dayX}px`;
    if (tag) { tag.style.left = `${dayX}px`; tag.firstChild.textContent = fmtDay(state.day); }
    const viewLeft = scroll.scrollLeft, viewRight = viewLeft + scroll.clientWidth - geo.labelW;
    if (dayX < viewLeft + 10 || dayX > viewRight - 10) {
      scroll.scrollTo({ left: Math.max(0, dayX - (scroll.clientWidth - geo.labelW) * 0.35), behavior: "smooth" });
    }
  }

  function onResize() { if (geo && labelWidth() !== geo.labelW) render(); }
  window.addEventListener("resize", onResize);

  render();
  renderSide();

  return {
    update(reason) {
      if (drag) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (reason === "day") { moveDayMarker(); renderSide(); }
        else { render(); renderSide(); }
      });
    },
    destroy() {
      if (geo) lastScroll = { year: geo.year, left: scroll.scrollLeft, top: scroll.scrollTop };
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    },
  };
}
