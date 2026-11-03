// Bonitur-Daten eines Jahres: Merkmale, Vorlagen, Pflanzen und Werte, dazu Auswertungshilfen.
import { api } from "./store.js";

export const bon = { year: null, traits: [], sets: [], plants: [], obs: [], loaded: false, error: null };

const listeners = new Set();
let idx = null;
let pending = null;

export function onBon(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  idx = null;
  for (const fn of listeners) fn();
}

export async function loadBonitur(year, { force = false } = {}) {
  if (!force && bon.year === year && bon.loaded) return;
  if (pending?.year === year && !force) return pending.promise;
  const promise = (async () => {
    try {
      const data = await api.get(`/api/bonitur?year=${year}`);
      Object.assign(bon, { year, traits: data.traits, sets: data.sets, plants: data.plants, obs: data.observations,
        loaded: true, error: null });
    } catch (e) {
      Object.assign(bon, { year, loaded: false, error: e.message });
    } finally {
      pending = null;
      changed();
    }
  })();
  pending = { year, promise };
  return promise;
}

// ---------------------------------------------------------------- Nachschlagen

function index() {
  if (idx) return idx;
  const traitById = new Map(bon.traits.map((t) => [t.id, t]));
  const traitByKey = new Map(bon.traits.map((t) => [t.key, t]));
  const plantById = new Map(bon.plants.map((p) => [p.id, p]));
  const plantsOf = new Map();
  for (const p of bon.plants) {
    if (!plantsOf.has(p.planting_id)) plantsOf.set(p.planting_id, []);
    plantsOf.get(p.planting_id).push(p);
  }
  for (const list of plantsOf.values()) list.sort((a, b) => a.num - b.num);
  const byTarget = new Map(); // "traitId|ziel" -> Werte nach Datum
  const byPlanting = new Map();
  const byPlant = new Map();
  const sorted = [...bon.obs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  for (const o of sorted) {
    const k = `${o.trait_id}|${targetKeyOf(o)}`;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(o);
    if (!byPlanting.has(o.planting_id)) byPlanting.set(o.planting_id, []);
    byPlanting.get(o.planting_id).push(o);
    if (o.plant_id != null) {
      if (!byPlant.has(o.plant_id)) byPlant.set(o.plant_id, []);
      byPlant.get(o.plant_id).push(o);
    }
  }
  idx = { traitById, traitByKey, plantById, plantsOf, byTarget, byPlanting, byPlant };
  return idx;
}

// Ziel eines Werts: eine Pflanze oder eine Sorte in einem Satz
export function targetKeyOf(o) {
  return o.plant_id != null ? `p${o.plant_id}` : `v${o.planting_id}|${o.variety}`;
}

export function plantTarget(plant) {
  return { key: `p${plant.id}`, plant, variety: plant.variety, planting_id: plant.planting_id };
}

export function varietyTarget(plantingId, variety) {
  return { key: `v${plantingId}|${variety}`, plant: null, variety, planting_id: plantingId };
}

export const traitById = (id) => index().traitById.get(id);
export const traitByKey = (key) => index().traitByKey.get(key);
export const plantById = (id) => index().plantById.get(id);
export const plantsOf = (plantingId) => index().plantsOf.get(plantingId) || [];
export const obsOfPlanting = (plantingId) => index().byPlanting.get(plantingId) || [];
export const obsOfPlant = (plantId) => index().byPlant.get(plantId) || [];

export function values(traitId, tkey) {
  return index().byTarget.get(`${traitId}|${tkey}`) || [];
}

// Letzter Wert bis einschließlich Tag (ISO), sonst überhaupt der letzte
export function latest(traitId, tkey, untilIso) {
  const list = values(traitId, tkey);
  for (let i = list.length - 1; i >= 0; i--) {
    if (!untilIso || list[i].date <= untilIso) return list[i];
  }
  return null;
}

export function onDate(traitId, tkey, iso) {
  return values(traitId, tkey).filter((o) => o.date === iso);
}

export function bbchOf(plant, untilIso) {
  const t = traitByKey("bbch");
  if (!t) return null;
  const o = latest(t.id, `p${plant.id}`, untilIso);
  return o ? o.value : null;
}

// Erster Tag, an dem eine Pflanze ein Stadium erreicht hat
export function firstReached(plant, code) {
  const t = traitByKey("bbch");
  if (!t) return null;
  const o = values(t.id, `p${plant.id}`).find((x) => x.value >= code);
  return o ? o.date : null;
}

export function median(nums) {
  const a = nums.filter((n) => n != null && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor((a.length - 1) / 2)];
}

// ---------------------------------------------------------------- Merkmale

export const GROUP_LABEL = { tomato: "Tomate", pepper: "Paprika & Chili", "": "ohne eigene Merkmale" };
export const SECTION_LABEL = {
  regular: "Regelmäßig", plant: "Pflanze und Blatt", flower: "Blüte", fruit: "Frucht", taste: "Verkostung",
  breeding: "Kreuzung und Saatgut",
};
export const FREQ_LABEL = { repeat: "regelmäßig", once: "einmalig", event: "je Ereignis" };
export const LEVEL_LABEL = { plant: "je Pflanze", variety: "je Sorte", both: "je Pflanze oder Sorte" };
export const TYPE_LABEL = {
  bbch: "BBCH-Stadium", score: "Note", choice: "Auswahl", multi: "Mehrfachauswahl", number: "Zahl", text: "Text",
  photo: "Foto", rated: "Befall mit Note", cross: "Kreuzung", amount: "Menge",
};

export function appliesTo(t, group, level) {
  if (!t.active) return false;
  if (t.grp !== "all" && t.grp !== group) return false;
  if (level === "plant") return t.level !== "variety";
  if (level === "variety") return t.level !== "plant";
  return true;
}

export function traitsFor(group, level) {
  return bon.traits.filter((t) => appliesTo(t, group, level));
}

// Ist der Zeitpunkt des Merkmals bei diesem Stadium gekommen?
export function inWindow(t, bbch) {
  if (t.bbch_from == null || bbch == null) return false;
  return bbch >= t.bbch_from && bbch <= t.bbch_to;
}

// ---------------------------------------------------------------- BBCH

export const BBCH_CODES = [0, 1, 3, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 72, 73, 74, 75, 76, 77, 78, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89, 97, 99];

export function bbchText(code, group) {
  if (code == null) return "";
  const pepper = group === "pepper";
  const n = code % 10;
  if (code < 10) {
    return { 0: "Trockener Samen", 1: "Beginn der Quellung", 3: "Ende der Quellung", 5: "Keimwurzel tritt aus dem Samen",
      7: "Keimling durchbricht die Samenschale", 9: "Auflaufen: Keimblätter durchbrechen die Bodenoberfläche" }[code]
      || "Keimung";
  }
  if (code === 10) return "Keimblätter voll entfaltet";
  if (code < 20) return n === 9 ? "9 und mehr Laubblätter am Haupttrieb entfaltet" : `${n}. Laubblatt am Haupttrieb entfaltet`;
  if (code < 30) return n === 9 ? "9 und mehr Seitentriebe sichtbar" : `${n}. Seitentrieb sichtbar`;
  if (code >= 51 && code <= 59) {
    if (pepper) return n === 9 ? "9 und mehr Blütenknospen sichtbar" : `${n === 1 ? "Erste" : `${n}.`} Blütenknospe sichtbar`;
    return n === 9 ? "9 und mehr Blütenstände sichtbar" : `${n}. Blütenstand sichtbar`;
  }
  if (code >= 61 && code <= 69) {
    if (pepper) return n === 9 ? "9 und mehr Blüten offen" : `${n}. Blüte offen`;
    return n === 9 ? "9 und mehr Blütenstände mit offenen Blüten" : `${n}. Blütenstand: erste Blüte offen`;
  }
  if (code >= 71 && code <= 79) {
    if (pepper) return n === 9 ? "9 und mehr Früchte haben typische Größe und Form" : `${n}. Frucht hat typische Größe und Form`;
    return n === 9 ? "9 und mehr Fruchtstände mit typischen Früchten" : `${n}. Fruchtstand: erste Frucht hat typische Größe und Form`;
  }
  if (code >= 81 && code <= 88) return `${n * 10} % der Früchte zeigen die typische Reifefarbe`;
  if (code === 89) return "Vollreife: Früchte zeigen die typische Reifefarbe";
  if (code === 97) return "Pflanze abgestorben";
  if (code === 99) return "Geerntetes Produkt";
  return `Stadium ${code}`;
}

export const BBCH_SHORT = {
  9: "Auflaufen", 10: "Keimblätter", 12: "2 Laubblätter", 14: "4 Laubblätter", 17: "7 Laubblätter",
  51: "Knospen", 61: "Blüte offen", 71: "Frucht gebildet", 81: "Reife beginnt", 89: "Vollreife",
};

let bbchIndex = null;
export async function bbchImages() {
  if (bbchIndex) return bbchIndex;
  try {
    const res = await fetch("img/bbch/index.json");
    bbchIndex = res.ok ? await res.json() : {};
  } catch {
    bbchIndex = {};
  }
  return bbchIndex;
}

// Bilder je Kultur; Paprika und Chili nutzen die Tomatenbilder, bis eigene da sind
export function bbchPictures(group) {
  const folder = group === "pepper" && bbchIndex?.paprika ? "paprika" : "tomate";
  const codes = bbchIndex?.[folder] || [];
  return codes.map((code) => ({ code, src: `img/bbch/${folder}-${String(code).padStart(2, "0")}.webp` }));
}

// ---------------------------------------------------------------- Werte als Text

function num(v, digits = 1) {
  return Number(v).toLocaleString("de-DE", { maximumFractionDigits: digits });
}

export function fmtValue(t, o) {
  const v = o?.value ?? o;
  if (!t) return "";
  if (t.type === "photo") return "";
  if (v == null || v === "") return "";
  switch (t.type) {
    case "bbch": return String(v).padStart(2, "0");
    case "score": return String(v);
    case "number": return t.unit ? `${num(v)} ${t.unit}` : num(v);
    case "multi": return Array.isArray(v) ? v.join(", ") : String(v);
    case "rated": return `${v.opt} ${v.score}`;
    case "cross": return `× ${v.donor}${v.mark ? ` (${v.mark})` : ""}`;
    case "amount": return `${num(v.v)} ${v.unit || ""}`.trim();
    default: return String(v);
  }
}

export function scoreLabel(t, v) {
  const labels = t.options && !Array.isArray(t.options) ? t.options : {};
  return labels[String(v)] || "";
}

export function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- Ändern

function upsertObs(list) {
  for (const o of list) {
    const i = bon.obs.findIndex((x) => x.id === o.id);
    if (i >= 0) bon.obs[i] = o;
    else bon.obs.push(o);
  }
}

export async function fixPlants(plantingId, spots, replace = false) {
  const res = await api.post(`/api/plantings/${plantingId}/plants`, { plants: spots, replace });
  bon.plants = bon.plants.filter((p) => p.planting_id !== plantingId).concat(res.plants);
  changed();
  return res.plants;
}

export async function addPlant(data) {
  const p = await api.post("/api/plants", data);
  bon.plants.push(p);
  changed();
  return p;
}

export async function patchPlant(id, changes) {
  const p = await api.patch(`/api/plants/${id}`, changes);
  const i = bon.plants.findIndex((x) => x.id === id);
  if (i >= 0) bon.plants[i] = p;
  if ("variety" in changes) for (const o of bon.obs) if (o.plant_id === id) o.variety = p.variety;
  changed();
  return p;
}

export async function deletePlant(id) {
  await api.del(`/api/plants/${id}`);
  bon.plants = bon.plants.filter((p) => p.id !== id);
  changed();
}

export async function setLabels(plantingId, labels) {
  const res = await api.put(`/api/plantings/${plantingId}/labels`, { labels });
  bon.plants = bon.plants.filter((p) => p.planting_id !== plantingId).concat(res.plants);
  changed();
}

export async function saveEntries(entries) {
  const res = await api.post("/api/observations", { entries });
  upsertObs(res.saved.map((s) => s.obs));
  changed();
  return res.saved;
}

export async function patchObs(id, changes) {
  const o = await api.patch(`/api/observations/${id}`, changes);
  upsertObs([o]);
  changed();
  return o;
}

export async function deleteObs(id) {
  await api.del(`/api/observations/${id}`);
  bon.obs = bon.obs.filter((o) => o.id !== id);
  changed();
}

// Speichern rückgängig: Neues löschen, Ersetztes zurückschreiben
export async function undoSaved(saved) {
  for (const s of saved) {
    if (s.before) {
      const { value, parts, note, photo, date } = s.before;
      await api.patch(`/api/observations/${s.obs.id}`, { value, parts, note, photo, date });
      upsertObs([s.before]);
    } else {
      await api.del(`/api/observations/${s.obs.id}`);
      bon.obs = bon.obs.filter((o) => o.id !== s.obs.id);
    }
  }
  changed();
}

export async function uploadPhoto(blob) {
  const res = await fetch("/api/photos", { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
  if (!res.ok) {
    let msg = `Foto konnte nicht hochgeladen werden (${res.status})`;
    try { msg = (await res.json()).detail || msg; } catch { /* keine JSON-Antwort */ }
    throw new Error(msg);
  }
  return (await res.json()).name;
}

export async function saveTrait(id, data) {
  const t = id ? await api.patch(`/api/traits/${id}`, data) : await api.post("/api/traits", data);
  const i = bon.traits.findIndex((x) => x.id === t.id);
  if (i >= 0) bon.traits[i] = t;
  else bon.traits.push(t);
  changed();
  return t;
}

export async function deleteTrait(id) {
  await api.del(`/api/traits/${id}`);
  bon.traits = bon.traits.filter((t) => t.id !== id);
  changed();
}

export async function saveSet(id, data) {
  const s = id ? await api.patch(`/api/trait-sets/${id}`, data) : await api.post("/api/trait-sets", data);
  const i = bon.sets.findIndex((x) => x.id === s.id);
  if (i >= 0) bon.sets[i] = s;
  else bon.sets.push(s);
  changed();
  return s;
}

export async function deleteSet(id) {
  await api.del(`/api/trait-sets/${id}`);
  bon.sets = bon.sets.filter((s) => s.id !== id);
  changed();
}
