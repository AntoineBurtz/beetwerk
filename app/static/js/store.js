// Zentraler Zustand: Daten vom Server, Stichtag, Auswahl. Änderungen laufen optimistisch.
import { analyse, todayNum, rules } from "./util.js";
import { toast } from "./ui.js";

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Fehler ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail) && j.detail[0]?.msg) msg = j.detail[0].msg.replace(/^Value error, /, "");
    } catch { /* keine JSON-Antwort */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (url) => request("GET", url),
  post: (url, body) => request("POST", url, body ?? {}),
  patch: (url, body) => request("PATCH", url, body),
  put: (url, body) => request("PUT", url, body),
  del: (url) => request("DELETE", url),
};

function initialDay() {
  try {
    const saved = Number(sessionStorage.getItem("beetwerk.day"));
    if (saved) return saved;
  } catch { /* Speicher nicht verfügbar */ }
  return todayNum();
}

export const state = {
  settings: {},
  beds: [],
  crops: [],
  plantings: [],
  varieties: [], // Sortenliste
  containers: [], // Anzuchtgefäße
  places: [], // Anzuchtplätze
  people: [], // Freunde, die Jungpflanzen bekommen
  handovers: [], // ihre Wünsche
  goals: [], // Ernteziele für Folgesätze
  seriesOpen: new Set(), // Ernteziele, deren Sätze die Zeitleiste einzeln statt als Satzfolge zeigt
  marked: new Set(), // mehrere markierte Sätze (IDs) zum gemeinsamen Ändern oder Löschen
  day: initialDay(),
  sel: null, // { type: "bed" | "planting", id }
  // Modus der Karte: Kultur setzen, Satz ohne Beet zuweisen oder neue Fläche aufziehen
  mode: null, // { type: "crop", id } | { type: "planting", id } | { type: "bed", kind }
  loaded: false,
};

let issues = new Map();
const listeners = new Set();
const undoStack = [];

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = "data") {
  if (reason === "data") {
    rules.uniformBeds = state.settings?.bed_mode === "uniform";
    for (const id of state.marked) if (!state.plantings.some((p) => p.id === id)) state.marked.delete(id);
    issues = analyse(state);
  }
  for (const fn of listeners) fn(reason);
}

export function issuesOf(id) {
  return issues.get(id) || [];
}

export const find = {
  bed: (id) => state.beds.find((b) => b.id === id),
  crop: (id) => state.crops.find((c) => c.id === id),
  planting: (id) => state.plantings.find((p) => p.id === id),
  variety: (id) => state.varieties.find((v) => v.id === id),
  container: (id) => state.containers.find((c) => c.id === id),
  place: (id) => state.places.find((p) => p.id === id),
  person: (id) => state.people.find((p) => p.id === id),
};

const LIST = { beds: "beds", crops: "crops", plantings: "plantings", varieties: "varieties",
  containers: "containers", places: "places", people: "people", handovers: "handovers" };

export async function load() {
  const data = await api.get("/api/data");
  Object.assign(state, data, { loaded: true });
  if (state.sel && !find[state.sel.type]?.(state.sel.id)) state.sel = null;
  emit("data");
}

export function replaceAll(data) {
  Object.assign(state, data);
  state.sel = null;
  emit("data");
}

export function setDay(n) {
  if (n === state.day) return;
  state.day = n;
  try { sessionStorage.setItem("beetwerk.day", String(n)); } catch { /* egal */ }
  emit("day");
}

export function select(sel) {
  state.sel = sel;
  emit("select");
}

export function setMode(mode) {
  state.mode = mode;
  emit("select");
}

// Mehrfachauswahl von Sätzen: on = true/false setzt, sonst umschalten
export function mark(ids, on = null) {
  const list = [...ids];
  const turnOn = on ?? !list.every((id) => state.marked.has(id));
  for (const id of list) {
    if (turnOn) state.marked.add(id); else state.marked.delete(id);
  }
  emit("select");
}

export function clearMarks() {
  if (!state.marked.size) return;
  state.marked.clear();
  emit("select");
}

// Mehrere Einträge nacheinander ändern; ein Schritt zum Rückgängigmachen
export async function patchMany(kind, list, { undoLabel } = {}) {
  const done = [];
  for (const { id, changes } of list) {
    const item = state[LIST[kind]].find((x) => x.id === id);
    if (!item) continue;
    // changes darf eine Funktion sein: sie sieht dann schon die vorher geänderten Einträge
    const ch = typeof changes === "function" ? changes(item) : changes;
    if (!ch || !Object.keys(ch).length) continue;
    const before = {};
    for (const k of Object.keys(ch)) before[k] = item[k];
    try {
      await patch(kind, id, ch);
      done.push({ type: "patch", kind, id, before });
    } catch { break; }
  }
  if (undoLabel && done.length) pushUndo({ type: "group", entries: done, label: undoLabel });
  return done.length;
}

// Löscht, was geht; was der Server ablehnt (z. B. Sätze mit Boniturwerten), bleibt und kommt in failed zurück
export async function removeMany(kind, ids, { undoLabel } = {}) {
  const done = [];
  const failed = [];
  for (const id of ids) {
    const item = state[LIST[kind]].find((x) => x.id === id);
    if (!item) continue;
    try {
      await remove(kind, id, { silent: true });
      done.push({ type: "delete", kind, item, orphans: [] });
    } catch (e) {
      failed.push({ id, item, message: e.message });
    }
  }
  const label = typeof undoLabel === "function" ? undoLabel(done.length) : undoLabel;
  if (label && done.length) pushUndo({ type: "group", entries: done, label });
  return { done: done.length, failed };
}

export async function create(kind, data, { undoLabel } = {}) {
  try {
    const item = await api.post(`/api/${kind}`, data);
    state[LIST[kind]].push(item);
    if (kind === "crops") state.crops.sort((a, b) => a.name.localeCompare(b.name, "de"));
    if (kind === "varieties") state.varieties.sort((a, b) => a.name.localeCompare(b.name, "de"));
    if (kind === "people") state.people.sort((a, b) => a.name.localeCompare(b.name, "de"));
    emit("data");
    if (undoLabel) pushUndo({ type: "create", kind, id: item.id, label: undoLabel });
    return item;
  } catch (e) {
    toast(e.message, { error: true });
    throw e;
  }
}

// Ändert sofort lokal und schreibt dann zum Server; bei Fehler zurück auf den alten Stand.
export async function patch(kind, id, changes, { undoLabel, silent } = {}) {
  const list = state[LIST[kind]];
  const item = list.find((x) => x.id === id);
  if (!item) return;
  const before = {};
  for (const k of Object.keys(changes)) before[k] = item[k];
  Object.assign(item, changes);
  emit("data");
  try {
    const saved = await api.patch(`/api/${kind}/${id}`, changes);
    Object.assign(item, saved);
    emit("data");
    if (undoLabel) pushUndo({ type: "patch", kind, id, before, label: undoLabel });
    return saved;
  } catch (e) {
    Object.assign(item, before);
    emit("data");
    if (!silent) toast(e.message, { error: true });
    throw e;
  }
}

export async function remove(kind, id, { undoLabel, silent } = {}) {
  const list = state[LIST[kind]];
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const orphans = kind === "beds" ? state.plantings.filter((p) => p.bed_id === id).map((p) => p.id) : [];
  try {
    await api.del(`/api/${kind}/${id}`);
    const [gone] = list.splice(idx, 1);
    if (kind === "beds") {
      for (const p of state.plantings) if (p.bed_id === id) p.bed_id = null;
    }
    if (kind === "people") state.handovers = state.handovers.filter((x) => x.person_id !== id);
    if (kind === "places") {
      for (const c of state.crops) {
        if (c.place_id === id) c.place_id = null;
        if (c.grow_place_id === id) c.grow_place_id = null;
      }
    }
    if (state.sel && state.sel.id === id) state.sel = null;
    emit("data");
    if (undoLabel) pushUndo({ type: "delete", kind, item: gone, orphans, label: undoLabel });
  } catch (e) {
    if (!silent) toast(e.message, { error: true });
    throw e;
  }
}

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
  toast(entry.label, { action: "Rückgängig", onAction: undo });
}

async function undoEntry(entry) {
  if (entry.type === "group") {
    for (const e of [...entry.entries].reverse()) await undoEntry(e);
  } else if (entry.type === "patch") {
    await patch(entry.kind, entry.id, entry.before);
  } else if (entry.type === "create") {
    await remove(entry.kind, entry.id);
  } else if (entry.type === "delete") {
    const { id, ...rest } = entry.item;
    const restored = await create(entry.kind, rest);
    if (entry.kind === "beds") {
      // Sätze, die vorher in diesem Beet standen, wieder zuordnen
      for (const p of entry.orphans || []) await patch("plantings", p, { bed_id: restored.id });
    }
  }
}

export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  try {
    await undoEntry(entry);
    toast("Rückgängig gemacht");
  } catch { /* Meldung kam schon */ }
}
