// Bonitur: Pflanzen im Beet bewerten, einzeln oder als Block, regelmäßig oder einmalig.
import { state, find } from "./store.js";
import {
  h, todayNum, isoOf, dayNum, yearOf, fmtDay, fmtNum, plural, phases, isMixed, mixPlan, varietyColor,
  varietyText,
} from "./util.js";
import { toast, confirmDialog, icon, iconBtn } from "./ui.js";
import { shell, field } from "./editor.js";
import {
  bon, onBon, loadBonitur, bbchImages, plantsOf, plantById, traitByKey, traitById, values, latest, onDate,
  bbchOf, firstReached, median, appliesTo, traitsFor, bySection, inWindow, fmtValue, sameValue, plantTarget, varietyTarget,
  obsOfPlanting, obsOfPlant, fixPlants, addPlant, patchPlant, deletePlant, setLabels, saveEntries, patchObs,
  deleteObs, undoSaved, uploadPhoto, saveTrait, deleteTrait, saveSet, deleteSet, SECTION_LABEL, FREQ_LABEL,
  LEVEL_LABEL, TYPE_LABEL, GROUP_LABEL, bbchText,
} from "./bstore.js";
import { widget } from "./bwidgets.js";
import { baserowStatus, statusChip, syncNow } from "./baserowsetup.js";
import { link, openPlantingOverview } from "./overview.js";

function readSession(key) {
  try { return JSON.parse(sessionStorage.getItem(`beetwerk.${key}`)); } catch { return null; }
}
function writeSession(key, v) {
  try { sessionStorage.setItem(`beetwerk.${key}`, JSON.stringify(v)); } catch { /* egal */ }
}

// Zustand der Seite, bleibt beim Wechsel zwischen den Ansichten erhalten
const ui = {
  date: todayNum(),
  plantingId: readSession("bonitur.planting"),
  tab: readSession("bonitur.tab") || "erfassen",
  level: "plant",
  sel: new Set(),
  selVar: new Set(),
  keys: [],
  mode: "all",
  step: 0,
  draft: {},
  carry: {},
  note: "",
  listAll: false,
  overview: "plant",
  saving: false,
};

// Von außen (Karte) einen Satz zur Bonitur öffnen
export function openBonitur(plantingId) {
  openPlanting(plantingId);
  location.hash = "#bonitur";
}

function openPlanting(id) {
  if (ui.plantingId !== id) {
    ui.sel = new Set();
    ui.selVar = new Set();
    ui.step = 0;
    ui.draft = {};
    ui.carry = {};
    ui.note = "";
  }
  ui.plantingId = id;
  writeSession("bonitur.planting", id);
}

const iso = () => isoOf(ui.date);

// ---------------------------------------------------------------- Hilfen zu Sätzen und Sorten

function plantingsOfYear(year) {
  const y = String(year);
  return state.plantings.filter((p) => p.sow_date.slice(0, 4) <= y && p.harvest_end.slice(0, 4) >= y);
}

function groupOf(p) {
  return find.crop(p.crop_id)?.trait_group || "";
}

function varietiesOf(p) {
  const names = isMixed(p) ? p.varieties.map((v) => v.name) : [p.variety || ""];
  for (const pl of plantsOf(p.id)) if (!names.includes(pl.variety)) names.push(pl.variety);
  return names;
}

function varietyColorOf(p, name) {
  if (!isMixed(p)) return find.crop(p.crop_id)?.color || "var(--leaf)";
  const i = p.varieties.findIndex((v) => v.name === name);
  return i >= 0 ? varietyColor(i) : "#7f8d84";
}

function varietyLabel(p, name) {
  return name || find.crop(p.crop_id)?.name || "Sorte";
}

function plantName(pl) {
  return `Pflanze ${pl.num}${pl.label ? ` · ${pl.label}` : ""}`;
}

function plantPlace(pl) {
  return pl.row ? `Reihe ${pl.row}, Platz ${pl.place}` : "ohne Platz";
}

function targetsOf(p) {
  if (ui.level === "variety") {
    return varietiesOf(p).filter((v) => ui.selVar.has(v)).map((v) => varietyTarget(p.id, v));
  }
  return plantsOf(p.id).filter((pl) => ui.sel.has(pl.id)).map(plantTarget);
}

function targetName(p, tg) {
  return tg.plant ? `${plantName(tg.plant)} · ${varietyLabel(p, tg.variety)}` : varietyLabel(p, tg.variety);
}

// Stadium einer Sorte = Median ihrer Pflanzen
function bbchOfTarget(p, tg) {
  if (tg.plant) return bbchOf(tg.plant, iso());
  return median(plantsOf(p.id).filter((pl) => pl.variety === tg.variety && pl.status !== "gone").map((pl) => bbchOf(pl, iso())));
}

function existingFor(t, tg) {
  if (t.freq === "once") return values(t.id, tg.key)[0] || null;
  if (t.freq === "repeat" && t.type !== "rated") return onDate(t.id, tg.key, iso())[0] || null;
  return null;
}

function isDone(t, tg) {
  return values(t.id, tg.key).length > 0;
}

// Einmalige Merkmale, deren Zeitpunkt gekommen ist und die noch fehlen
function dueKeys(p, tgs) {
  const list = tgs.length ? tgs : (ui.level === "variety"
    ? varietiesOf(p).map((v) => varietyTarget(p.id, v))
    : plantsOf(p.id).filter((pl) => pl.status !== "gone").map(plantTarget));
  const stage = new Map(list.map((tg) => [tg.key, bbchOfTarget(p, tg)]));
  return traitsFor(groupOf(p), ui.level)
    .filter((t) => t.freq === "once")
    .filter((t) => list.some((tg) => !isDone(t, tg) && (ui.level === "variety" ? t.bbch_from == null || inWindow(t, stage.get(tg.key)) : inWindow(t, stage.get(tg.key)))))
    .map((t) => t.key);
}

function formTraits(p) {
  const group = groupOf(p);
  return ui.keys.map(traitByKey).filter((t) => t && appliesTo(t, group, ui.level));
}

function orderKeys(keys) {
  const pos = new Map(bon.traits.map((t, i) => [t.key, i]));
  return [...new Set(keys)].filter((k) => pos.has(k)).sort((a, b) => pos.get(a) - pos.get(b));
}

function donorNames() {
  return bon.plants.map((pl) => pl.label || `${find.crop(find.planting(pl.planting_id)?.crop_id)?.name ?? ""} ${pl.planting_id}-${pl.num}`.trim());
}

// ---------------------------------------------------------------- Seite

export function mountBonitur(root) {
  const page = h("div", { class: "page bon-page" });
  root.append(page);
  // Zustand des Abgleichs mit Baserow: beim Öffnen, regelmäßig und kurz nach dem Speichern
  let bsr = null;
  const bsrTimers = {};
  const refreshBsr = async () => {
    try { bsr = await baserowStatus({ fresh: true }); } catch { bsr = null; }
    // Solange Werte warten und der Abgleich automatisch läuft, bald noch einmal nachsehen
    if (bsr?.connected && bsr.auto && (bsr.pending || bsr.running) && !bsr.last_error) later("after", 8000);
    const chip = page.querySelector(".baserow-chip");
    const next = statusChip(bsr, onChip);
    if (chip && next) chip.replaceWith(next);
    else if (chip) chip.remove();
    else if (next) render();
  };
  const onChip = async (e) => {
    e.currentTarget.disabled = true;
    try { await syncNow(); } catch { /* Meldung kam schon */ }
    refreshBsr();
  };
  const later = (name, ms) => { clearTimeout(bsrTimers[name]); bsrTimers[name] = setTimeout(refreshBsr, ms); };
  refreshBsr();
  const bsrPoll = setInterval(() => { if (document.visibilityState === "visible") refreshBsr(); }, 60000);
  const off = onBon(() => {
    render();
    later("quick", 1500);                                  // „Werte warten“ zeigen
    if (bsr?.connected && bsr.auto) later("after", 22000);  // nach dem automatischen Abgleich
  });
  // Beim Öffnen und beim Zurückkehren in den Browser frisch laden (z. B. Werte vom Handy)
  loadBonitur(yearOf(ui.date), { force: true });
  const onVisible = () => { if (document.visibilityState === "visible") loadBonitur(yearOf(ui.date), { force: true }); };
  document.addEventListener("visibilitychange", onVisible);
  let imagesReady = false;
  bbchImages().then(() => { imagesReady = true; render(); });

  function ensureYear() {
    const year = yearOf(ui.date);
    if (bon.year !== year || (!bon.loaded && !bon.error)) loadBonitur(year);
  }

  function render() {
    ensureYear();
    const keep = page.scrollTop;
    const year = yearOf(ui.date);
    const p = ui.plantingId != null ? find.planting(ui.plantingId) : null;
    if (ui.plantingId != null && !p && state.loaded) openPlanting(null);
    const inner = h("div", { class: "page-inner" }, head(year));
    if (bon.error) {
      inner.append(h("div", { class: "empty-note" }, `Die Bonitur konnte nicht geladen werden: ${bon.error}`,
        h("div", { style: { marginTop: "8px" } }, h("button", { type: "button", class: "btn btn-sm", onclick: () => loadBonitur(year, { force: true }) }, "Nochmal versuchen"))));
    } else if (!bon.loaded || bon.year !== year || !imagesReady) {
      inner.append(h("div", { class: "muted" }, "Lade Bonitur …"));
    } else if (p) {
      inner.append(...plantingView(p));
    } else {
      inner.append(plantingList(year));
    }
    page.replaceChildren(inner);
    page.scrollTop = keep;
    // Meldungen über die Speicherleiste heben, damit sie den Knopf nicht verdecken
    document.body.classList.toggle("bon-bar-on", !!page.querySelector(".bon-savebar"));
  }

  // ------------------------------------------------------------ Kopf

  function head(year) {
    const date = h("input", { type: "date", class: "input bon-date", value: iso(), "aria-label": "Datum der Bonitur",
      onchange: (e) => {
        if (!e.target.value) return;
        const before = yearOf(ui.date);
        ui.date = dayNum(e.target.value);
        if (yearOf(ui.date) !== before) openPlanting(null);
        render();
      } });
    const search = h("input", { type: "search", class: "input bon-search", placeholder: "Etikett suchen", enterkeyhint: "search",
      "aria-label": "Pflanze über ihr Etikett finden", autocapitalize: "characters",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); findLabel(e.target.value); } } });
    return h("div", { class: "page-head bon-head" },
      h("h1", {}, "Bonitur"),
      h("label", { class: "bon-date-wrap" }, h("span", { class: "muted small" }, "Datum"), date,
        ui.date !== todayNum() ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { ui.date = todayNum(); render(); } }, "Heute") : null),
      search,
      statusChip(bsr, onChip),
      h("button", { type: "button", class: "btn", onclick: () => openCatalog() }, "Merkmale"),
      h("a", { class: "btn", href: `/api/bonitur.csv?year=${year}`, download: `bonitur-${year}.csv`, title: "Alle Werte des Jahres als Tabelle (CSV)" },
        icon("download"), "CSV"));
  }

  function findLabel(q) {
    const s = q.trim().toLowerCase();
    if (!s) return;
    const hit = bon.plants.find((pl) => pl.label.toLowerCase() === s)
      || bon.plants.find((pl) => pl.label.toLowerCase().includes(s));
    if (!hit) {
      toast(`Kein Etikett „${q.trim()}“ in ${bon.year}`, { error: true });
      return;
    }
    openPlanting(hit.planting_id);
    ui.tab = "erfassen";
    ui.level = "plant";
    ui.sel = new Set([hit.id]);
    ui.step = 0;
    render();
    page.querySelector(".bon-form, .bon-select")?.scrollIntoView({ block: "start" });
  }

  // ------------------------------------------------------------ Sätze des Jahres

  function plantingList(year) {
    const all = plantingsOfYear(year);
    const withGroup = all.filter((p) => groupOf(p));
    const showAll = ui.listAll || !withGroup.length;
    const order = { tomato: 0, pepper: 1, "": 2 };
    const list = (showAll ? all : withGroup).sort((a, b) =>
      order[groupOf(a)] - order[groupOf(b)]
      || (find.crop(a.crop_id)?.name || "").localeCompare(find.crop(b.crop_id)?.name || "", "de")
      || a.sow_date.localeCompare(b.sow_date));
    const sectionEl = h("section", { class: "section" },
      h("div", { class: "section-head" },
        h("h2", {}, `Sätze ${year}`),
        withGroup.length && withGroup.length < all.length ? h("div", { class: "seg", role: "radiogroup", "aria-label": "Welche Sätze" },
          segOpt("bon-list", "Tomate und Paprika", !showAll, () => { ui.listAll = false; render(); }),
          segOpt("bon-list", "Alle Kulturen", showAll, () => { ui.listAll = true; render(); })) : null));
    if (!list.length) {
      sectionEl.append(h("div", { class: "empty-note" }, `Für ${year} gibt es keine Sätze. Lege sie unter „Sätze“ oder auf der Karte an.`));
      return sectionEl;
    }
    sectionEl.append(h("div", { class: "bon-cards" }, list.map(card)));
    if (!withGroup.length) {
      sectionEl.append(h("p", { class: "muted small", style: { margin: 0 } },
        "Tomaten, Paprika und Chili bekommen eigene Merkmale. Welche Kultur dazu gehört, stellst du unter „Kulturen“ ein."));
    }
    return sectionEl;
  }

  function card(p) {
    const crop = find.crop(p.crop_id);
    const bed = find.bed(p.bed_id);
    const plants = plantsOf(p.id);
    const obs = obsOfPlanting(p.id);
    const last = obs.length ? obs[obs.length - 1].date : null;
    const stages = plants.filter((pl) => pl.status !== "gone").map((pl) => bbchOf(pl, iso())).filter((v) => v != null);
    const lo = stages.length ? Math.min(...stages) : null, hi = stages.length ? Math.max(...stages) : null;
    const group = groupOf(p);
    return h("button", { type: "button", class: "bon-card", style: `--c:${crop?.color || "#6a9b3c"}`,
      onclick: () => { openPlanting(p.id); render(); page.scrollTop = 0; } },
      h("span", { class: "bon-card-title" }, crop?.name ?? "Kultur",
        varietyText(p) ? h("span", { class: "v" }, ` ${varietyText(p)}`) : null),
      h("span", { class: "bon-card-meta" }, [bed?.name || "ohne Beet",
        plants.length ? plural(plants.length, "Pflanze", "Pflanzen") : "Pflanzen noch nicht festgelegt"].join(" · ")),
      h("span", { class: "bon-card-meta" },
        last ? `zuletzt bonitiert am ${fmtDay(dayNum(last))}` : "noch keine Werte",
        lo != null ? h("span", { class: "bbch-badge" }, lo === hi ? `BBCH ${lo}` : `BBCH ${lo}–${hi}`) : null),
      group ? h("span", { class: "fam" }, GROUP_LABEL[group]) : null);
  }

  // ------------------------------------------------------------ Ein Satz

  function plantingView(p) {
    const crop = find.crop(p.crop_id);
    const bed = find.bed(p.bed_id);
    const ph = phases(p);
    const plants = plantsOf(p.id);
    const tabs = [["erfassen", "Erfassen"], ["uebersicht", "Übersicht"], ["pflanzen", `Pflanzen (${plants.length})`]];
    const top = h("div", { class: "bon-top" },
      h("button", { type: "button", class: "btn btn-quiet btn-sm bon-back", onclick: () => { openPlanting(null); render(); } },
        icon("left"), "Alle Sätze"),
      h("div", { class: "bon-title" },
        h("h2", {}, link(crop?.name ?? "Kultur", () => openPlantingOverview(p), { dot: crop?.color, title: "Übersicht des Satzes" }),
          varietyText(p) ? h("span", { class: "v" }, varietyText(p)) : null),
        h("span", { class: "muted small" }, [bed?.name || "ohne Beet",
          ph.plant != null ? `gepflanzt ${fmtDay(ph.plant, { year: true })}` : `gesät ${fmtDay(ph.sow, { year: true })}`,
          GROUP_LABEL[groupOf(p)] && groupOf(p) ? `Merkmale: ${GROUP_LABEL[groupOf(p)]}` : null].filter(Boolean).join(" · "))),
      h("div", { class: "seg bon-tabs", role: "tablist" }, tabs.map(([k, label]) =>
        segOpt("bon-tab", label, ui.tab === k, () => { ui.tab = k; writeSession("bonitur.tab", k); render(); }))));
    if (!plants.length && ui.tab !== "uebersicht") return [top, fixCard(p)];
    if (ui.tab === "uebersicht") return [top, overview(p)];
    if (ui.tab === "pflanzen") return [top, plantsTab(p)];
    return [top, ...capture(p)];
  }

  // ------------------------------------------------------------ Pflanzen festlegen

  function planSpots(p) {
    const crop = find.crop(p.crop_id);
    const bed = find.bed(p.bed_id);
    const plan = mixPlan(p, crop, bed);
    const mixed = isMixed(p);
    return plan.order
      .filter((o) => !mixed || o.v !== undefined)
      .map((o) => {
        const v = mixed ? p.varieties[o.v] : null;
        return { variety: v ? v.name : (p.variety || ""), variety_ref: v?.ref || null, row: o.row, place: o.place };
      });
  }

  function fixCard(p) {
    const spots = planSpots(p);
    const many = spots.length > 300;
    const count = h("input", { class: "input", inputmode: "numeric", value: many ? 30 : spots.length, style: { width: "90px" },
      "aria-label": "Anzahl Pflanzen" });
    const rows = new Set(spots.map((s) => s.row)).size;
    const preview = spots.slice(0, 300).map((s, i) => ({ id: -i - 1, num: i + 1, variety: s.variety, row: s.row, place: s.place, status: "ok", label: "" }));
    return h("section", { class: "bon-box" },
      h("h3", {}, "Pflanzen festlegen"),
      h("p", { class: "muted", style: { margin: 0, maxWidth: "70ch" } },
        `Damit jede Pflanze ihre Werte behält, bekommt sie einmal eine feste Nummer. Beetwerk übernimmt dafür den Pflanzplan: ${plural(spots.length, "Pflanze", "Pflanzen")} in ${plural(rows, "Reihe", "Reihen")}. `
        + "Danach ändert ein Umsortieren der Sorten nichts mehr an der Zuordnung. Etiketten trägst du anschließend unter „Pflanzen“ ein."),
      spots.length ? plantGrid(p, preview, { selectable: false }) : h("div", { class: "empty-note" }, "Im Pflanzplan ist noch keine Pflanze."),
      many ? h("p", { class: "small", style: { margin: 0, color: "var(--warn)" } },
        "Das sind sehr viele Pflanzen. Für die Bonitur reicht oft eine Auswahl: Beetwerk legt dann nur die ersten an.") : null,
      h("div", { class: "actions-row" },
        h("label", { class: "check" }, "Anzahl", count),
        h("button", { type: "button", class: "btn btn-primary", disabled: !spots.length, onclick: async (e) => {
          const n = Math.max(1, Math.min(spots.length, Math.round(Number(count.value) || spots.length)));
          e.target.disabled = true;
          try {
            await fixPlants(p.id, spots.slice(0, n));
            toast(`${plural(n, "Pflanze", "Pflanzen")} festgelegt`);
          } catch (err) {
            toast(err.message, { error: true });
            e.target.disabled = false;
          }
        } }, "Pflanzen festlegen")));
  }

  // ------------------------------------------------------------ Pflanzenraster

  function plantGrid(p, plants, { selectable = true, selected = new Set(), onToggle, badge, current = null } = {}) {
    const placed = plants.filter((pl) => pl.row && pl.place);
    const loose = plants.filter((pl) => !(pl.row && pl.place));
    const rows = Math.max(0, ...placed.map((pl) => pl.row));
    const cols = Math.max(1, ...placed.map((pl) => pl.place), Math.min(loose.length, 12));
    const grid = h("div", { class: "plant-grid", style: `--cols:${cols}` });
    const cell = (pl, r, c) => {
      const color = varietyColorOf(p, pl.variety);
      const b = h(selectable ? "button" : "div", {
        class: `plant-cell${pl.status === "gone" ? " gone" : ""}${pl.id === current ? " current" : ""}`,
        style: `grid-row:${r};grid-column:${c};--c:${color}`,
        title: `${plantName(pl)} · ${varietyLabel(p, pl.variety)} · ${plantPlace(pl)}${pl.status === "gone" ? " · ausgefallen" : ""}`,
      },
      h("span", { class: "n" }, pl.num),
      badge ? h("span", { class: "b" }, badge(pl) ?? "") : null);
      if (selectable) {
        b.type = "button";
        b.setAttribute("aria-pressed", selected.has(pl.id) ? "true" : "false");
        if (pl.status === "gone") b.disabled = true;
        b.addEventListener("click", () => onToggle?.(pl));
      }
      return b;
    };
    for (const pl of placed) grid.append(cell(pl, pl.row, pl.place));
    loose.forEach((pl, i) => grid.append(cell(pl, rows + 1 + Math.floor(i / cols), 1 + (i % cols))));
    return h("div", { class: "plant-grid-wrap" }, grid);
  }

  // ------------------------------------------------------------ Erfassen

  function capture(p) {
    const group = groupOf(p);
    const plants = plantsOf(p.id);
    const tgs = targetsOf(p);
    const hasVarietyTraits = traitsFor(group, "variety").length > 0;

    // 1. Was wird bonitiert
    const levelSeg = hasVarietyTraits ? h("div", { class: "seg", role: "radiogroup", "aria-label": "Ebene" },
      segOpt("bon-level", "Einzelne Pflanzen", ui.level === "plant", () => { ui.level = "plant"; ui.step = 0; render(); }),
      segOpt("bon-level", "Ganze Sorte", ui.level === "variety", () => { ui.level = "variety"; ui.step = 0; render(); })) : null;

    let selectBody;
    if (ui.level === "variety") {
      const names = varietiesOf(p);
      selectBody = h("div", { class: "chips" },
        names.length > 1 ? quickChip("Alle Sorten", names.every((v) => ui.selVar.has(v)), () => {
          ui.selVar = names.every((v) => ui.selVar.has(v)) ? new Set() : new Set(names);
          ui.step = 0;
          render();
        }) : null,
        names.map((v) => quickChip(varietyLabel(p, v), ui.selVar.has(v), () => {
          if (ui.selVar.has(v)) ui.selVar.delete(v); else ui.selVar.add(v);
          ui.step = 0;
          render();
        }, varietyColorOf(p, v))));
    } else {
      const active = plants.filter((pl) => pl.status !== "gone");
      const toggleSet = (list) => {
        const all = list.length && list.every((pl) => ui.sel.has(pl.id));
        for (const pl of list) { if (all) ui.sel.delete(pl.id); else ui.sel.add(pl.id); }
        ui.step = 0;
        render();
      };
      const names = varietiesOf(p).filter((v) => active.some((pl) => pl.variety === v));
      const rowNums = [...new Set(active.map((pl) => pl.row).filter(Boolean))].sort((a, b) => a - b);
      const allOn = active.length && active.every((pl) => ui.sel.has(pl.id));
      const bbchBadge = (pl) => {
        const v = bbchOf(pl, iso());
        return v == null ? "" : String(v).padStart(2, "0");
      };
      selectBody = h("div", { class: "bon-select-body" },
        h("div", { class: "chips" },
          quickChip(allOn ? "Keine" : "Alle", false, () => { ui.sel = allOn ? new Set() : new Set(active.map((pl) => pl.id)); ui.step = 0; render(); }),
          names.length > 1 ? names.map((v) => {
            const list = active.filter((pl) => pl.variety === v);
            return quickChip(varietyLabel(p, v), list.every((pl) => ui.sel.has(pl.id)), () => toggleSet(list), varietyColorOf(p, v));
          }) : null,
          rowNums.length > 1 ? rowNums.map((r) => {
            const list = active.filter((pl) => pl.row === r);
            return quickChip(`Reihe ${r}`, list.every((pl) => ui.sel.has(pl.id)), () => toggleSet(list));
          }) : null),
        plantGrid(p, plants, { selected: ui.sel, badge: bbchBadge, current: currentPlantId(p),
          onToggle: (pl) => { if (ui.sel.has(pl.id)) ui.sel.delete(pl.id); else ui.sel.add(pl.id); ui.step = 0; render(); } }));
    }
    const countText = ui.level === "variety"
      ? (tgs.length ? plural(tgs.length, "Sorte gewählt", "Sorten gewählt") : "Tippe die Sorten an")
      : (tgs.length ? plural(tgs.length, "Pflanze gewählt", "Pflanzen gewählt") : "Tippe Pflanzen an oder wähle einen Block");
    const single = ui.level === "plant" && tgs.length === 1 ? tgs[0].plant : null;
    const selectBox = h("section", { class: "bon-box bon-select" },
      h("div", { class: "bon-box-head" }, h("h3", {}, "1 · Was bonitierst du?"), levelSeg),
      selectBody,
      h("div", { class: "bon-box-foot" }, h("span", { class: "muted small" }, countText),
        single ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => openHistory(p, plantTarget(single)) }, "Verlauf dieser Pflanze") : null));

    // 2. Merkmale
    const applicable = traitsFor(group, ui.level);
    const applicableKeys = new Set(applicable.map((t) => t.key));
    ui.keys = ui.keys.filter((k) => applicableKeys.has(k));
    const due = dueKeys(p, tgs);
    const sets = bon.sets.map((s) => ({ ...s, use: orderKeys(s.keys.filter((k) => applicableKeys.has(k))) })).filter((s) => s.use.length);
    const sameKeys = (a) => a.length === ui.keys.length && a.every((k) => ui.keys.includes(k));
    const chooseKeys = (keys) => { ui.keys = sameKeys(keys) ? [] : orderKeys(keys); ui.step = 0; render(); };
    const traitBox = h("section", { class: "bon-box" },
      h("div", { class: "bon-box-head" }, h("h3", {}, "2 · Merkmale")),
      h("div", { class: "chips" },
        quickChip(ui.level === "variety" ? `Noch offen · ${due.length}` : `Jetzt fällig · ${due.length}`, due.length > 0 && sameKeys(due),
          () => chooseKeys(due), null, { disabled: !due.length,
            title: ui.level === "variety" ? "Einmalige Merkmale der Sorte, die noch fehlen"
              : "Einmalige Merkmale, deren Zeitpunkt nach dem BBCH-Stadium gekommen ist und die noch fehlen" }),
        sets.map((s) => quickChip(`${s.name} · ${s.use.length}`, sameKeys(s.use), () => chooseKeys(s.use))),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openPicker(p, tgs) }, icon("plus"), "Merkmale wählen")),
      ui.keys.length ? h("div", { class: "chips sel-traits" },
        ui.keys.map((k) => {
          const t = traitByKey(k);
          return h("span", { class: "trait-chip" }, t.name,
            h("button", { type: "button", "aria-label": `${t.name} entfernen`, onclick: () => { ui.keys = ui.keys.filter((x) => x !== k); render(); } }, icon("close")));
        }),
        ui.keys.length > 1 && !bon.sets.some((s) => sameKeys(orderKeys(s.keys))) ? h("button", { type: "button", class: "btn btn-sm btn-quiet",
          onclick: () => openSaveSet() }, "Als Vorlage speichern") : null) : null,
      due.length && !ui.keys.length ? h("p", { class: "muted small", style: { margin: 0 } },
        `Fällig: ${due.map((k) => traitByKey(k).name).join(", ")}`) : null);

    // 3. Werte
    const traits = formTraits(p);
    let formBox;
    if (!tgs.length || !traits.length) {
      formBox = h("section", { class: "bon-box bon-form" },
        h("h3", {}, "3 · Werte"),
        h("p", { class: "muted", style: { margin: 0 } }, !tgs.length
          ? (ui.level === "variety" ? "Wähle oben mindestens eine Sorte." : "Wähle oben mindestens eine Pflanze.")
          : "Wähle oben ein oder mehrere Merkmale, einzeln oder als Vorlage."));
    } else {
      formBox = valueForm(p, tgs, traits);
    }
    return [selectBox, traitBox, formBox];
  }

  function currentPlantId(p) {
    if (ui.mode !== "each" || ui.level !== "plant") return null;
    const tgs = targetsOf(p);
    return tgs.length > 1 ? tgs[Math.min(ui.step, tgs.length - 1)]?.plant?.id ?? null : null;
  }

  function valueForm(p, allTargets, traits) {
    const group = groupOf(p);
    const each = ui.mode === "each" && allTargets.length > 1;
    if (ui.step >= allTargets.length) ui.step = 0;
    const tgs = each ? [allTargets[ui.step]] : allTargets;
    const unitWord = ui.level === "variety" ? ["Sorte", "Sorten"] : ["Pflanze", "Pflanzen"];

    const modeSeg = allTargets.length > 1 ? h("div", { class: "seg", role: "radiogroup", "aria-label": "Eingabe" },
      segOpt("bon-mode", "Ein Wert für alle", !each, () => { ui.mode = "all"; ui.draft = {}; render(); }),
      segOpt("bon-mode", `${unitWord[0]} für ${unitWord[0]}`, each, () => { ui.mode = "each"; ui.step = 0; ui.draft = {}; ui.carry = {}; render(); })) : null;

    const tg = tgs[0];
    const headText = each
      ? h("div", { class: "step-head" },
        h("strong", {}, `${ui.step + 1} von ${allTargets.length}`),
        h("span", { class: "dot", style: { background: varietyColorOf(p, tg.variety) } }),
        h("span", {}, targetName(p, tg)),
        tg.plant ? h("span", { class: "muted small" }, plantPlace(tg.plant)) : null)
      : h("div", { class: "step-head" }, h("strong", {}, tgs.length === 1 ? targetName(p, tg) : `Für ${plural(tgs.length, unitWord[0], unitWord[1])}`),
        h("span", { class: "muted small" }, `am ${fmtDay(ui.date, { year: true })}`));

    const saveBtn = h("button", { type: "button", class: "btn btn-primary" });
    const refreshSave = () => {
      const n = countEntries(traits, tgs);
      saveBtn.textContent = each
        ? (ui.step + 1 < allTargets.length ? (n ? "Speichern und weiter" : "Weiter") : (n ? "Speichern und fertig" : "Fertig"))
        : (n ? `Speichern (${plural(n, "Wert", "Werte")})` : "Speichern");
      saveBtn.disabled = ui.saving || (!each && !n);
    };

    const rows = traits.map((t) => traitRow(p, t, tgs, group, refreshSave));
    const noteTrait = traitByKey("note");
    const showNote = noteTrait && appliesTo(noteTrait, group, ui.level) && !traits.includes(noteTrait);
    const note = showNote ? h("textarea", { class: "input", rows: 2, placeholder: "Notiz zu dieser Bonitur (optional)",
      oninput: (e) => { ui.note = e.target.value; refreshSave(); } }, ui.note) : null;

    saveBtn.addEventListener("click", () => save(p, traits, tgs, allTargets, each));
    refreshSave();
    const bar = h("div", { class: "bon-savebar" },
      each ? h("button", { type: "button", class: "btn", disabled: ui.step === 0, onclick: () => goStep(p, ui.step - 1, allTargets) }, icon("left"), "Zurück") : null,
      each ? h("button", { type: "button", class: "btn btn-quiet", onclick: () => goStep(p, ui.step + 1, allTargets) }, "Überspringen") : null,
      !each && Object.keys(ui.draft).length ? h("button", { type: "button", class: "btn btn-quiet", onclick: () => { ui.draft = {}; ui.note = ""; render(); } }, "Leeren") : null,
      h("span", { class: "spacer" }),
      saveBtn);
    return h("section", { class: "bon-box bon-form" },
      h("div", { class: "bon-box-head" }, h("h3", {}, "3 · Werte"), modeSeg),
      headText,
      h("div", { class: "trait-rows" }, rows),
      note ? h("label", { class: "field" }, h("span", {}, "Notiz"), note) : null,
      bar);
  }

  function countEntries(traits, tgs) {
    let n = 0;
    for (const t of traits) {
      const d = ui.draft[t.key];
      if (d?.touched && d.value !== undefined) n += tgs.length;
    }
    if (ui.note.trim()) n += tgs.length;
    return n;
  }

  function traitRow(p, t, tgs, group, refreshSave) {
    const pre = prefill(t, tgs);
    const d = ui.draft[t.key];
    const value = d ? d.value : pre.value;
    const w = widget(t, {
      value, parts: d ? d.parts : pre.parts, group, donors: donorNames(),
      onChange: (v, extra) => {
        ui.draft[t.key] = { value: v, parts: extra?.parts ?? [], touched: true };
        status.textContent = statusText();
        refreshSave();
      },
    });
    const statusText = () => {
      const dd = ui.draft[t.key];
      if (dd?.carried && sameValue(dd.value, w.get())) return "wie bei der vorigen";
      if (!dd && pre.same) return "schon gespeichert";
      if (dd?.touched && dd.value !== undefined && pre.same && sameValue(dd.value, pre.value)) return "unverändert";
      return "";
    };
    const status = h("span", { class: "trait-status" }, statusText());
    return h("div", { class: "trait-row" },
      h("div", { class: "trait-head" },
        h("span", { class: "trait-name" }, t.name),
        status,
        h("span", { class: "trait-hint" }, hintFor(p, t, tgs, pre))),
      w.el);
  }

  function prefill(t, tgs) {
    const ex = tgs.map((tg) => existingFor(t, tg));
    const have = ex.filter(Boolean).length;
    if (!have || have < ex.length) return { value: undefined, have };
    const first = ex[0];
    if (ex.every((x) => sameValue(x.value, first.value))) return { value: first.value, parts: first.parts, have, same: true };
    return { value: undefined, have };
  }

  function hintFor(p, t, tgs, pre) {
    const bits = [];
    if (t.stage && t.freq !== "repeat") bits.push(t.stage);
    if (t.hint) bits.push(t.hint);
    if (tgs.length === 1) {
      const tg = tgs[0];
      if (t.freq === "once") {
        const o = values(t.id, tg.key)[0];
        if (o) bits.push(`erfasst am ${fmtDay(dayNum(o.date))}: ${fmtValue(t, o)}`);
      } else {
        const list = values(t.id, tg.key).filter((o) => o.date < iso());
        const o = list[list.length - 1];
        if (o) bits.push(`zuletzt ${fmtValue(t, o)} am ${fmtDay(dayNum(o.date))}`);
      }
    } else if (t.freq === "once") {
      const n = tgs.filter((tg) => isDone(t, tg)).length;
      if (n) bits.push(`bei ${n} von ${tgs.length} schon erfasst`);
    } else if (t.freq === "repeat" && pre.have) {
      bits.push(`heute bei ${pre.have} von ${tgs.length} schon erfasst`);
    }
    if (t.type === "rated") {
      const today = new Map();
      for (const tg of tgs) for (const o of onDate(t.id, tg.key, iso())) {
        const k = fmtValue(t, o);
        today.set(k, (today.get(k) || 0) + 1);
      }
      if (today.size) bits.push(`heute schon: ${[...today].map(([k, n]) => (tgs.length > 1 ? `${k} (${n}×)` : k)).join(", ")}`);
    }
    return bits.join(" · ");
  }

  function goStep(p, i, allTargets) {
    if (i < 0 || i >= allTargets.length) {
      if (i >= allTargets.length) {
        toast("Alle gewählten durch");
        ui.step = 0;
        ui.draft = {};
        ui.carry = {};
        render();
      }
      return;
    }
    ui.step = i;
    // Werte der vorigen Pflanze vorbelegen, wo diese noch nichts hat
    ui.draft = {};
    const tg = allTargets[i];
    for (const t of formTraits(p)) {
      const c = ui.carry[t.key];
      if (c && c.value !== undefined && !existingFor(t, tg) && t.type !== "photo") {
        ui.draft[t.key] = { value: c.value, parts: c.parts, touched: true, carried: true };
      }
    }
    render();
    page.querySelector(".bon-form")?.scrollIntoView({ block: "start" });
  }

  async function save(p, traits, tgs, allTargets, each) {
    const entries = [];
    const date = iso();
    let photoName = null;
    try {
      ui.saving = true;
      for (const t of traits) {
        const d = ui.draft[t.key];
        if (!d?.touched || d.value === undefined) continue;
        let value = d.value;
        let photo = "";
        if (t.type === "photo") {
          if (!photoName) photoName = await uploadPhoto(d.value.blob);
          photo = photoName;
          value = null;
        }
        for (const tg of tgs) {
          entries.push({ trait_id: t.id, planting_id: p.id, plant_id: tg.plant?.id ?? null, variety: tg.variety,
            date, value, parts: t.type === "number" ? d.parts || [] : null, photo });
        }
      }
      const noteTrait = traitByKey("note");
      if (ui.note.trim() && noteTrait && !traits.includes(noteTrait)) {
        for (const tg of tgs) {
          entries.push({ trait_id: noteTrait.id, planting_id: p.id, plant_id: tg.plant?.id ?? null, variety: tg.variety,
            date, value: ui.note.trim() });
        }
      }
      if (!entries.length) {
        ui.saving = false;
        if (each) goStep(p, ui.step + 1, allTargets);
        return;
      }
      const saved = await saveEntries(entries);
      ui.saving = false;
      const carry = {};
      for (const t of traits) {
        const d = ui.draft[t.key];
        if (d?.value !== undefined) carry[t.key] = { value: d.value, parts: d.parts };
      }
      ui.note = "";
      toast(`${plural(saved.length, "Wert", "Werte")} gespeichert`, { action: "Rückgängig", onAction: async () => {
        try { await undoSaved(saved); toast("Rückgängig gemacht"); } catch (e) { toast(e.message, { error: true }); }
      } });
      if (each) {
        ui.carry = carry;
        goStep(p, ui.step + 1, allTargets);
      } else {
        ui.draft = {};
        render();
      }
    } catch (e) {
      ui.saving = false;
      toast(e.message, { error: true });
      render();
    }
  }

  // ------------------------------------------------------------ Übersicht

  function overview(p) {
    const plants = plantsOf(p.id);
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Ansicht" },
      segOpt("bon-ov", "Je Pflanze", ui.overview === "plant", () => { ui.overview = "plant"; render(); }),
      segOpt("bon-ov", "Sorten vergleichen", ui.overview === "variety", () => { ui.overview = "variety"; render(); }));
    const body = ui.overview === "variety" ? varietyCompare(p) : plantTable(p, plants);
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Übersicht"), seg),
      body);
  }

  function sumOf(key, tkey) {
    const t = traitByKey(key);
    if (!t) return 0;
    return values(t.id, tkey).reduce((s, o) => s + (Number(o.value) || 0), 0);
  }

  function plantTable(p, plants) {
    if (!plants.length) return h("div", { class: "empty-note" }, "Die Pflanzen sind noch nicht festgelegt.");
    const group = groupOf(p);
    const once = traitsFor(group, "plant").filter((t) => t.freq === "once");
    const height = traitByKey("height");
    const rows = plants.map((pl) => {
      const tg = plantTarget(pl);
      const b = latest(traitByKey("bbch")?.id, tg.key, iso());
      const hgt = height ? latest(height.id, tg.key, iso()) : null;
      const bloom = firstReached(pl, 61), ripe = firstReached(pl, 81);
      const cnt = sumOf("harvest_count", tg.key), wgt = sumOf("harvest_weight", tg.key);
      const done = once.filter((t) => isDone(t, tg)).length;
      return h("tr", { tabindex: "0", class: pl.status === "gone" ? "gone" : null,
        onclick: () => openHistory(p, tg), onkeydown: (e) => { if (e.key === "Enter") openHistory(p, tg); } },
        h("td", { class: "nowrap" }, h("strong", {}, pl.num), pl.label ? h("span", { class: "muted small" }, ` ${pl.label}`) : null),
        h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: varietyColorOf(p, pl.variety) } }), varietyLabel(p, pl.variety))),
        h("td", { class: "r nowrap" }, b ? String(b.value).padStart(2, "0") : "–", b ? h("span", { class: "muted small" }, ` ${fmtDay(dayNum(b.date))}`) : null),
        h("td", { class: "r" }, hgt ? `${fmtNum(hgt.value)} cm` : "–"),
        h("td", { class: "r" }, bloom ? fmtDay(dayNum(bloom)) : "–"),
        h("td", { class: "r" }, ripe ? fmtDay(dayNum(ripe)) : "–"),
        h("td", { class: "r nowrap" }, cnt || wgt ? `${cnt ? `${fmtNum(cnt)} St.` : ""}${cnt && wgt ? " · " : ""}${wgt ? `${fmtNum(wgt / 1000, 2)} kg` : ""}` : "–"),
        h("td", { class: "r" }, `${done}/${once.length}`),
        h("td", { class: "r" }, obsOfPlant(pl.id).length || "–"));
    });
    return h("div", { class: "table-wrap" }, h("table", { class: "data bon-table" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Nr"), h("th", {}, "Sorte"), h("th", { class: "r" }, "BBCH"), h("th", { class: "r" }, "Höhe"),
        h("th", { class: "r" }, "Blüte ab"), h("th", { class: "r" }, "Reife ab"), h("th", { class: "r" }, "Ernte"),
        h("th", { class: "r", title: "Einmalige Merkmale erfasst" }, "Einmalig"), h("th", { class: "r" }, "Werte"))),
      h("tbody", {}, rows)));
  }

  function varietyCompare(p) {
    const group = groupOf(p);
    const names = varietiesOf(p);
    const plantsBy = new Map(names.map((v) => [v, plantsOf(p.id).filter((pl) => pl.variety === v && pl.status !== "gone")]));
    const start = phases(p).fieldStart;
    const head = h("tr", {}, h("th", {}, "Merkmal"), names.map((v) => h("th", { class: "r" },
      h("button", { type: "button", class: "link-btn", onclick: () => openHistory(p, varietyTarget(p.id, v)) },
        h("span", { class: "dot", style: { background: varietyColorOf(p, v) } }), varietyLabel(p, v)))));
    const rows = [];
    const derived = (label, fn) => rows.push(h("tr", {}, h("th", { scope: "row" }, label), names.map((v) => h("td", { class: "r" }, fn(plantsBy.get(v), v) ?? "–"))));
    const days = (isoD) => (isoD ? dayNum(isoD) - start : null);
    const firstOf = (list, code) => list.map((pl) => firstReached(pl, code)).filter(Boolean).sort()[0];
    rows.push(groupRow("Aus den regelmäßigen Werten", names.length));
    derived("Pflanzen", (list) => list.length);
    derived("BBCH (Median)", (list) => { const m = median(list.map((pl) => bbchOf(pl, iso()))); return m == null ? null : String(m).padStart(2, "0"); });
    const since = phases(p).plant != null ? "Pflanzung" : "Aussaat";
    derived(`Blühbeginn (Tage ab ${since})`, (list) => { const d = firstOf(list, 61); return d ? `${fmtDay(dayNum(d))} · ${days(d)}` : null; });
    derived(`Reifebeginn (Tage ab ${since})`, (list) => { const d = firstOf(list, 81); return d ? `${fmtDay(dayNum(d))} · ${days(d)}` : null; });
    derived("Höhe, zuletzt (Mittel)", (list) => {
      const hs = list.map((pl) => latest(traitByKey("height")?.id, `p${pl.id}`, iso())?.value).filter((x) => x != null);
      return hs.length ? `${fmtNum(hs.reduce((a, b) => a + b, 0) / hs.length, 0)} cm` : null;
    });
    derived("Ernte je Pflanze", (list) => {
      if (!list.length) return null;
      const w = list.reduce((s, pl) => s + sumOf("harvest_weight", `p${pl.id}`), 0);
      const c = list.reduce((s, pl) => s + sumOf("harvest_count", `p${pl.id}`), 0);
      if (!w && !c) return null;
      return [c ? `${fmtNum(c / list.length)} St.` : null, w ? `${fmtNum(w / list.length / 1000, 2)} kg` : null].filter(Boolean).join(" · ");
    });
    derived("Mittleres Fruchtgewicht", (list) => {
      const w = list.reduce((s, pl) => s + sumOf("harvest_weight", `p${pl.id}`), 0);
      const c = list.reduce((s, pl) => s + sumOf("harvest_count", `p${pl.id}`), 0);
      return w && c ? `${fmtNum(w / c, 0)} g` : null;
    });
    derived("Aussortiert", (list) => {
      const bad = list.reduce((s, pl) => s + sumOf("culls", `p${pl.id}`), 0);
      const good = list.reduce((s, pl) => s + sumOf("harvest_count", `p${pl.id}`), 0);
      return bad ? `${fmtNum((bad / (bad + good)) * 100, 0)} %` : null;
    });

    let lastSection = null;
    for (const t of traitsFor(group, "both").filter((x) => x.freq === "once")) {
      const cells = names.map((v) => {
        const own = values(t.id, `v${p.id}|${v}`);
        const fromPlants = plantsBy.get(v).flatMap((pl) => values(t.id, `p${pl.id}`));
        return { own, fromPlants };
      });
      if (!cells.some((c) => c.own.length || c.fromPlants.length)) continue;
      if (t.section !== lastSection) {
        lastSection = t.section;
        rows.push(groupRow(SECTION_LABEL[t.section] || "", names.length));
      }
      rows.push(h("tr", {}, h("th", { scope: "row" }, t.name, t.unit ? h("span", { class: "muted small" }, ` (${t.unit})`) : null),
        cells.map((c) => h("td", { class: "r" }, aggregate(t, c)))));
    }
    if (rows.length <= 9 && !obsOfPlanting(p.id).length) {
      return h("div", { class: "empty-note" }, "Noch keine Werte. Sobald du bonitierst, stehen die Sorten hier nebeneinander.");
    }
    return h("div", { class: "table-wrap" }, h("table", { class: "data bon-table compare" }, h("thead", {}, head), h("tbody", {}, rows)));
  }

  function groupRow(label, n) {
    return h("tr", { class: "group-row" }, h("td", { colspan: n + 1 }, label));
  }

  function aggregate(t, { own, fromPlants }) {
    const parts = [];
    if (own.length) parts.push(h("strong", {}, fmtValue(t, own[0])));
    if (fromPlants.length) {
      if (["number", "score", "bbch"].includes(t.type)) {
        const nums = fromPlants.map((o) => Number(o.value)).filter(Number.isFinite);
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        parts.push(h("span", {}, `${fmtNum(mean, t.type === "number" ? 1 : 1)}${nums.length > 1 ? ` (n=${nums.length})` : ""}`));
      } else if (t.type === "choice" || t.type === "multi") {
        const counts = new Map();
        for (const o of fromPlants) for (const v of [].concat(o.value)) counts.set(v, (counts.get(v) || 0) + 1);
        const text = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => (counts.size > 1 || c > 1 ? `${v} ${c}×` : v)).join(", ");
        parts.push(h("span", {}, text));
      } else {
        parts.push(h("span", { class: "muted" }, plural(fromPlants.length, "Wert", "Werte")));
      }
    }
    return parts.length ? h("span", { class: "agg" }, ...parts.flatMap((x, i) => (i ? [h("br"), x] : [x]))) : "–";
  }

  // ------------------------------------------------------------ Pflanzen verwalten

  function plantsTab(p) {
    const plants = plantsOf(p.id);
    const names = varietiesOf(p);
    const anyObs = plants.some((pl) => obsOfPlant(pl.id).length);
    const anyLabel = plants.some((pl) => pl.label);
    const rows = plants.map((pl) => {
      const n = obsOfPlant(pl.id).length;
      const label = h("input", { class: "input label-input", value: pl.label, placeholder: "Etikett", "aria-label": `Etikett von Pflanze ${pl.num}`,
        autocapitalize: "characters",
        onchange: async (e) => {
          try { await patchPlant(pl.id, { label: e.target.value }); } catch (err) { toast(err.message, { error: true }); e.target.value = pl.label; }
        } });
      const variety = names.length > 1 || isMixed(p)
        ? h("select", { class: "input", "aria-label": `Sorte von Pflanze ${pl.num}`, onchange: (e) => patchPlant(pl.id, { variety: e.target.value }).catch((err) => toast(err.message, { error: true })) },
          names.map((v) => h("option", { value: v, selected: v === pl.variety }, varietyLabel(p, v))))
        : h("span", {}, varietyLabel(p, pl.variety));
      return h("tr", { class: pl.status === "gone" ? "gone" : null },
        h("td", {}, h("strong", {}, pl.num)),
        h("td", {}, label),
        h("td", {}, variety),
        h("td", { class: "r nowrap" }, pl.row ? `${pl.row} / ${pl.place}` : "–"),
        h("td", {}, h("label", { class: "check" }, h("input", { type: "checkbox", checked: pl.status === "gone",
          onchange: (e) => patchPlant(pl.id, { status: e.target.checked ? "gone" : "ok" }).catch((err) => toast(err.message, { error: true })) }), "ausgefallen")),
        h("td", { class: "r" }, n ? h("button", { type: "button", class: "link-btn", onclick: () => openHistory(p, plantTarget(pl)) }, plural(n, "Wert", "Werte")) : "–"),
        h("td", { class: "r" }, n ? h("span", { class: "icon-spacer" }) : iconBtn("trash", `Pflanze ${pl.num} entfernen`, async () => {
          try { await deletePlant(pl.id); toast(`Pflanze ${pl.num} entfernt`); } catch (err) { toast(err.message, { error: true }); }
        })));
    });
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Pflanzen und Etiketten"),
        h("div", { class: "actions-row" },
          h("button", { type: "button", class: "btn btn-sm", onclick: () => openLabels(p) }, "Etiketten einfügen"),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => openAddPlant(p) }, icon("plus"), "Pflanze"),
          !anyObs && !anyLabel ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: async () => {
            if (!(await confirmDialog("Die Pflanzen werden neu aus dem aktuellen Pflanzplan übernommen.", { ok: "Neu übernehmen", danger: false, title: "Pflanzen neu festlegen?" }))) return;
            try { await fixPlants(p.id, planSpots(p), true); toast("Pflanzen neu festgelegt"); } catch (err) { toast(err.message, { error: true }); }
          } }, "Neu aus Pflanzplan") : null)),
      h("p", { class: "muted small", style: { margin: 0, maxWidth: "75ch" } },
        "Das Etikett ist die ID auf deinem Pflanzenschild. Es ist eindeutig über alle Sätze und später der Inhalt des QR-Codes; über „Etikett suchen“ oben springst du direkt zur Pflanze. Pflanzen mit Werten lassen sich nicht entfernen, nur als ausgefallen markieren."),
      h("div", { class: "table-wrap" }, h("table", { class: "data bon-table plants" },
        h("thead", {}, h("tr", {}, h("th", {}, "Nr"), h("th", {}, "Etikett"), h("th", {}, "Sorte"), h("th", { class: "r" }, "Reihe / Platz"),
          h("th", {}, "Status"), h("th", { class: "r" }, "Werte"), h("th", {}, ""))),
        h("tbody", {}, rows))));
  }

  // ------------------------------------------------------------ Dialoge

  function openHistory(p, tg) {
    const isPlant = !!tg.plant;
    const pl = tg.plant;
    const label = isPlant ? h("input", { value: pl.label, maxlength: 80, autocapitalize: "characters" }) : null;
    const note = isPlant ? h("textarea", { rows: 2 }, pl.note || "") : null;
    const gone = isPlant ? h("input", { type: "checkbox", checked: pl.status === "gone" }) : null;
    const dlg = shell(isPlant ? plantName(pl) : `Sorte ${varietyLabel(p, tg.variety)}`, {
      onSubmit: async () => {
        if (isPlant) await patchPlant(pl.id, { label: label.value, note: note.value, status: gone.checked ? "gone" : "ok" });
      },
    });
    const list = h("div", { class: "history" });
    const paint = () => {
      const obs = (isPlant ? obsOfPlant(pl.id) : obsOfPlanting(p.id).filter((o) => o.plant_id == null && o.variety === tg.variety))
        .slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      if (!obs.length) {
        list.replaceChildren(h("p", { class: "muted", style: { margin: 0 } }, "Noch keine Werte."));
        return;
      }
      let lastDate = null;
      const out = [];
      for (const o of obs) {
        if (o.date !== lastDate) {
          lastDate = o.date;
          out.push(h("div", { class: "history-date" }, fmtDay(dayNum(o.date), { year: true })));
        }
        const t = traitById(o.trait_id);
        out.push(h("div", { class: "history-row" },
          h("span", { class: "t" }, t?.name ?? "Merkmal"),
          h("span", { class: "v" }, fmtValue(t, o),
            t?.type === "bbch" ? h("span", { class: "muted small" }, ` ${bbchText(o.value, groupOf(p))}`) : null,
            o.parts?.length ? h("span", { class: "muted small" }, ` aus ${o.parts.length} Einzelwerten`) : null,
            o.note ? h("span", { class: "note" }, o.note) : null,
            o.photo ? h("a", { href: `/api/photos/${o.photo}`, target: "_blank", rel: "noopener", class: "thumb" },
              h("img", { src: `/api/photos/${o.photo}?thumb=1`, alt: "Foto", loading: "lazy" })) : null),
          h("span", { class: "a" },
            iconBtn("edit", "Ändern", () => openObsEditor(p, o, paint)),
            iconBtn("trash", "Löschen", async () => {
              const copy = { ...o };
              try {
                await deleteObs(o.id);
                paint();
                toast(`${t?.name ?? "Wert"} gelöscht`, { action: "Rückgängig", onAction: async () => {
                  try {
                    await saveEntries([{ trait_id: copy.trait_id, planting_id: copy.planting_id, plant_id: copy.plant_id, variety: copy.variety,
                      date: copy.date, value: copy.value, parts: copy.parts, note: copy.note, photo: copy.photo }]);
                    paint();
                  } catch (e) { toast(e.message, { error: true }); }
                } });
              } catch (e) { toast(e.message, { error: true }); }
            }))));
      }
      list.replaceChildren(...out);
    };
    paint();
    if (isPlant) {
      dlg.body.append(
        h("p", { class: "muted", style: { margin: 0 } }, `${varietyLabel(p, pl.variety)} · ${plantPlace(pl)}`),
        h("div", { class: "grid-2" }, field("Etikett", label, "ID vom Pflanzenschild"),
          h("div", { class: "field" }, h("span", {}, "Status"), h("label", { class: "check", style: { minHeight: "36px" } }, gone, "ausgefallen"))),
        field("Notiz zur Pflanze", note));
      dlg.foot.append(h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-quiet", autofocus: true, onclick: () => dlg.dlg.close() }, "Schließen"),
        h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
    } else {
      dlg.foot.append(h("span", { class: "spacer" }), h("button", { type: "submit", class: "btn", autofocus: true }, "Schließen"));
    }
    dlg.body.append(h("h3", { style: { margin: "4px 0 -6px" } }, "Verlauf"), list);
    dlg.open();
  }

  function openObsEditor(p, o, after) {
    const t = traitById(o.trait_id);
    let value = o.value, parts = o.parts, touched = false;
    const w = t.type === "photo" ? null : widget(t, { value, parts, group: groupOf(p), donors: donorNames(),
      onChange: (v, extra) => { value = v; parts = extra?.parts ?? []; touched = true; } });
    const date = h("input", { type: "date", value: o.date });
    const note = h("textarea", { rows: 2 }, o.note || "");
    const dlg = shell(t.name, { onSubmit: async () => {
      const changes = { date: date.value, note: note.value };
      if (w && touched) {
        if (value === undefined) throw new Error("Bitte einen Wert wählen oder den Eintrag löschen");
        changes.value = value;
        if (t.type === "number") changes.parts = parts;
      }
      await patchObs(o.id, changes);
      after?.();
    } });
    dlg.body.append(w ? w.el : h("img", { src: `/api/photos/${o.photo}?thumb=1`, alt: "Foto", style: { maxWidth: "240px", borderRadius: "6px" } }),
      h("div", { class: "grid-2" }, field("Datum", date), h("span")), field("Notiz", note));
    dlg.foot.append(h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
    dlg.open();
  }

  function openPicker(p, tgs) {
    const group = groupOf(p);
    const chosen = new Set(ui.keys);
    const due = new Set(dueKeys(p, tgs));
    const q = h("input", { type: "search", class: "input", placeholder: "Merkmal suchen", "aria-label": "Merkmal suchen" });
    const list = h("div", { class: "picker" });
    const paint = () => {
      const s = q.value.trim().toLowerCase();
      const out = [];
      let last = null;
      for (const t of traitsFor(group, ui.level)) {
        if (s && !t.name.toLowerCase().includes(s)) continue;
        if (t.section !== last) {
          last = t.section;
          out.push(h("div", { class: "picker-section" }, SECTION_LABEL[t.section] || "Weitere"));
        }
        const done = t.freq === "once" && tgs.length ? tgs.filter((tg) => isDone(t, tg)).length : null;
        const box = h("input", { type: "checkbox", checked: chosen.has(t.key),
          onchange: (e) => { if (e.target.checked) chosen.add(t.key); else chosen.delete(t.key); } });
        out.push(h("label", { class: "picker-row" }, box,
          h("span", { class: "n" }, t.name, due.has(t.key) ? h("span", { class: "due" }, "fällig") : null),
          h("span", { class: "m" }, [FREQ_LABEL[t.freq], t.stage, done != null ? `${done}/${tgs.length} erfasst` : null].filter(Boolean).join(" · "))));
      }
      list.replaceChildren(...(out.length ? out : [h("p", { class: "muted" }, "Kein Merkmal passt.")]));
    };
    q.addEventListener("input", paint);
    paint();
    const dlg = shell("Merkmale wählen", { onSubmit: () => {
      ui.keys = orderKeys([...chosen]);
      ui.step = 0;
      render();
    } });
    dlg.body.append(q, list);
    dlg.foot.append(h("button", { type: "button", class: "btn btn-quiet", onclick: () => { chosen.clear(); paint(); } }, "Keine"),
      h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Übernehmen"));
    dlg.open();
  }

  function openSaveSet() {
    const name = h("input", { required: true, maxlength: 60, placeholder: "z. B. Morgenrunde" });
    const dlg = shell("Als Vorlage speichern", { onSubmit: async () => {
      if (!name.value.trim()) throw new Error("Bitte einen Namen eingeben");
      await saveSet(null, { name: name.value.trim(), keys: ui.keys });
      toast("Vorlage gespeichert");
    } });
    dlg.body.append(field("Name", name), h("p", { class: "muted small", style: { margin: 0 } },
      ui.keys.map((k) => traitByKey(k)?.name).join(", ")));
    dlg.foot.append(h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
    dlg.open();
    name.focus();
  }

  function openLabels(p) {
    const plants = plantsOf(p.id);
    const ta = h("textarea", { rows: 10, placeholder: "T26-001\nT26-002\n…", style: { fontFamily: "ui-monospace, monospace" } },
      plants.map((pl) => pl.label).join("\n").replace(/\n+$/, ""));
    const info = h("p", { class: "muted small", style: { margin: 0 } });
    const paint = () => {
      const lines = ta.value.split(/\r?\n/);
      info.textContent = `${lines.filter((l) => l.trim()).length} Etiketten für ${plural(plants.length, "Pflanze", "Pflanzen")}`
        + (lines.length > plants.length ? `; ${lines.length - plants.length} Zeilen zu viel werden ignoriert` : "");
    };
    ta.addEventListener("input", paint);
    paint();
    const dlg = shell("Etiketten einfügen", { onSubmit: async () => {
      const lines = ta.value.split(/\r?\n/);
      const labels = {};
      plants.forEach((pl, i) => { labels[pl.id] = (lines[i] || "").trim(); });
      await setLabels(p.id, labels);
      toast("Etiketten gespeichert");
    } });
    dlg.body.append(h("p", { style: { margin: 0 } }, "Ein Etikett je Zeile, in der Reihenfolge der Pflanzennummern (1, 2, 3 …). Eine leere Zeile lässt die Pflanze ohne Etikett. Du kannst die Spalte direkt aus Baserow oder einer Tabelle kopieren."),
      ta, info);
    dlg.foot.append(h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Übernehmen"));
    dlg.open();
  }

  function openAddPlant(p) {
    const names = varietiesOf(p);
    const variety = h("select", {}, names.map((v) => h("option", { value: v }, varietyLabel(p, v))));
    const label = h("input", { maxlength: 80, autocapitalize: "characters" });
    const row = h("input", { inputmode: "numeric" });
    const place = h("input", { inputmode: "numeric" });
    const dlg = shell("Pflanze hinzufügen", { onSubmit: async () => {
      const int = (el) => (el.value.trim() ? Math.max(1, Math.round(Number(el.value))) || null : null);
      const v = variety.value;
      const ref = isMixed(p) ? p.varieties.find((x) => x.name === v)?.ref : null;
      const pl = await addPlant({ planting_id: p.id, variety: v, variety_ref: ref || null, label: label.value, row: int(row), place: int(place) });
      toast(`Pflanze ${pl.num} hinzugefügt`);
    } });
    dlg.body.append(h("div", { class: "grid-2" }, field("Sorte", variety), field("Etikett", label)),
      h("div", { class: "grid-2" }, field("Reihe", row), field("Platz", place, "leer lassen, wenn sie nicht im Raster steht")));
    dlg.foot.append(h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Hinzufügen"));
    dlg.open();
  }

  render();
  return {
    update(reason) { if (reason === "data") render(); },
    destroy() {
      off();
      clearInterval(bsrPoll);
      Object.values(bsrTimers).forEach(clearTimeout);
      document.removeEventListener("visibilitychange", onVisible);
      document.body.classList.remove("bon-bar-on");
    },
  };
}

// ---------------------------------------------------------------- Bausteine

let segSeq = 0;
function segOpt(name, label, checked, onPick) {
  const input = h("input", { type: "radio", name: `${name}-${segSeq}`, checked });
  input.addEventListener("change", onPick);
  return h("label", {}, input, label);
}

function quickChip(label, pressed, onclick, color, extra = {}) {
  return h("button", { type: "button", class: "chip quick", "aria-pressed": pressed ? "true" : "false", onclick, ...extra },
    color ? h("span", { class: "dot", style: { background: color } }) : null, label);
}

// ---------------------------------------------------------------- Merkmalkatalog

const GROUP_FILTER = [["all", "Alle Kulturen"], ["tomato", "Tomate"], ["pepper", "Paprika & Chili"]];
let catalogGroup = "all";

export function openCatalog() {
  const dlg = shell("Merkmale");
  const list = h("div", { class: "catalog" });
  const segWrap = h("div");
  const paint = () => {
    segSeq++;
    segWrap.replaceChildren(h("div", { class: "seg", role: "radiogroup", "aria-label": "Kultur" },
      GROUP_FILTER.map(([k, label]) => segOpt("cat", label, catalogGroup === k, () => { catalogGroup = k; paint(); }))));
    const traits = bySection(bon.traits.filter((t) => t.grp === catalogGroup));
    const out = [];
    let last = null;
    for (const t of traits) {
      if (t.section !== last) {
        last = t.section;
        out.push(h("div", { class: "picker-section" }, SECTION_LABEL[t.section] || "Weitere"));
      }
      out.push(h("div", { class: `catalog-row${t.active ? "" : " off"}` },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: t.active, "aria-label": `${t.name} aktiv`,
          onchange: async (e) => {
            try { await saveTrait(t.id, { active: e.target.checked }); paint(); } catch (err) { toast(err.message, { error: true }); e.target.checked = t.active; }
          } }), h("span", { class: "n" }, t.name)),
        h("span", { class: "m" }, [TYPE_LABEL[t.type], FREQ_LABEL[t.freq], LEVEL_LABEL[t.level], t.stage, t.ref].filter(Boolean).join(" · ")),
        t.builtin ? null : iconBtn("edit", "Bearbeiten", () => openTraitEditor(t, paint))));
    }
    if (!out.length) out.push(h("p", { class: "muted" }, "Hier gibt es noch keine Merkmale."));
    const sets = h("div", { class: "catalog-sets" },
      h("div", { class: "picker-section" }, "Vorlagen"),
      bon.sets.length ? bon.sets.map((s) => h("div", { class: "catalog-row" },
        h("span", { class: "n" }, s.name),
        h("span", { class: "m" }, s.keys.map((k) => traitByKey(k)?.name).filter(Boolean).join(", ")),
        iconBtn("trash", `Vorlage ${s.name} löschen`, async () => {
          if (!(await confirmDialog(`Die Vorlage „${s.name}“ wird gelöscht. Die Merkmale bleiben.`, { title: "Vorlage löschen?" }))) return;
          try { await deleteSet(s.id); paint(); } catch (err) { toast(err.message, { error: true }); }
        }))) : h("p", { class: "muted small" }, "Keine Vorlagen. Wähle beim Erfassen mehrere Merkmale und speichere sie als Vorlage."));
    list.replaceChildren(...out, sets);
  };
  paint();
  dlg.body.append(h("p", { class: "muted small", style: { margin: 0 } },
    "Ausgeschaltete Merkmale erscheinen beim Erfassen nicht mehr; vorhandene Werte bleiben. Die eingebauten Merkmale folgen den UPOV-Prüfrichtlinien für Tomate (TG/44) und Paprika (TG/76)."),
  segWrap, list);
  dlg.foot.append(h("button", { type: "button", class: "btn", onclick: () => openTraitEditor(null, paint) }, icon("plus"), "Eigenes Merkmal"),
    h("span", { class: "spacer" }), h("button", { type: "button", class: "btn btn-primary", onclick: () => dlg.dlg.close() }, "Fertig"));
  dlg.open();
}

function openTraitEditor(t, after) {
  const isNew = !t;
  const v = { name: "", grp: catalogGroup, section: "plant", freq: "once", level: "both", type: "choice", options: [], unit: "",
    min: null, max: null, samples: 0, bbch_from: null, bbch_to: null, stage: "", hint: "", ...t };
  const sel = (name, opts, cur) => h("select", { name }, opts.map(([k, label]) => h("option", { value: k, selected: k === cur }, label)));
  const name = h("input", { value: v.name, maxlength: 80, required: true });
  const grp = sel("grp", GROUP_FILTER, v.grp);
  const section = sel("section", Object.entries(SECTION_LABEL), v.section);
  const freq = sel("freq", Object.entries(FREQ_LABEL), v.freq);
  const level = sel("level", Object.entries(LEVEL_LABEL), v.level);
  const type = sel("type", Object.entries(TYPE_LABEL).filter(([k]) => k !== "bbch"), v.type);
  const options = h("textarea", { rows: 4, placeholder: "ein Wert je Zeile" }, Array.isArray(v.options) ? v.options.join("\n") : "");
  const labels = h("textarea", { rows: 3, placeholder: "1 = gering\n9 = stark" },
    v.options && !Array.isArray(v.options) ? Object.entries(v.options).map(([k, l]) => `${k} = ${l}`).join("\n") : "");
  const unit = h("input", { value: v.unit, maxlength: 20 });
  const min = h("input", { inputmode: "numeric", value: v.min ?? "" });
  const max = h("input", { inputmode: "numeric", value: v.max ?? "" });
  const samples = h("input", { inputmode: "numeric", value: v.samples || "" });
  const bFrom = h("input", { inputmode: "numeric", value: v.bbch_from ?? "" });
  const bTo = h("input", { inputmode: "numeric", value: v.bbch_to ?? "" });
  const stage = h("input", { value: v.stage, maxlength: 80, placeholder: "z. B. Reife" });
  const hint = h("input", { value: v.hint, maxlength: 300 });

  const optField = field("Auswahlwerte", options, "Ein Wert je Zeile");
  const scoreBox = h("div", { class: "grid-3" }, field("Note von", min), field("bis", max), field("Beschriftung", labels));
  const numBox = h("div", { class: "grid-2" }, field("Einheit", unit), field("Mittel aus Einzelwerten", samples, "leer = ein Wert"));
  const showFor = () => {
    const ty = type.value;
    optField.hidden = !["choice", "multi", "rated", "amount"].includes(ty);
    optField.querySelector("span").textContent = ty === "amount" ? "Einheiten" : ty === "rated" ? "Erreger oder Schädlinge" : "Auswahlwerte";
    scoreBox.hidden = ty !== "score";
    numBox.hidden = ty !== "number";
  };
  type.addEventListener("change", showFor);
  showFor();
  const n = (el) => (el.value.trim() === "" ? null : Number(el.value.replace(",", ".")));
  const dlg = shell(isNew ? "Eigenes Merkmal" : t.name, { onSubmit: async () => {
    const ty = type.value;
    const payload = { name: name.value.trim(), grp: grp.value, section: section.value, freq: freq.value, level: level.value,
      type: ty, stage: stage.value.trim(), hint: hint.value.trim(), bbch_from: n(bFrom), bbch_to: n(bTo), unit: "", samples: 0, min: null, max: null };
    if (!payload.name) throw new Error("Bitte einen Namen eingeben");
    if (["choice", "multi", "rated", "amount"].includes(ty)) payload.options = options.value.split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (ty === "score") {
      payload.min = n(min) ?? 1;
      payload.max = n(max) ?? 9;
      payload.options = Object.fromEntries(labels.value.split(/\n/).map((l) => l.split("=")).filter((x) => x.length === 2 && x[1].trim())
        .map(([k, l]) => [k.trim(), l.trim()]));
    }
    if (ty === "number") {
      payload.unit = unit.value.trim();
      payload.samples = Math.max(0, Math.round(n(samples) || 0));
    }
    await saveTrait(t?.id, payload);
    after?.();
  } });
  dlg.body.append(
    h("div", { class: "grid-2" }, field("Name", name), field("Werttyp", type)),
    h("div", { class: "grid-2" }, field("Kultur", grp), field("Bereich", section)),
    h("div", { class: "grid-2" }, field("Häufigkeit", freq), field("Ebene", level)),
    optField, scoreBox, numBox,
    h("div", { class: "grid-3" }, field("Zeitpunkt", stage), field("BBCH von", bFrom), field("BBCH bis", bTo)),
    field("Hinweis", hint, "erscheint beim Erfassen unter dem Namen"));
  dlg.foot.append(
    isNew ? null : h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      if (!(await confirmDialog(`„${t.name}“ wird aus dem Katalog gelöscht.`, { title: "Merkmal löschen?" }))) return;
      try { await deleteTrait(t.id); dlg.dlg.close(); after?.(); } catch (e) { dlg.showError(e.message); }
    } }, "Löschen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Anlegen" : "Speichern"));
  dlg.open();
}
