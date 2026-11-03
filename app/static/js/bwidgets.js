// Eingabefelder der Bonitur, eines je Werttyp. Groß genug für den Daumen im Beet.
// Jedes Feld: { el, get() } und meldet Änderungen über onChange(value, extra).
import { h } from "./util.js";
import { icon } from "./ui.js";
import { BBCH_CODES, BBCH_SHORT, bbchPictures, bbchText, scoreLabel } from "./bstore.js";

function parseNum(v) {
  if (v === "" || v == null) return undefined;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : undefined;
}

function fmt(n) {
  return n == null ? "" : String(Math.round(n * 1000) / 1000).replace(".", ",");
}

function press(btn, on) {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

// Knopfleiste, aus der man genau einen Wert wählt (nochmal tippen = abwählen)
function single(options, value, onPick, { cls = "opt-chip", render } = {}) {
  let cur = value;
  const wrap = h("div", { class: "opt-chips" });
  const btns = options.map((o) => {
    const b = h("button", { type: "button", class: cls }, render ? render(o) : o);
    press(b, cur === o);
    b.addEventListener("click", () => {
      cur = cur === o ? undefined : o;
      btns.forEach((x, i) => press(x, options[i] === cur));
      onPick(cur);
    });
    return b;
  });
  wrap.append(...btns);
  return { el: wrap, get: () => cur };
}

export function widget(t, { value, parts, onChange, group, donors = [] }) {
  const make = {
    bbch: bbchWidget, score: scoreWidget, choice: choiceWidget, multi: multiWidget, number: numberWidget,
    text: textWidget, photo: photoWidget, rated: ratedWidget, cross: crossWidget, amount: amountWidget,
  }[t.type] || textWidget;
  return make(t, { value, parts, onChange, group, donors });
}

// ---------------------------------------------------------------- BBCH mit Bildern

function bbchWidget(t, { value, onChange, group }) {
  let cur = value;
  const pics = bbchPictures(group);
  const cards = pics.map((p) => {
    const b = h("button", { type: "button", class: "bbch-card", title: bbchText(p.code, group) },
      h("img", { src: p.src, alt: "", loading: "lazy", width: 160, height: 160 }),
      h("span", { class: "code" }, String(p.code).padStart(2, "0")),
      h("span", { class: "what" }, BBCH_SHORT[p.code] || ""));
    b.addEventListener("click", () => set(cur === p.code ? undefined : p.code));
    return b;
  });
  const out = h("output", { class: "bbch-code" });
  const text = h("span", { class: "bbch-text" });
  const step = (dir) => {
    const list = BBCH_CODES;
    if (cur == null) return set(dir > 0 ? (pics[0]?.code ?? 9) : 89);
    const i = list.findIndex((c) => c >= cur);
    const j = Math.max(0, Math.min(list.length - 1, (list[i] === cur ? i : i - (dir > 0 ? 1 : 0)) + dir));
    set(list[j]);
  };
  const minus = h("button", { type: "button", class: "icon-btn step-btn", "aria-label": "Stadium davor" }, icon("minus"));
  const plus = h("button", { type: "button", class: "icon-btn step-btn", "aria-label": "Stadium danach" }, icon("plus"));
  minus.addEventListener("click", () => step(-1));
  plus.addEventListener("click", () => step(1));

  function paint() {
    // Bild hervorheben: genau getroffen oder dasselbe Hauptstadium
    const decade = (c) => (c < 10 ? 0 : Math.floor(c / 10));
    let near = null;
    for (const p of pics) if (cur != null && p.code <= cur && decade(p.code) === decade(cur)) near = p.code;
    cards.forEach((b, i) => {
      press(b, pics[i].code === cur);
      b.classList.toggle("near", cur != null && pics[i].code === near && near !== cur);
    });
    out.textContent = cur == null ? "–" : String(cur).padStart(2, "0");
    text.textContent = cur == null ? "Bild antippen oder mit − und + ein Zwischenstadium wählen" : bbchText(cur, group);
  }
  function set(v) {
    cur = v;
    paint();
    onChange(cur);
  }
  paint();
  return {
    el: h("div", { class: "bbch-pick" },
      pics.length ? h("div", { class: "bbch-grid" }, cards) : null,
      h("div", { class: "bbch-fine" }, minus, out, plus, text)),
    get: () => cur,
  };
}

// ---------------------------------------------------------------- Note

function scoreWidget(t, { value, onChange }) {
  const lo = t.min ?? 1, hi = t.max ?? 9;
  const opts = [];
  for (let i = lo; i <= hi; i++) opts.push(i);
  const pick = single(opts, value, onChange, { cls: "score-btn" });
  pick.el.className = "score-row";
  pick.el.style.setProperty("--n", opts.length);
  const labels = opts.map((v, i) => h("span", { class: i === 0 ? "first" : i === opts.length - 1 ? "last" : null }, scoreLabel(t, v)));
  return {
    el: h("div", { class: "score-pick" }, pick.el,
      labels.some((l) => l.textContent) ? h("div", { class: "score-labels", style: `--n:${opts.length}` }, labels) : null),
    get: pick.get,
  };
}

// ---------------------------------------------------------------- Auswahl

function choiceWidget(t, { value, onChange }) {
  return single(Array.isArray(t.options) ? t.options : [], value, onChange);
}

function multiWidget(t, { value, onChange }) {
  const cur = new Set(Array.isArray(value) ? value : []);
  const opts = Array.isArray(t.options) ? t.options : [];
  const btns = opts.map((o) => {
    const b = h("button", { type: "button", class: "opt-chip multi" }, o);
    press(b, cur.has(o));
    b.addEventListener("click", () => {
      if (cur.has(o)) cur.delete(o);
      else cur.add(o);
      press(b, cur.has(o));
      onChange(get());
    });
    return b;
  });
  const get = () => (cur.size ? opts.filter((o) => cur.has(o)) : undefined);
  return { el: h("div", { class: "opt-chips" }, btns), get };
}

// ---------------------------------------------------------------- Zahl, auf Wunsch als Mittel aus Einzelwerten

function numberWidget(t, { value, parts, onChange }) {
  let cur = value;
  let list = Array.isArray(parts) ? [...parts] : [];
  const input = h("input", { class: "input num-input", inputmode: "decimal", autocomplete: "off", value: fmt(cur),
    "aria-label": t.name, placeholder: t.unit ? `in ${t.unit}` : "Zahl" });
  input.addEventListener("input", () => {
    cur = parseNum(input.value);
    if (list.length) { list = []; paintParts(); }
    onChange(cur, { parts: list });
  });
  const row = h("div", { class: "num-row" }, input, t.unit ? h("span", { class: "unit" }, t.unit) : null);
  if (!t.samples) return { el: row, get: () => cur, parts: () => [] };

  const one = h("input", { class: "input part-input", inputmode: "decimal", autocomplete: "off",
    placeholder: "Einzelwert", "aria-label": "Einzelwert" });
  const chips = h("div", { class: "parts" });
  const add = () => {
    const n = parseNum(one.value);
    if (n == null) return;
    list.push(n);
    one.value = "";
    one.focus();
    update();
  };
  one.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  const addBtn = h("button", { type: "button", class: "btn btn-sm" }, icon("plus"), "Dazu");
  addBtn.addEventListener("click", add);
  function update() {
    cur = list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : undefined;
    input.value = fmt(cur);
    paintParts();
    onChange(cur, { parts: list });
  }
  function paintParts() {
    chips.replaceChildren(...list.map((n, i) => h("button", { type: "button", class: "part", title: "Entfernen",
      onclick: () => { list.splice(i, 1); update(); } }, fmt(n), icon("close"))),
    list.length ? h("span", { class: "muted small" }, `${list.length} von ${t.samples}, Mittel ${fmt(cur)}${t.unit ? ` ${t.unit}` : ""}`) : null);
  }
  paintParts();
  return {
    el: h("div", { class: "num-wrap" }, row,
      h("div", { class: "part-row" }, one, addBtn), chips),
    get: () => cur,
    parts: () => list,
  };
}

// ---------------------------------------------------------------- Text und Foto

function textWidget(t, { value, onChange }) {
  const ta = h("textarea", { class: "input", rows: 2, "aria-label": t.name, placeholder: t.hint || "" }, value || "");
  ta.addEventListener("input", () => onChange(ta.value.trim() ? ta.value : undefined));
  return { el: ta, get: () => (ta.value.trim() ? ta.value : undefined) };
}

// Fotos werden vor dem Hochladen verkleinert (lange Seite 1600 px), das spart Mobilfunk
export async function shrinkPhoto(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob || file;
  } catch {
    return file; // z. B. HEIC ohne Browserunterstützung: der Server versucht es selbst
  }
}

function photoWidget(t, { value, onChange }) {
  let cur = value; // { blob, url } bis zum Speichern
  const input = h("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only" });
  const preview = h("div", { class: "photo-preview" });
  const btn = h("button", { type: "button", class: "btn" }, "Foto aufnehmen oder wählen");
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    btn.disabled = true;
    const blob = await shrinkPhoto(file);
    btn.disabled = false;
    cur = { blob, url: URL.createObjectURL(blob) };
    paint();
    onChange(cur);
  });
  function paint() {
    preview.replaceChildren(cur ? h("div", { class: "photo-item" },
      h("img", { src: cur.url, alt: "Vorschau" }),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Foto verwerfen",
        onclick: () => { cur = undefined; paint(); onChange(undefined); } }, icon("close"))) : "");
    btn.textContent = cur ? "Anderes Foto" : "Foto aufnehmen oder wählen";
  }
  paint();
  return { el: h("div", { class: "photo-pick" }, input, btn, preview), get: () => cur };
}

// ---------------------------------------------------------------- Befall: Erreger und Note

function ratedWidget(t, { value, onChange }) {
  let opt = value?.opt, score = value?.score;
  const opts = Array.isArray(t.options) ? t.options : [];
  const other = h("input", { class: "input", placeholder: "anderer", "aria-label": "Anderer Erreger oder Schädling",
    value: opt && !opts.includes(opt) ? opt : "" });
  const emit = () => onChange(opt && score != null ? { opt, score } : undefined);
  const pickOpt = single(opts, opts.includes(opt) ? opt : undefined, (v) => {
    opt = v;
    if (v) other.value = "";
    emit();
  });
  other.addEventListener("input", () => {
    opt = other.value.trim() || undefined;
    if (opt) pickOpt.el.querySelectorAll("button").forEach((b) => press(b, false));
    emit();
  });
  pickOpt.el.append(other);
  other.classList.add("other-input");
  const sc = scoreWidget({ ...t, type: "score", min: t.min ?? 1, max: t.max ?? 9,
    options: { 1: "kein Befall", 5: "mittel", 9: "sehr stark" } }, { value: score, onChange: (v) => { score = v; emit(); } });
  return { el: h("div", { class: "rated-pick" }, pickOpt.el, sc.el), get: () => (opt && score != null ? { opt, score } : undefined) };
}

// ---------------------------------------------------------------- Kreuzung und Menge

let datalistSeq = 0;

function crossWidget(t, { value, onChange, donors }) {
  const listId = `donors-${++datalistSeq}`;
  const donor = h("input", { class: "input", list: listId, autocomplete: "off", placeholder: "Etikett oder Pflanze",
    value: value?.donor || "", "aria-label": "Pollenspender" });
  const mark = h("input", { class: "input", placeholder: "z. B. roter Faden am 3. Blütenstand", value: value?.mark || "",
    "aria-label": "Markierung" });
  const get = () => (donor.value.trim() ? { donor: donor.value.trim(), mark: mark.value.trim() } : undefined);
  for (const el of [donor, mark]) el.addEventListener("input", () => onChange(get()));
  return {
    el: h("div", { class: "grid-2 stack-sm" },
      h("label", { class: "field" }, h("span", {}, "Pollenspender (Vater)"), donor,
        h("datalist", { id: listId }, donors.map((d) => h("option", { value: d })))),
      h("label", { class: "field" }, h("span", {}, "Markierung"), mark)),
    get,
  };
}

function amountWidget(t, { value, onChange }) {
  const units = Array.isArray(t.options) && t.options.length ? t.options : [""];
  let unit = value?.unit || units[0];
  const input = h("input", { class: "input num-input", inputmode: "decimal", value: fmt(value?.v), "aria-label": t.name });
  const get = () => {
    const v = parseNum(input.value);
    return v == null ? undefined : { v, unit };
  };
  input.addEventListener("input", () => onChange(get()));
  const pick = single(units, unit, (u) => {
    unit = u || units[0];
    if (!u) press(pick.el.querySelector("button"), true);
    onChange(get());
  });
  return { el: h("div", { class: "num-row" }, input, pick.el), get };
}
