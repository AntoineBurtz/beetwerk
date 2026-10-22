// Zentraler Zustand: Daten vom Server, Stichtag, Auswahl. Änderungen laufen optimistisch.
import { analyse, todayNum } from "./util.js";
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
  day: initialDay(),
  sel: null, // { type: "bed" | "planting", id }
  placing: null, // Kultur-ID, die als Nächstes aufs Beet gesetzt wird
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
  if (reason === "data") issues = analyse(state);
  for (const fn of listeners) fn(reason);
}

export function issuesOf(id) {
  return issues.get(id) || [];
}

export const find = {
  bed: (id) => state.beds.find((b) => b.id === id),
  crop: (id) => state.crops.find((c) => c.id === id),
  planting: (id) => state.plantings.find((p) => p.id === id),
};

const LIST = { beds: "beds", crops: "crops", plantings: "plantings" };

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

export function setPlacing(cropId) {
  state.placing = cropId;
  emit("select");
}

export async function create(kind, data) {
  try {
    const item = await api.post(`/api/${kind}`, data);
    state[LIST[kind]].push(item);
    if (kind === "crops") state.crops.sort((a, b) => a.name.localeCompare(b.name, "de"));
    emit("data");
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

export async function remove(kind, id, { undoLabel } = {}) {
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
    if (state.sel && state.sel.id === id) state.sel = null;
    emit("data");
    if (undoLabel) pushUndo({ type: "delete", kind, item: gone, orphans, label: undoLabel });
  } catch (e) {
    toast(e.message, { error: true });
    throw e;
  }
}

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
  toast(entry.label, { action: "Rückgängig", onAction: undo });
}

export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  try {
    if (entry.type === "patch") {
      await patch(entry.kind, entry.id, entry.before);
    } else if (entry.type === "delete") {
      const { id, ...rest } = entry.item;
      const restored = await create(entry.kind, rest);
      if (entry.kind === "beds") {
        // Sätze, die vorher in diesem Beet standen, wieder zuordnen
        for (const p of entry.orphans || []) await patch("plantings", p, { bed_id: restored.id });
      }
    }
    toast("Rückgängig gemacht");
  } catch { /* Meldung kam schon */ }
}
