import { state, load, subscribe, setDay, undo, select, setMode } from "./store.js";
import { h, fmtDay, isoWeek, isoOf, dayNum, todayNum, yearOf, MONTHS_SHORT } from "./util.js";
import { toast, iconBtn } from "./ui.js";
import { mountMap } from "./map.js";
import { mountTimeline } from "./timeline.js";
import { mountPlantings } from "./plantings.js";
import { mountCrops } from "./crops.js";
import { openSettings } from "./editor.js";

const VIEWS = {
  karte: mountMap,
  zeitleiste: mountTimeline,
  saetze: mountPlantings,
  kulturen: mountCrops,
};

const root = document.getElementById("view");
let current = null;
let currentName = null;

function route() {
  const name = location.hash.replace("#", "") || "karte";
  const viewName = VIEWS[name] ? name : "karte";
  if (viewName === currentName) return;
  current?.destroy?.();
  root.replaceChildren();
  currentName = viewName;
  if (state.mode && viewName !== "karte") setMode(null);
  current = VIEWS[viewName](root);
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.view === viewName) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

// ---------------------------------------------------------------- Stichtag in der Kopfzeile

const picker = document.getElementById("daypicker");

function renderDaypicker() {
  const d = state.day;
  const input = h("input", {
    type: "date", value: isoOf(d), "aria-label": "Stichtag wählen",
    onchange: (e) => { if (e.target.value) setDay(dayNum(e.target.value)); },
  });
  const tag = h("label", { class: "tag", title: "Stichtag: Karte und Zeitleiste zeigen diesen Tag" },
    h("span", { class: "num" }, fmtDay(d, { year: true })),
    h("span", { class: "kw" }, `KW ${isoWeek(d)}`),
    input);
  const isToday = d === todayNum();
  picker.replaceChildren(...[
    iconBtn("left", "Eine Woche zurück", () => setDay(state.day - 7)),
    tag,
    iconBtn("right", "Eine Woche vor", () => setDay(state.day + 7)),
    isToday ? null : h("button", { type: "button", class: "icon-btn today-btn", onclick: () => setDay(todayNum()) }, "Heute"),
  ].filter(Boolean));
}

document.getElementById("settings-btn").addEventListener("click", openSettings);

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
  if (document.querySelector("dialog[open]")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "Escape") {
    if (state.mode) setMode(null);
    else if (state.sel) select(null);
  } else if (e.key === "[" || e.key === "PageUp") {
    setDay(state.day - 7);
  } else if (e.key === "]" || e.key === "PageDown") {
    setDay(state.day + 7);
  }
});

subscribe((reason) => {
  if (reason === "day" || reason === "data") renderDaypicker();
  current?.update?.(reason);
});

window.addEventListener("hashchange", route);

async function start() {
  renderDaypicker();
  try {
    await load();
  } catch (e) {
    root.replaceChildren(h("div", { class: "page" }, h("div", { class: "page-inner" },
      h("div", { class: "empty-note" }, `Die Daten konnten nicht geladen werden: ${e.message}. Läuft der Server?`))));
    return;
  }
  route();
}

start();

// Für die Fehlersuche in der Browserkonsole
window.beetwerk = { state, yearOf, MONTHS_SHORT, toast };
