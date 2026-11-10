// Düngung je Satz: Stickstoffmenge und Termine.
//
// Grundlage ist das Merkblatt 2202 der Bayerischen Gartenakademie (LWG, Dezember 2020): drei Stufen mit
// Höchstmengen – gering, mittel, hoch = rund 6,5 / 13 / 19,5 g Stickstoff je m² – und die Aufteilung je nach
// Dünger: Horndünger wird bei Saat oder Pflanzung eingearbeitet (bei „hoch“ die Hälfte 3 bis 4 Wochen später),
// schnell wirkender Mineraldünger kommt in Teilgaben. Die Stufe je Kultur und ihre Quelle stehen in feeding.py.
import { phases, spanOf, isoOf } from "./util.js";

export const FEED_LEVELS = { none: 0, low: 6.5, medium: 13, high: 19.5 };
export const FEED_LABEL = { "": "nicht festgelegt", none: "keine", low: "gering", medium: "mittel", high: "hoch" };
const CUT_GAP = 35; // Schnittkulturen: Nachdüngung alle fünf Wochen ab der ersten Ernte
const CUT_MAX = 3;

// Stickstoff in g/m², den die Kultur über ihre Kulturzeit bekommt (ohne Anpassung an den Boden)
export function feedNeed(crop) {
  if (!crop || !crop.feed || crop.feed === "none") return 0;
  return crop.feed_n > 0 ? crop.feed_n : FEED_LEVELS[crop.feed] ?? 0;
}

// Stufe, nach der aufgeteilt wird; eine eigene Menge zählt zur nächstgelegenen Stufe
function tierOf(crop, need) {
  if (!(crop.feed_n > 0)) return crop.feed;
  return need <= 9.75 ? "low" : need <= 16.25 ? "medium" : "high";
}

// Aufteilung als Liste [Tage nach Saat oder Pflanzung, Anteil]
function baseSplit(crop, p, tier, speed) {
  if (speed !== "fast") return tier === "high" ? [[0, 0.5], [24, 0.5]] : [[0, 1]];
  // schnell wirkend: eine Woche nach der Pflanzung, zwei nach der Saat – oder der Tag, den die Kultur vorgibt
  if (tier === "low") return [[crop.feed_start || (p.method === "transplant" ? 7 : 14), 1]];
  const s = crop.feed_start || 0;
  return tier === "medium" ? [[s, 0.5], [s + 21, 0.5]] : [[s, 1 / 3], [s + 21, 1 / 3], [s + 35, 1 / 3]];
}

// Der gewählte Dünger (aus den Einstellungen), sonst der erste der Liste
export function chosenFertilizer(settings, fertilizers) {
  return (fertilizers || []).find((f) => String(f.id) === String(settings?.fert_id)) ?? fertilizers?.[0] ?? null;
}

// Düngeplan eines Satzes.
//   need   g N/m² nach Anpassung (0, wenn nicht gedüngt wird)   reason  warum nicht: unset | none | off | late
//   area   m²                                                    total   g N für den ganzen Satz
//   items  [{ i, day, share, n (g N), grams (g Dünger), cut, done (Datum oder null) }]
export function feedPlan(p, crop, bed, settings = {}, fertilizers = []) {
  const fert = chosenFertilizer(settings, fertilizers);
  const ph = phases(p);
  const area = p.len * spanOf(p, bed);
  let reason = null;
  if (!crop || !crop.feed) reason = "unset";
  else if (crop.feed === "none") reason = "none";
  else if (p.no_feed) reason = "off";
  else if (crop.feed_late && Number(isoOf(ph.fieldStart).slice(5, 7)) >= 8) reason = "late";
  const raw = reason ? 0 : feedNeed(crop);
  if (!(raw > 0)) return { need: 0, area, total: 0, fert, items: [], reason: reason ?? "none" };
  const need = raw * (Number(settings.feed_factor) || 100) / 100;

  let split = baseSplit(crop, p, tierOf(crop, raw), fert?.speed ?? "slow").map(([d, share]) => ({ d, share, cut: false }));
  if (crop.feed_cut) {
    // Schnittkultur: die Hälfte zum Start, die andere Hälfte nach den Schnitten – solange noch geerntet wird
    const cuts = [];
    for (let k = 0; k < CUT_MAX; k++) {
      const day = ph.hs + 7 + k * CUT_GAP;
      if (day <= ph.he - 21) cuts.push(day - ph.fieldStart);
    }
    if (cuts.length) {
      split = [...split.map((x) => ({ ...x, share: x.share / 2 })), ...cuts.map((d) => ({ d, share: 0.5 / cuts.length, cut: true }))];
    }
  }
  const items = split.filter((x) => ph.fieldStart + x.d <= ph.he).map((x, i) => {
    const n = need * x.share * area;
    return { i, day: ph.fieldStart + x.d, after: x.d, share: x.share, n, grams: fert ? n / (fert.n_pct / 100) : null,
      cut: x.cut, done: p.fed?.[i] ?? null };
  });
  return { need, area, total: items.reduce((t, x) => t + x.n, 0), fert, items, reason: null };
}

// Wann eine Gabe fällig ist, in Worten
export function feedWhen(item, p) {
  if (item.cut) return "nach dem Schnitt";
  const what = p.method === "transplant" ? "Pflanzung" : "Saat";
  if (item.after === 0) return `zur ${what}`;
  return item.after % 7 === 0 ? `${item.after / 7} ${item.after === 7 ? "Woche" : "Wochen"} nach der ${what}` : `${item.after} Tage nach der ${what}`;
}

// Düngermenge lesbar: auf 5 g gerundet, kleine Mengen auf 1 g, ab 1 kg in kg
export function gramsText(g) {
  if (g == null) return "";
  if (g >= 1000) return `${(Math.round(g / 10) / 100).toLocaleString("de-DE")} kg`;
  const r = g >= 50 ? Math.round(g / 5) * 5 : Math.max(1, Math.round(g));
  return `${r} g`;
}

// Offene Gaben aller Sätze mit Beet zwischen zwei Tagen (einschließlich), nach Termin sortiert
export function feedTasks(state, from, to) {
  const out = [];
  for (const p of state.plantings) {
    if (!p.bed_id) continue;
    const crop = state.crops.find((c) => c.id === p.crop_id);
    const bed = state.beds.find((b) => b.id === p.bed_id);
    for (const item of feedPlan(p, crop, bed, state.settings, state.fertilizers).items) {
      if (!item.done && item.day >= from && item.day <= to) out.push({ p, crop, bed, item });
    }
  }
  return out.sort((a, b) => a.item.day - b.item.day || a.p.id - b.p.id);
}

// Stickstoff, der im Jahr auf ein Beet kommt: Summe in g und bezogen auf die Beetfläche
export function bedFeed(state, bed, year) {
  let total = 0;
  for (const p of state.plantings) {
    if (p.bed_id !== bed.id) continue;
    const crop = state.crops.find((c) => c.id === p.crop_id);
    for (const item of feedPlan(p, crop, bed, state.settings, state.fertilizers).items) {
      if (Number(isoOf(item.day).slice(0, 4)) === year) total += item.n;
    }
  }
  const size = bed.length * bed.width;
  return { total, perM2: size > 0 ? total / size : 0 };
}
