// Satzweiser Anbau: „6 Köpfe Salat je Woche von KW 20 bis 43, im Urlaub nichts“ – Beetwerk plant die Folgesätze
// und legt sie als Block auf ein Beet. Ein neuer Satz kommt auf den Streifen, den ein abgeernteter gerade frei
// gemacht hat; so braucht die Folge so wenig Beet wie möglich. Bearbeitet wird die Folge, die Sätze ziehen mit.
import { state, api, find, load, setDay, select } from "./store.js";
import {
  h, s, fmtDay, dayNum, isoOf, isoWeek, plural, fmtNum, phases, yearOf, monthStarts, MONTHS_SHORT, mix, clamp, round2, METHOD_LABEL,
} from "./util.js";
import { toast, confirmDialog, icon } from "./ui.js";
import { shell, field } from "./editor.js";
import { openGoalOverview } from "./overview.js";

const UNITS = ["Köpfe", "Stück", "Bund", "Portionen", "kg"];
const PLANTABLE = new Set(["bed", "raised", "greenhouse"]);
const BASIS = {
  Klima: "Kulturdauer nach den Temperaturen deines Gartens (Wetterdaten der letzten Jahre)",
  typisch: "Kulturdauer nach typischen Temperaturen in Süddeutschland – mit Wetterdaten wird es genauer",
  fest: "feste Kulturdauer der Kultur",
};

function day(iso, opts) {
  return iso ? fmtDay(dayNum(iso), opts) : "–";
}

function kw(iso) {
  return iso ? `KW ${isoWeek(dayNum(iso))}` : "";
}

const m = (v) => `${fmtNum(v, 2)} m`;
const mondayOf = (n) => n - ((new Date(n * 86400000).getUTCDay() + 6) % 7);
const lexLess = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// „6 Köpfe“, mit Sternchen, wenn einzelne Wochen abweichen
export function amountText(g) {
  return `${fmtNum(g.amount)} ${g.unit}${Object.keys(g.weeks || {}).length ? "*" : ""}`;
}

export function goalPlantings(g) {
  return state.plantings.filter((p) => p.goal_id === g.id).sort((a, b) => (a.goal_seq ?? 0) - (b.goal_seq ?? 0));
}

const started = (p) => p.sown_done || p.planted_done || p.harvest_done;

// Liegt der Satz im Block seiner Folge? Dann ändert man die Folge, nicht den einzelnen Satz.
export function blockGoalOf(p) {
  if (p?.goal_id == null || started(p)) return null;
  const g = (state.goals || []).find((x) => x.id === p.goal_id);
  return g && g.bed_id != null && g.bed_id === p.bed_id ? g : null;
}

// Block verschieben (dx in Metern entlang der Beetlänge); die Sätze ordnen sich dort neu an
export async function moveBlock(g, dx) {
  const before = g.block_start ?? 0;
  const to = round2(Math.max(0, before + dx));
  if (Math.abs(to - before) < 0.005) return;
  const go = async (start, label, undoable) => {
    try {
      const r = await api.patch(`/api/goals/${g.id}`, { block_start: start });
      await load();
      toast(r.unplaced ? `${label} – ${plural(r.unplaced, "Satz passt", "Sätze passen")} dort nicht ganz ins Beet` : label,
        undoable ? { action: "Rückgängig", onAction: () => go(before, "Satzfolge zurückgesetzt", false) } : {});
    } catch (e) { toast(e.message, { error: true }); }
  };
  await go(to, `Satzfolge liegt jetzt ab ${m(to)}`, true);
}

// Auf der Karte zeigen: Stichtag auf den Tag, an dem die meisten Sätze der Folge im Beet stehen, Beet gewählt
export function showGoalOnMap(g) {
  const ps = goalPlantings(g).filter((p) => g.bed_id == null || p.bed_id === g.bed_id);
  if (!ps.length) return;
  const phs = ps.map(phases);
  let best = phs[0].fieldStart, most = 0;
  for (const d of phs.map((x) => x.fieldStart).sort((a, b) => a - b)) {
    const n = phs.filter((x) => x.fieldStart <= d && d <= x.he).length;
    if (n > most) { most = n; best = d; }
  }
  setDay(best);
  select(g.bed_id != null ? { type: "bed", id: g.bed_id } : null);
  location.hash = "karte";
}

// Sätze einer Folge für den Beetplan, aus den gespeicherten Sätzen
export function itemsOf(g) {
  return goalPlantings(g).filter((p) => p.bed_id != null && p.bed_id === g.bed_id).map((p, i) => {
    const ph = phases(p);
    return { n: (p.goal_seq ?? i) + 1, fs: ph.fieldStart, hs: ph.hs, he: ph.he, start: p.start || 0, len: p.len, p };
  });
}

// ---------------------------------------------------------------- Beetplan: Zeit nach rechts, Beetlänge nach unten

export function bedPlan(bed, items, { color = "#6a9b3c", block = null, excludeGoal = null, width = 640, onItem } = {}) {
  if (!bed || !items.length) return null;
  const LW = 40, TOP = 18;
  const t0 = Math.min(...items.map((i) => i.fs)) - 10;
  const t1 = Math.max(...items.map((i) => i.he)) + 11;
  const W = Math.max(300, Math.round(width));
  const ppm = clamp(170 / bed.length, 12, 44);
  const H = TOP + bed.length * ppm + 2;
  const X = (d) => LW + ((d - t0) / (t1 - t0)) * (W - LW - 4);
  const Y = (v) => TOP + v * ppm;
  const svg = s("svg", { class: "bedplan", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Belegung von ${bed.name} über die Zeit` });
  svg.append(s("rect", { class: "bp-bed", x: LW, y: TOP, width: W - LW - 4, height: bed.length * ppm }));
  for (const { day: d, month } of monthStarts(t0, t1 - t0)) {
    svg.append(s("line", { class: "bp-grid", x1: X(d), x2: X(d), y1: TOP - 4, y2: H }));
    svg.append(s("text", { class: "bp-axis", x: X(d) + 3, y: 12 }, MONTHS_SHORT[month]));
  }
  const step = bed.length > 8 ? 2 : bed.length > 3 ? 1 : 0.5;
  for (let v = 0; v <= bed.length + 0.001; v += step) {
    svg.append(s("line", { class: "bp-grid", x1: LW, x2: W - 4, y1: Y(v), y2: Y(v) }));
    svg.append(s("text", { class: "bp-axis", x: LW - 5, y: Y(v) + 4, "text-anchor": "end" }, `${fmtNum(v)} m`));
  }
  // andere Sätze im Beet
  for (const q of state.plantings) {
    if (q.bed_id !== bed.id || (excludeGoal != null && q.goal_id === excludeGoal)) continue;
    const ph = phases(q);
    if (ph.he < t0 || ph.fieldStart > t1) continue;
    const c = find.crop(q.crop_id);
    const a = Math.max(ph.fieldStart, t0), b = Math.min(ph.he + 1, t1);
    svg.append(s("rect", { class: "bp-other", x: X(a), y: Y(q.start || 0), width: Math.max(1, X(b) - X(a)), height: q.len * ppm },
      s("title", {}, `${c?.name ?? "Satz"}${q.variety ? ` ${q.variety}` : ""}: ${fmtDay(ph.fieldStart)} bis ${fmtDay(ph.he)}, ab ${m(q.start || 0)}`)));
  }
  if (block && block.len > 0) {
    svg.append(s("rect", { class: "bp-block", x: LW + 1, y: Y(block.start), width: W - LW - 6, height: block.len * ppm }));
  }
  const light = mix(color, "#ffffff", 0.5);
  for (const it of items) {
    if (it.start == null) continue;
    const g = s("g", { class: `bp-item${it.unplaced ? " bad" : ""}${onItem && it.p ? " link" : ""}` });
    const y = Y(it.start), hh = Math.max(2, it.len * ppm);
    g.append(s("rect", { x: X(it.fs), y, width: Math.max(1, X(it.hs) - X(it.fs)), height: hh, fill: light }));
    g.append(s("rect", { x: X(it.hs), y, width: Math.max(1, X(it.he + 1) - X(it.hs)), height: hh, fill: color }));
    g.append(s("rect", { class: "bp-outline", x: X(it.fs), y, width: Math.max(1, X(it.he + 1) - X(it.fs)), height: hh }));
    if (hh >= 11 && X(it.he + 1) - X(it.fs) > 16) {
      g.append(s("text", { class: "bp-label", x: X(it.fs) + 4, y: y + Math.min(hh / 2 + 4, 13) }, String(it.n)));
    }
    g.append(s("title", {}, `Satz ${it.n}: ${fmtDay(it.fs)} bis ${fmtDay(it.he)}, ${m(it.len)} ab ${m(it.start)}${it.unplaced ? " – passt nicht ins Beet" : ""}`));
    if (onItem && it.p) g.addEventListener("click", () => onItem(it.p));
    svg.append(g);
  }
  if (state.day > t0 && state.day < t1) svg.append(s("line", { class: "bp-day", x1: X(state.day), x2: X(state.day), y1: TOP - 4, y2: H }));
  return h("div", { class: "bedplan-wrap" }, svg,
    h("p", { class: "muted small bedplan-legend" }, "Zeit nach rechts, Beetlänge nach unten · hell im Beet, kräftig Ernte, grau andere Sätze, gestrichelt der Block"));
}

// ---------------------------------------------------------------- Liste im Sätze-Blatt

export function goalsSection(year) {
  const list = (state.goals || []).filter((g) => yearOf(dayNum(g.start_date)) === year || yearOf(dayNum(g.end_date)) === year);
  const head = h("div", { class: "section-head" }, h("h2", {}, "Satzweiser Anbau"),
    h("span", { class: "muted small" }, "Erntemenge je Woche – Beetwerk plant die Folgesätze, blockt sie auf einem Beet und plant die Anzucht"),
    h("button", { type: "button", class: "btn", onclick: () => openGoalEditor(null, { year }) }, icon("plus"), "Satzweise anbauen"));
  if (!list.length) {
    return h("section", { class: "section" }, head, h("div", { class: "empty-note" },
      "Zum Beispiel „6 Köpfe Kopfsalat je Woche von Mitte Mai bis Oktober“ oder „2 Bund Radieschen je Woche, im August Pause“. ",
      "Daraus werden Sätze mit Aussaat, Pflanzung und Pflanzenzahl, die auf einem Beet nacheinander dieselben Streifen nutzen."));
  }
  return h("section", { class: "section" }, head, h("div", { class: "goals" }, list.map((g) => {
    const crop = find.crop(g.crop_id);
    const bed = find.bed(g.bed_id);
    const ps = goalPlantings(g);
    const first = ps.map((p) => p.sow_date).sort()[0];
    return h("div", { class: "goal" },
      h("button", { type: "button", class: "goal-main", onclick: () => openGoalOverview(g) },
        h("span", { class: "dot", style: { background: crop?.color } }),
        h("span", { class: "goal-title" }, `${crop?.name || "Kultur"}${g.variety ? ` ${g.variety}` : ""}`),
        h("span", { class: "goal-what" }, `${amountText(g)} je Woche · ${kw(g.start_date)} bis ${kw(g.end_date)}`),
        h("span", { class: "muted small goal-sub" },
          `${plural(ps.length, "Satz", "Sätze")}${ps.length ? ` · erste Aussaat ${day(first)}` : ""}`
          + (bed ? ` · ${bed.name}, ${m(g.block_len || 0)} ab ${m(g.block_start || 0)}` : " · ohne Beet"))),
      bed ? null : h("button", { type: "button", class: "btn btn-sm", onclick: () => openGoalEditor(g, { focus: "bed" }) }, "Beet wählen"));
  })));
}

// ---------------------------------------------------------------- Anlegen und ändern

export function openGoalEditor(goal, { year, bed_id = null, crop_id = null, start = null, focus = null } = {}) {
  const isNew = !goal?.id;
  let y = year ?? yearOf(state.day);
  // Im Herbst plant man das nächste Jahr: liegt die übliche Erntezeit schon hinter dem Stichtag, eins weiter
  if (isNew && !start && dayNum(`${y}-08-31`) < state.day) y += 1;
  const g = { crop_id, variety: "", start_date: start ?? `${y}-05-15`, end_date: `${y}-09-30`, amount: 4, unit: "Köpfe",
    yield_per_plant: 1, window_days: null, interval_days: null, seasonal: 1, notes: "", bed_id, block_start: null,
    gap_days: 0, weeks: {}, ...goal };
  const weeks = { ...(g.weeks || {}) };
  // Neue Folge ohne vorgegebenes Beet: das Beet nehmen, auf dem sie am wenigsten Fläche braucht
  let bedChoice = g.bed_id ? String(g.bed_id) : isNew ? "auto" : "";

  const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"));
  const cropSel = h("select", { required: true },
    h("option", { value: "", selected: !g.crop_id }, "– Kultur wählen –"),
    crops.map((c) => h("option", { value: c.id, selected: c.id === g.crop_id }, c.name)));
  const variety = h("input", { value: g.variety, list: "goal-varieties", autocomplete: "off", placeholder: "optional" });
  // Anbauart der Folge: üblich wie die Kultur, auf Wunsch die andere – mit deren Kulturdauer und Abständen
  const methodSel = h("select", {});
  const paintMethod = () => {
    const crop = find.crop(Number(cropSel.value));
    const current = methodSel.value || g.method || "";
    methodSel.replaceChildren(
      h("option", { value: "", selected: !current }, crop ? `wie üblich: ${METHOD_LABEL[crop.method]}` : "wie bei der Kultur üblich"),
      ...["direct", "transplant"].filter((k) => !crop || k !== crop.method)
        .map((k) => h("option", { value: k, selected: current === k }, METHOD_LABEL[k])));
  };
  const varList = h("datalist", { id: "goal-varieties" });
  const startIn = h("input", { type: "date", value: g.start_date, required: true });
  const endIn = h("input", { type: "date", value: g.end_date, required: true });
  const amount = h("input", { inputmode: "decimal", value: String(g.amount).replace(".", ","), required: true });
  const unit = h("input", { value: g.unit, list: "goal-units", maxlength: 30 });
  const unitList = h("datalist", { id: "goal-units" }, UNITS.map((u) => h("option", { value: u })));
  const per = h("input", { inputmode: "decimal", value: String(g.yield_per_plant).replace(".", ",") });
  const weekGrid = h("div", { class: "week-grid" });
  const bedSel = h("select", { name: "bed" });
  const blockIn = h("input", { name: "block_start", inputmode: "decimal", placeholder: "automatisch",
    value: g.block_start != null && !isNew ? fmtNum(g.block_start, 2) : "" });
  const windowIn = h("input", { inputmode: "numeric", value: g.window_days ?? "" });
  const intervalIn = h("input", { inputmode: "numeric", value: g.interval_days ?? "" });
  const gapIn = h("input", { inputmode: "numeric", value: g.gap_days || "", placeholder: "0" });
  const seasonal = h("input", { type: "checkbox", checked: !!g.seasonal });
  const notes = h("input", { value: g.notes || "", maxlength: 2000 });
  const blockInfo = h("div", { class: "goal-block" });
  const preview = h("div", { class: "goal-preview" });
  let touched = !isNew; // Einheit und Ertrag nicht überschreiben, wenn schon bearbeitet
  let fits = new Map(); // Beet-ID -> wie die Folge dort passt

  // ------------------------------------------------ Menge je Kalenderwoche
  function paintWeeks() {
    const a = dayNum(startIn.value), b = dayNum(endIn.value);
    if (!a || !b || b < a || b - a > 400) { weekGrid.replaceChildren(); return; }
    const base = amount.value.trim() || "–";
    const cells = [];
    for (let n = mondayOf(a); n <= b; n += 7) {
      const iso = isoOf(n);
      const input = h("input", { inputmode: "decimal", placeholder: base, value: weeks[iso] != null ? fmtNum(weeks[iso], 2) : "",
        "aria-label": `Menge in KW ${isoWeek(n)}`, "data-week": iso });
      const cell = h("label", { class: `week${weeks[iso] != null ? " set" : ""}`, title: `Woche ab ${fmtDay(n)}` },
        h("span", {}, `KW ${isoWeek(n)}`), input);
      input.addEventListener("input", () => {
        const t = input.value.trim().replace(",", ".");
        if (t === "") delete weeks[iso]; else if (Number.isFinite(Number(t)) && Number(t) >= 0) weeks[iso] = Number(t);
        cell.classList.toggle("set", weeks[iso] != null);
        refresh();
      });
      cells.push(cell);
    }
    weekGrid.replaceChildren(...cells);
  }

  // ------------------------------------------------ Beet
  function bestBed() {
    let best = null;
    for (const b of state.beds) {
      const f = fits.get(b.id);
      if (!f || f.unplaced) continue; // nur Beete, auf die die ganze Folge passt
      const score = [f.unplaced, f.rotation ? 1 : 0, round2(f.block_len * b.width), b.sort];
      if (!best || lexLess(score, best.score)) best = { id: b.id, score };
    }
    return best?.id ?? null;
  }

  function paintBeds() {
    const beds = state.beds.filter((b) => PLANTABLE.has(b.kind)).sort((a, b) => a.sort - b.sort);
    const best = bestBed();
    bedSel.replaceChildren(
      h("option", { value: "", selected: bedChoice === "" }, "Ohne Beet – Sätze einzeln legen"),
      ...beds.map((b) => {
        const f = fits.get(b.id);
        let text = b.name;
        if (f) {
          text += f.unplaced ? ` – ${plural(f.unplaced, "Satz passt", "Sätze passen")} nicht` : ` – braucht ${m(f.block_len)} ab ${m(f.block_start)}`;
          if (f.rotation) text += " · Fruchtfolge";
          if (best === b.id) text += " · empfohlen";
        }
        return h("option", { value: b.id, selected: bedChoice === String(b.id) }, text);
      }));
  }

  const fillCrop = async () => {
    const crop = find.crop(Number(cropSel.value));
    const names = new Set(state.varieties.filter((v) => v.crop_id === crop?.id).map((v) => v.name));
    varList.replaceChildren(...[...names].sort((a, b) => a.localeCompare(b, "de")).map((n) => h("option", { value: n })));
    windowIn.placeholder = crop ? `${crop.harvest_days} (wie Kultur)` : "";
    paintMethod();
    intervalIn.placeholder = "wie Erntefenster";
    if (crop && !touched) {
      try {
        const sg = await api.get(`/api/goals/suggest?crop_id=${crop.id}`);
        unit.value = sg.unit;
        per.value = String(sg.yield_per_plant).replace(".", ",");
      } catch { /* Vorschlag ist nur Bequemlichkeit */ }
    }
    refresh();
  };
  for (const el of [unit, per]) el.addEventListener("input", () => { touched = true; });

  const numOf = (el, label, { int = false, optional = false } = {}) => {
    const t = el.value.trim().replace(",", ".");
    if (!t) {
      if (optional) return 0;
      throw new Error(`${label}: bitte angeben`);
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw new Error(`${label}: bitte eine ${int ? "ganze " : ""}Zahl eingeben`);
    return n;
  };
  const weeksInRange = () => {
    const a = mondayOf(dayNum(startIn.value)), b = dayNum(endIn.value);
    return Object.fromEntries(Object.entries(weeks).filter(([iso]) => dayNum(iso) >= a && dayNum(iso) <= b));
  };
  const chosenBed = () => (bedChoice && bedChoice !== "auto" ? Number(bedChoice) : 0);
  const body = () => ({
    crop_id: Number(cropSel.value) || null, variety: variety.value.trim(), start_date: startIn.value, end_date: endIn.value,
    amount: numOf(amount, "Menge je Woche"), unit: unit.value.trim() || "Stück", yield_per_plant: numOf(per, "Ertrag je Pflanze"),
    window_days: numOf(windowIn, "Erntefenster", { int: true, optional: true }),
    interval_days: numOf(intervalIn, "Abstand", { int: true, optional: true }),
    gap_days: numOf(gapIn, "Pause", { int: true, optional: true }),
    seasonal: seasonal.checked, notes: notes.value.trim(), weeks: weeksInRange(),
    bed_id: chosenBed(), block_start: blockIn.value.trim() ? numOf(blockIn, "Ab Meter") : -1,
    method: methodSel.value,
  });

  let seq = 0;
  let timer = null;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      let b;
      try { b = body(); } catch (e) { preview.replaceChildren(h("p", { class: "muted small" }, e.message)); return; }
      if (!b.crop_id || !b.start_date || !b.end_date) { preview.replaceChildren(); blockInfo.replaceChildren(); return; }
      try {
        const out = await api.post(`/api/goals/preview?beds=true${isNew ? "" : `&goal_id=${g.id}`}`, b);
        if (my !== seq) return;
        fits = new Map((out.beds || []).map((f) => [f.bed_id, f]));
        if (bedChoice === "auto") {
          const best = bestBed();
          bedChoice = best ? String(best) : "";
          paintBeds();
          if (best) { refresh(); return; }
        }
        paintBeds();
        paintPreview(out);
      } catch (e) {
        if (my === seq) preview.replaceChildren(h("p", { class: "form-error", style: { margin: 0 } }, e.message));
      }
    }, 250);
  }

  function paintPreview(out) {
    const ok = out.successions.filter((x) => !x.too_cold && !x.skip);
    const cold = out.successions.filter((x) => x.too_cold && !x.skip);
    const skipped = out.successions.filter((x) => x.skip);
    const transplant = out.method === "transplant";
    const bed = find.bed(out.bed_id);
    const crop = find.crop(Number(cropSel.value));
    const own = isNew ? new Map() : new Map(goalPlantings(g).map((p) => [p.goal_seq, p]));
    const items = ok.map((x) => {
      const p = own.get(x.seq);
      if (p && started(p)) {
        // begonnen: bleibt, wo er ist
        const ph = phases(p);
        return { n: x.seq + 1, fs: ph.fieldStart, hs: ph.hs, he: ph.he, start: p.bed_id === out.bed_id ? p.start : null, len: p.len };
      }
      return { n: x.seq + 1, fs: dayNum(x.plant_date || x.sow_date), hs: dayNum(x.harvest_start), he: dayNum(x.harvest_end),
        start: x.start, len: x.len, unplaced: x.unplaced };
    });
    const area = bed && out.block_len ? out.block_len * bed.width : 0;
    blockInfo.replaceChildren(...[
      !bed && fits.size && !bestBed() ? h("p", { class: "note-inline" },
        "Auf keinem Beet ist in dieser Zeit genug Platz für die ganze Folge. Wähle trotzdem ein Beet – was nicht passt, wartet dann unter „Ohne Beet“ – oder plane weniger Menge.") : null,
      bed ? h("p", { class: out.unplaced ? "note-inline" : "goal-sum" },
        out.unplaced
          ? `${plural(out.unplaced, "Satz passt", "Sätze passen")} nicht in ${bed.name} und ${out.unplaced === 1 ? "bleibt" : "bleiben"} ohne Beet – weniger Menge, eine andere Stelle oder ein anderes Beet wählen.`
          : [h("strong", {}, `${bed.name}: ${m(out.block_len)} ab ${m(out.block_start)}`),
            ` (${fmtNum(area, 1)} m²) für alle ${plural(ok.length, "Satz", "Sätze")} – ein neuer Satz kommt auf einen Streifen, der gerade abgeerntet ist.`])
        : h("p", { class: "muted small", style: { margin: 0 } }, "Ohne Beet stehen die Sätze unter „Ohne Beet“; auf der Karte legst du sie einzeln ab."),
      bed ? bedPlan(bed, items, { color: crop?.color, block: { start: out.block_start, len: out.block_len },
        excludeGoal: isNew ? null : g.id, width: blockInfo.clientWidth || 640 }) : null].filter(Boolean));

    preview.replaceChildren(...[
      h("p", { class: "goal-sum" },
        h("strong", {}, plural(ok.length, "Satz", "Sätze")), ` alle ${out.interval_days} Tage, zusammen ${out.plants} Pflanzen`,
        ` · jeder Satz wird ${out.window_days} Tage beerntet`),
      h("p", { class: "muted small", style: { margin: 0 } }, BASIS[out.basis] || ""),
      crop && out.method !== crop.method ? h("p", { class: "muted small", style: { margin: 0 } },
        `${METHOD_LABEL[out.method]} statt ${METHOD_LABEL[crop.method]}: ${out.field_days} Tage im Beet bis zur Ernte`
        + `${out.estimated ? " (geschätzt – in der Kultur eintragbar)" : ""}.`) : null,
      skipped.length ? h("p", { class: "muted small", style: { margin: 0 } },
        `${plural(skipped.length, "Satz entfällt", "Sätze entfallen")}, weil in ${skipped.length === 1 ? "seinen" : "ihren"} Wochen nichts geerntet werden soll.`) : null,
      cold.length ? h("p", { class: "note-inline" }, `${plural(cold.length, "Erntetermin", "Erntetermine")} (${cold.map((x) => day(x.harvest_start)).join(", ")}) `
        + "schafft die Kultur im Freiland nicht – zu kalt. Ohne Anpassung an die Jahreszeit (z. B. im Gewächshaus) werden sie geplant.") : null,
      h("div", { class: "table-wrap" }, h("table", { class: "data goal-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Satz"), h("th", {}, transplant ? "Aussaat (Anzucht)" : "Aussaat"),
          transplant ? h("th", {}, "Pflanzung") : null, h("th", {}, "Ernte"), h("th", { class: "r" }, "Menge"),
          h("th", { class: "r" }, "Pflanzen"), bed ? h("th", { class: "r" }, "Streifen") : null)),
        h("tbody", {}, out.successions.filter((x) => !x.skip).map((x) => h("tr", { class: x.too_cold ? "cold" : x.unplaced ? "bad" : "", style: { cursor: "default" } },
          h("td", { class: "num" }, x.seq + 1),
          h("td", { class: "nowrap" }, x.too_cold ? "zu kalt" : `${kw(x.sow_date)} · ${day(x.sow_date)}`),
          transplant ? h("td", { class: "nowrap" }, x.plant_date ? day(x.plant_date) : "–") : null,
          h("td", { class: "nowrap" }, `${day(x.harvest_start)} bis ${day(x.harvest_end)}`),
          h("td", { class: "r nowrap" }, `${fmtNum(x.demand)} ${unit.value.trim() || ""}`),
          h("td", { class: "r" }, x.too_cold ? "–" : x.count),
          bed ? h("td", { class: "r nowrap" }, x.too_cold ? "–" : x.unplaced ? "kein Platz" : x.start == null ? "begonnen" : `${m(x.len)} ab ${fmtNum(x.start, 2)}`) : null))))),
    ].filter(Boolean));
  }

  for (const el of [startIn, endIn]) el.addEventListener("input", () => { paintWeeks(); refresh(); });
  amount.addEventListener("input", () => { paintWeeks(); refresh(); });
  for (const el of [per, windowIn, intervalIn, gapIn, unit, blockIn]) el.addEventListener("input", refresh);
  seasonal.addEventListener("change", refresh);
  cropSel.addEventListener("change", fillCrop);
  methodSel.addEventListener("change", refresh);
  paintMethod();
  bedSel.addEventListener("change", () => {
    bedChoice = bedSel.value;
    blockIn.value = ""; // anderes Beet: günstigste Stelle suchen
    refresh();
  });

  const startHint = h("span", { class: "hint" });
  const endHint = h("span", { class: "hint" });
  const hints = () => { startHint.textContent = kw(startIn.value); endHint.textContent = kw(endIn.value); };
  startIn.addEventListener("input", hints);
  endIn.addEventListener("input", hints);
  hints();

  const ui = shell(isNew ? "Satzweise anbauen" : "Satzweiser Anbau", {
    onSubmit: async () => {
      const b = body();
      if (!b.crop_id) throw new Error("Bitte eine Kultur wählen");
      if (!(b.yield_per_plant > 0)) throw new Error("Ertrag je Pflanze: bitte mehr als 0");
      const res = isNew ? await api.post("/api/goals", b) : await api.patch(`/api/goals/${g.id}`, b);
      await load();
      const parts = [];
      if (res.created.length) parts.push(`${plural(res.created.length, "Satz", "Sätze")} angelegt`);
      if (res.updated.length) parts.push(`${res.updated.length} angepasst`);
      if (res.removed.length) parts.push(`${res.removed.length} entfernt`);
      if (res.kept.length) parts.push(`${res.kept.length} schon begonnen, unverändert`);
      const bed = find.bed(res.goal.bed_id);
      const saved = (state.goals || []).find((x) => x.id === res.goal.id) || res.goal;
      // Die Karte zeigt den Stichtag – „Auf der Karte zeigen“ springt in die Zeit, in der die Folge im Beet steht
      toast(`${parts.join(", ") || "Nichts geändert"}.${bed ? ` ${bed.name}: ${m(res.goal.block_len || 0)} ab ${m(res.goal.block_start || 0)}.` : ""}`
        + (res.unplaced ? ` ${plural(res.unplaced, "Satz hat", "Sätze haben")} keinen Platz und ${res.unplaced === 1 ? "wartet" : "warten"} unter „Ohne Beet“.` : ""),
        { action: "Auf der Karte zeigen", onAction: () => showGoalOnMap(saved), ms: 9000 });
    },
  });
  ui.dlg.classList.add("goal-dialog");
  const bedField = h("fieldset", { class: "goal-bed" }, h("legend", {}, "Beet"),
    h("div", { class: "grid-bed" }, field("Auf welchem Beet", bedSel), field("Ab Meter", blockIn, "leer = beste Stelle")),
    blockInfo);
  ui.body.append(
    h("div", { class: "grid-2" }, field("Kultur", cropSel), field("Sorte", variety, "Für Frühjahr und Sommer eigene Folgen mit passender Sorte"), varList),
    field("Anbau", methodSel),
    h("div", { class: "grid-2" },
      h("label", { class: "field" }, h("span", {}, "Ernte ab"), startIn, startHint),
      h("label", { class: "field" }, h("span", {}, "Ernte bis"), endIn, endHint)),
    h("div", { class: "grid-3" },
      field("Menge je Woche", amount),
      field("Einheit", unit), unitList,
      field("Ertrag je Pflanze", per, "über das ganze Erntefenster, z. B. 1 Kopf")),
    h("fieldset", { class: "weeks-set" }, h("legend", {}, "Menge je Kalenderwoche"),
      h("p", { class: "muted small", style: { margin: 0 } }, "Leer = Menge je Woche. Einzelne Wochen ändern, z. B. mehr zum Einmachen oder 0 im Urlaub."),
      weekGrid),
    bedField,
    h("details", { class: "goal-more" }, h("summary", {}, "Feinheiten: Erntefenster, Abstand, Pause, Jahreszeit"),
      h("div", { class: "grid-3" },
        field("Erntefenster je Satz", windowIn, "Tage, die ein Satz beerntet wird"),
        field("Abstand der Sätze", intervalIn, "Tage; kürzer als das Fenster = Sätze überlappen"),
        field("Pause vor Neubelegung", gapIn, "Tage zwischen Abernten und dem nächsten Satz auf dem Streifen")),
      h("label", { class: "check" }, seasonal, "Kulturdauer an die Jahreszeit anpassen"),
      field("Notiz", notes)),
    preview);
  ui.foot.append(
    isNew ? null : h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      const ps = goalPlantings(g);
      const begun = ps.filter(started).length;
      const text = `Die Folge wird gelöscht und mit ihr ${plural(ps.length - begun, "Satz", "Sätze")}, die noch nicht gesät sind.`
        + (begun ? ` ${plural(begun, "begonnener Satz bleibt", "begonnene Sätze bleiben")} als normale Sätze.` : "");
      if (!(await confirmDialog(text, { title: "Satzweisen Anbau löschen?" }))) return;
      ui.dlg.close();
      try {
        await api.del(`/api/goals/${g.id}`);
        await load();
        toast("Satzweiser Anbau gelöscht");
      } catch (e) { toast(e.message, { error: true }); }
    } }, "Löschen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Sätze anlegen" : "Speichern und Sätze anpassen"));
  paintWeeks();
  paintBeds();
  ui.open();
  if (focus === "bed") bedField.scrollIntoView({ block: "center" });
  if (g.crop_id) fillCrop(); else refresh();
}
