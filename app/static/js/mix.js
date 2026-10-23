// Mischsatz: Sortenliste im Dialog, Legende, Pflanzplan als CSV und Vorschau mit wählbarer Startecke.
import {
  h, s, mixPlan, plantLayout, spacing, varietyColor, varietyMark, varietyPlaces, textOn, spanOf, clamp, fmtNum,
  isoOf, todayNum, round2, plural,
} from "./util.js";
import { icon, iconBtn } from "./ui.js";

export function capacityText(plan) {
  if (!plan.total) return `${plural(plan.capacity, "Platz", "Plätze")} frei`;
  if (plan.overflow) return `${plan.total} Pflanzen, aber nur ${plan.capacity} Plätze: ${plan.overflow} zu viel`;
  if (plan.free) return `${plan.total} von ${plan.capacity} Plätzen belegt, ${plan.free} frei`;
  return `Alle ${plan.capacity} Plätze belegt`;
}

const CORNERS = [["tl", 0, 0], ["tr", 1, 0], ["bl", 0, 1], ["br", 1, 1]];

// Lage der Startecke so, wie man sie auf der Karte sieht (das Beet kann gedreht sein)
export function startCornerName(p, bed) {
  const [, fx, fy] = CORNERS.find(([id]) => id === (p.fill_start || "tl"));
  const W = p.len, H = spanOf(p, bed);
  const t = ((bed?.rotation || 0) * Math.PI) / 180;
  const lx = (fx - 0.5) * W, ly = (fy - 0.5) * H;
  const X = lx * Math.cos(t) - ly * Math.sin(t);
  const Y = lx * Math.sin(t) + ly * Math.cos(t);
  const eps = 0.2 * Math.max(Math.abs(X), Math.abs(Y));
  const v = Y < -eps ? "oben" : Y > eps ? "unten" : "";
  const hz = X < -eps ? "links" : X > eps ? "rechts" : "";
  return [v, hz].filter(Boolean).join(" ") || "Mitte";
}

// Legende in der Seitenleiste: Farbe, Kürzel, Sorte, Anzahl, Lage im Beet
export function mixLegend(p, crop, bed) {
  const plan = mixPlan(p, crop, bed);
  return h("div", { class: "mix-legend" },
    h("p", { class: `small ${plan.overflow ? "mix-warn" : "muted"}`, style: { margin: 0 } }, capacityText(plan)),
    h("ol", {}, p.varieties.map((v, i) => {
      const color = varietyColor(i);
      return h("li", {},
        h("span", { class: "mix-dot", style: { background: color, color: textOn(color) } }, varietyMark(i)),
        h("span", { class: "mix-name" }, v.name),
        h("span", { class: "mix-count num" }, v.count),
        h("span", { class: "mix-where" }, varietyPlaces(plan, i) || "kein Platz mehr"));
    })),
    h("p", { class: "small muted", style: { margin: 0 } },
      `Gezählt ab der Ecke ${startCornerName(p, bed)}, ${p.fill === "columns" ? "quer über die Reihen" : "als Schlange"}.`));
}

// Pflanzplan als CSV (Semikolon, damit Excel und LibreOffice die Spalten direkt erkennen)
export function downloadPlan(p, crop, bed) {
  const plan = mixPlan(p, crop, bed);
  const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
  const lines = [["Reihe", "Platz", "Kürzel", "Sorte"].join(";")];
  const placed = plan.order.filter((o) => o.v != null).sort((a, b) => a.row - b.row || a.place - b.place);
  for (const o of placed) lines.push([o.row, o.place, varietyMark(o.v), q(p.varieties[o.v].name)].join(";"));
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const name = `pflanzplan-${crop?.name || "satz"}-${bed?.name || "ohne-beet"}-${isoOf(todayNum())}.csv`
    .toLowerCase().replace(/[^a-z0-9äöüß.-]+/g, "-");
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Vorschau des Pflanzbilds, gedreht wie auf der Karte. Die vier Ecken lassen sich antippen.
export function mixPreview(p, crop, bed, { onStart } = {}) {
  const plan = mixPlan(p, crop, bed);
  const W = Math.max(0.01, p.len), H = Math.max(0.01, spanOf(p, bed));
  const rot = bed?.rotation || 0;
  const t = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
  const BW = 520, MAXH = 200, pad = 22, MIN = 44;
  const aw = BW - 2 * pad, ah = MAXH - 2 * pad;
  // maßstäblich einpassen, schmale Streifen aber auf eine antippbare Mindestbreite strecken
  const k = Math.min(aw / (W * c + H * sn), ah / (W * sn + H * c));
  let w = W * k, hh = H * k;
  if (Math.min(w, hh) < MIN) {
    const fit = (T, cosL, sinL) => Math.min(cosL > 1e-6 ? (aw - T * sinL) / cosL : Infinity, sinL > 1e-6 ? (ah - T * cosL) / sinL : Infinity);
    if (hh <= w) { hh = MIN; w = Math.max(MIN, fit(MIN, c, sn)); } else { w = MIN; hh = Math.max(MIN, fit(MIN, sn, c)); }
  }
  const boxH = Math.max(90, Math.min(MAXH, w * sn + hh * c + 2 * pad));
  const { along, rows, perRow } = plan.layout;
  const at = (r, col) => (along === "x"
    ? [(w * (col + 0.5)) / perRow, (hh * (r + 0.5)) / rows]
    : [(w * (r + 0.5)) / rows, (hh * (col + 0.5)) / perRow]);
  const pitch = Math.min(w / (along === "x" ? perRow : rows), hh / (along === "x" ? rows : perRow));
  const rad = clamp(pitch * 0.36, 1.5, 13);

  const inner = s("g", { transform: `translate(${BW / 2} ${boxH / 2}) rotate(${rot}) translate(${-w / 2} ${-hh / 2})` },
    s("rect", { x: 0, y: 0, width: w, height: hh, rx: 4, class: "mix-bed" }));
  if (plan.order.length > 1 && plan.order.length <= 600) {
    const pts = plan.order.map((o) => at(o.r, o.c).map((v) => v.toFixed(1)).join(",")).join(" ");
    inner.append(s("polyline", { points: pts, class: "mix-path" }));
  }
  for (const o of plan.order) {
    const [cx, cy] = at(o.r, o.c);
    if (o.v == null) {
      inner.append(s("circle", { cx, cy, r: rad * 0.8, class: "mix-free" }));
      continue;
    }
    const color = varietyColor(o.v);
    inner.append(s("circle", { cx, cy, r: rad, fill: color }));
    if (rad >= 7) {
      inner.append(s("text", { x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central", fill: textOn(color),
        transform: rot ? `rotate(${-rot} ${cx} ${cy})` : null, class: "mix-mark",
        style: `font-size:${Math.round(rad * 1.15)}px` }, varietyMark(o.v)));
    }
  }
  const active = p.fill_start || "tl";
  for (const [id, fx, fy] of CORNERS) {
    const on = active === id;
    const g = s("g", { class: `mix-corner${on ? " active" : ""}`, role: "radio", tabindex: on ? "0" : "-1", "data-corner": id,
      "aria-checked": on ? "true" : "false", "aria-label": `Start an dieser Ecke (${startCornerName({ ...p, fill_start: id }, bed)})` },
    s("circle", { cx: fx * w, cy: fy * hh, r: 18, class: "mix-corner-hit" }),
    s("circle", { cx: fx * w, cy: fy * hh, r: on ? 8 : 6, class: "mix-corner-dot" }));
    const pick = () => onStart?.(id);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => {
      const ids = CORNERS.map(([i]) => i);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) { e.preventDefault(); onStart?.(ids[(ids.indexOf(id) + step + 4) % 4]); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    inner.append(g);
  }
  return s("svg", { viewBox: `0 0 ${BW} ${boxH.toFixed(1)}`, class: "mix-preview", role: "radiogroup",
    "aria-label": `Startecke wählen. ${rows} Reihen mit je ${perRow} Plätzen auf ${fmtNum(W)} × ${fmtNum(H)} m` }, inner);
}

// ---------------------------------------------------------------- Sortenliste im Satz-Dialog

let keySeq = 0;

// context() liefert { p, crop, bed } mit den aktuellen Werten aus dem Dialog
export function mixEditor(initial, { context, datalistId, onChange, onFitLength }) {
  const items = (initial.varieties || []).map((v) => ({ key: ++keySeq, name: v.name, count: v.count, ref: v.ref }));
  let fill = initial.fill || "snake";
  let start = initial.fill_start || "tl";

  const list = h("ol", { class: "mix-list" });
  const capLine = h("p", { class: "small", style: { margin: 0 } });
  const fitBtn = h("button", { type: "button", class: "btn btn-sm", hidden: true });
  const previewBox = h("div", { class: "mix-preview-box" });
  const startLine = h("p", { class: "small muted", style: { margin: 0 } });
  const fillSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Reihenfolge im Beet" },
    h("label", { title: "Die Reihe entlang, am Ende in die nächste Reihe und zurück" },
      h("input", { type: "radio", name: "mix_fill", value: "snake", checked: fill === "snake" }), "Schlange"),
    h("label", { title: "Je ein Platz pro Reihe, dann einen Platz weiter" },
      h("input", { type: "radio", name: "mix_fill", value: "columns", checked: fill === "columns" }), "Querreihen"));
  fillSeg.addEventListener("change", () => {
    fill = fillSeg.querySelector("input:checked")?.value || "snake";
    changed();
  });

  function rowEl(it) {
    const name = h("input", { class: "input mix-name-in", value: it.name || "", list: datalistId, autocomplete: "off",
      placeholder: "Sorte", "aria-label": "Sorte", maxlength: 80 });
    const count = h("input", { class: "input mix-count-in num", value: it.count ?? "", inputmode: "numeric", placeholder: "Anz.",
      "aria-label": "Anzahl Pflanzen", maxlength: 4 });
    const grip = h("button", { type: "button", class: "mix-grip", title: "Ziehen oder mit den Pfeiltasten verschieben" }, icon("grip"));
    const mark = h("span", { class: "mix-dot", "aria-hidden": "true" });
    const del = iconBtn("close", "Sorte entfernen", () => removeItem(it));
    const li = h("li", { class: "mix-row" }, grip, mark, name, count, del);
    it.el = li; it.nameIn = name; it.countIn = count; it.grip = grip; it.mark = mark;

    name.addEventListener("input", () => { it.name = name.value; changed(); });
    count.addEventListener("input", () => {
      const n = parseInt(count.value, 10);
      it.count = Number.isFinite(n) ? n : null;
      changed();
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); count.focus(); count.select(); }
    });
    count.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const i = items.indexOf(it);
      if (i === items.length - 1) addItem({ count: it.count }).nameIn.focus();
      else items[i + 1].nameIn.focus();
    });
    // Eine kopierte Spalte (z. B. aus Baserow oder einer Tabelle) wird zu mehreren Zeilen
    name.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") || "";
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2 && !/[\t;]/.test(text)) return;
      e.preventDefault();
      let at = items.indexOf(it);
      let prev = it;
      lines.forEach((line, n) => {
        const [nm, cnt] = line.split(/\t|;/).map((x) => x.trim());
        const parsed = parseInt(cnt, 10);
        const target = n === 0 ? it : addItem({ count: prev.count }, ++at);
        prev = target;
        target.name = nm.slice(0, 80);
        target.nameIn.value = target.name;
        if (Number.isFinite(parsed) && parsed > 0) { target.count = parsed; target.countIn.value = parsed; }
      });
      changed();
    });

    grip.addEventListener("keydown", (e) => {
      const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const i = items.indexOf(it);
      const j = i + d;
      if (j < 0 || j >= items.length) return;
      items.splice(i, 1);
      items.splice(j, 0, it);
      list.insertBefore(it.el, d < 0 ? items[j + 1].el : items[j - 1].el.nextSibling);
      grip.focus();
      changed();
    });
    grip.addEventListener("pointerdown", (e) => startDrag(e, it));
    return li;
  }

  // Ziehen am Griff. Die Zeile wandert dabei im DOM mit; deshalb hängen die Listener am Fenster,
  // denn das Umhängen eines Elements hebt eine Zeigererfassung auf.
  function startDrag(e, it) {
    if (e.button !== 0) return;
    e.preventDefault();
    it.el.classList.add("dragging");
    const scroller = list.closest(".dlg-body");
    const id = e.pointerId;
    let lastY = e.clientY;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      ev.preventDefault();
      const dy = ev.clientY - lastY;
      lastY = ev.clientY;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (dy < 0 && ev.clientY < r.top + 40) scroller.scrollTop -= 14;
        else if (dy > 0 && ev.clientY > r.bottom - 40) scroller.scrollTop += 14;
      }
      let before = null;
      for (const sib of list.children) {
        if (sib === it.el) continue;
        const r = sib.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { before = sib; break; }
      }
      if (before !== it.el.nextElementSibling) list.insertBefore(it.el, before);
    };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      it.el.classList.remove("dragging");
      const order = [...list.children];
      items.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
      changed();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function addItem(values = {}, index = items.length) {
    const it = { key: ++keySeq, name: values.name || "", count: values.count ?? null };
    items.splice(index, 0, it);
    const el = rowEl(it);
    list.insertBefore(el, items[index + 1]?.el || null);
    changed();
    return it;
  }

  function removeItem(it) {
    const i = items.indexOf(it);
    items.splice(i, 1);
    it.el.remove();
    if (!items.length) addItem();
    (items[Math.min(i, items.length - 1)]?.nameIn)?.focus();
    changed();
  }

  // Kürzel und Farben hängen an der Position in der Liste
  function updateMarks() {
    items.forEach((it, i) => {
      const color = varietyColor(i);
      it.mark.textContent = varietyMark(i);
      it.mark.style.background = color;
      it.mark.style.color = textOn(color);
      it.grip.setAttribute("aria-label", `Sorte ${i + 1} von ${items.length} verschieben`);
      it.nameIn.setAttribute("aria-label", `Sorte ${varietyMark(i)}`);
      it.countIn.setAttribute("aria-label", `Anzahl Pflanzen ${it.name || varietyMark(i)}`);
    });
  }

  function draft() {
    const { p, crop, bed } = context();
    return { p: { ...p, varieties: valid(), fill, fill_start: start }, crop, bed };
  }

  function valid() {
    return items.filter((it) => it.name.trim() && it.count >= 1)
      .map((it) => ({ name: it.name.trim(), count: it.count, ...(it.ref ? { ref: it.ref } : {}) }));
  }

  function refresh() {
    const { p, crop, bed } = draft();
    if (!(p.len > 0)) {
      capLine.textContent = "Erst eine Länge angeben, dann passt die Vorschau.";
      previewBox.replaceChildren();
      fitBtn.hidden = true;
      return;
    }
    const plan = mixPlan(p, crop, bed);
    capLine.textContent = capacityText(plan);
    capLine.classList.toggle("mix-warn", plan.overflow > 0);
    capLine.classList.toggle("muted", !plan.overflow);

    // Länge so anpassen, dass alle Pflanzen genau Platz haben
    const sp = spacing(p, crop);
    const spanM = spanOf(p, bed);
    const layout = plantLayout(p, crop, bed);
    const across = layout.along === "x" ? layout.rows : (p.rows || Math.max(1, Math.floor((spanM * 100 + 0.5) / sp.row)));
    const need = round2(Math.ceil(plan.total / across) * (sp.plant / 100));
    const fits = !bed || (p.start || 0) + need <= bed.length + 0.001;
    const useful = plan.total > 0 && need >= spanM && Math.abs(need - p.len) > 0.005 && (plan.overflow > 0 || plan.free >= across);
    fitBtn.hidden = !(useful && fits);
    fitBtn.textContent = `Länge auf ${fmtNum(need, 2)} m anpassen`;
    fitBtn.onclick = () => onFitLength?.(need);

    const hadFocus = previewBox.contains(document.activeElement);
    previewBox.replaceChildren(mixPreview(p, crop, bed, { onStart: (id) => { start = id; changed(); } }));
    if (hadFocus) previewBox.querySelector(`[data-corner="${start}"]`)?.focus();
    startLine.textContent = `Start: Ecke ${startCornerName(p, bed)}. Zum Ändern eine andere Ecke antippen.`;
  }

  function changed() {
    updateMarks();
    refresh();
    onChange?.();
  }

  for (const it of items) list.append(rowEl(it));
  if (!items.length) {
    const it = { key: ++keySeq, name: "", count: null };
    items.push(it);
    list.append(rowEl(it));
  }
  updateMarks();

  const el = h("fieldset", { class: "mix-editor" },
    h("legend", {}, "Sorten im Mischsatz"),
    h("p", { class: "small muted", style: { margin: 0 } },
      "Alle Sorten teilen sich Termine und Abstände. Die Reihenfolge änderst du am Griff links. Eine kopierte Liste kannst du direkt in ein Namensfeld einfügen."),
    list,
    h("div", { class: "mix-tools" },
      h("button", { type: "button", class: "btn btn-sm", onclick: () => addItem({ count: items.at(-1)?.count }).nameIn.focus() }, icon("plus"), "Sorte"),
      fitBtn),
    capLine,
    h("div", { class: "field" }, h("span", {}, "Reihenfolge im Beet"), h("div", {}, fillSeg)),
    previewBox,
    startLine);

  return {
    el,
    refresh,
    focusFirst() { (items.find((it) => !it.name) || items[0])?.nameIn.focus(); },
    seed(name, count) {
      if (items.length === 1 && !items[0].name && name) {
        items[0].name = name; items[0].nameIn.value = name;
        if (count) { items[0].count = count; items[0].countIn.value = count; }
        changed();
      }
    },
    names: () => items.map((it) => it.name.trim()).filter(Boolean),
    // Werte für die Schnittstelle; wirft bei unvollständigen Zeilen
    value() {
      const out = [];
      items.forEach((it, i) => {
        const nm = it.name.trim();
        if (!nm && !it.count) return;
        if (!nm) throw new Error(`Sorte ${varietyMark(i)} hat noch keinen Namen`);
        if (!(it.count >= 1)) throw new Error(`Bitte bei „${nm}“ die Anzahl der Pflanzen angeben`);
        out.push({ name: nm, count: it.count, ...(it.ref ? { ref: it.ref } : {}) });
      });
      if (!out.length) throw new Error("Bitte mindestens eine Sorte eintragen oder „Mehrere Sorten“ abwählen");
      return { varieties: out, fill, fill_start: start };
    },
    settings: () => ({ fill, fill_start: start }),
  };
}
