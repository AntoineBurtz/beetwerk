// Übersichten zum Lesen: Kultur, Beet und Satz. Geändert wird erst nach „Bearbeiten“.
// Namen sind Verweise: Kultur, Beet, Sorte und Satz öffnen ihre Übersicht über der aktuellen;
// „Schließen“ führt zurück. Offene Übersichten zeigen nach dem Speichern gleich den neuen Stand.
import { state, api, find, subscribe, select, issuesOf, create, setDay, emit } from "./store.js";
import {
  h, phases, fmtDay, fmtNum, plural, yearOf, yearStart, yearLength, isMixed, varietyText, plantCount, rowCount,
  spanOf, spacing, mixPlan, KIND_LABEL, PLANTABLE, isoWeek, dayNum, onBedAt, isoOf, monthStarts, MONTHS_SHORT,
  cropFor, otherMethod, METHOD_LABEL,
} from "./util.js";
import { icon, toast } from "./ui.js";
import { shell, openCropEditor, openBedEditor, openPlantingEditor, followUp, goalSeries } from "./editor.js";
import { miniTimeline, rotationHistory } from "./bedpanel.js";
import { openVarietyDetail, openVarietyEditor, varietyThumb } from "./varieties.js";
import { cardTraits } from "./profileform.js";
import { openGoalEditor, goalPlantings, bedPlan, itemsOf, showGoalOnMap } from "./goals.js";
import { openBonitur } from "./bonitur.js";
import { mixLegend } from "./mix.js";
import { feedBlock, feedLabel } from "./feedui.js";

const TRAIT_GROUP = { tomato: "Tomate (UPOV)", pepper: "Paprika und Chili (UPOV)" };
const STATUS = { wish: "gewünscht", promised: "zugesagt", done: "abgeholt", cancelled: "abgesagt" };

// ---------------------------------------------------------------- Bausteine

export function link(text, onClick, { dot, title } = {}) {
  return h("button", { type: "button", class: "link ov-link", title, onclick: (e) => { e.stopPropagation(); onClick(); } },
    dot ? h("span", { class: "dot", style: { background: dot } }) : null, text);
}

export function cropLink(crop) {
  return crop ? link(crop.name, () => openCropOverview(crop), { dot: crop.color, title: `Übersicht ${crop.name}` }) : "Kultur";
}

export function bedLink(bed) {
  return bed ? link(bed.name, () => openBedOverview(bed), { title: `Übersicht ${bed.name}` }) : h("span", { class: "muted" }, "Ohne Beet");
}

export function varietyOf(cropId, name) {
  const key = (name || "").trim().toLowerCase();
  return key ? state.varieties.find((v) => v.crop_id === cropId && v.name.trim().toLowerCase() === key) : null;
}

export function varietyLink(cropId, name) {
  const v = varietyOf(cropId, name);
  return v ? link(name, () => openVarietyDetail(v), { title: `Sorte ${name}` }) : h("span", {}, name);
}

function facts(pairs) {
  const shown = pairs.filter(([, value]) => value != null && value !== "" && value !== false);
  return shown.length ? h("dl", { class: "var-facts" }, shown.map(([label, value]) => h("div", {}, h("dt", {}, label), h("dd", {}, value)))) : null;
}

function block(title, ...kids) {
  return h("section", { class: "var-block" }, typeof title === "string" ? h("h3", {}, title) : title, ...kids);
}

function blockHead(title, ...actions) {
  return h("div", { class: "ov-head" }, h("h3", {}, title), ...actions);
}

function closeAll() {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}

export function showOnMap(sel, day) {
  closeAll();
  if (day != null) setDay(day);
  select(sel);
  location.hash = "karte";
}

// Dialog, der sich bei jeder Änderung neu zeichnet, solange er offen ist; verschwindet das Ding, schließt er
function liveDialog({ get, title, extraHead, render, foot, cls, onEdit }) {
  const first = get();
  const head = h("span", { class: "ov-extra" });
  const ui = shell(title(first), { extraHead: head, onSubmit: () => { onEdit(get()); return false; } });
  ui.dlg.classList.add("var-detail", "ov-dialog");
  if (cls) ui.dlg.classList.add(cls);
  const content = h("div", { class: "ov" });
  ui.body.append(content);
  const paint = () => {
    const item = get();
    if (!item) { ui.dlg.close(); return; }
    ui.form.querySelector(".dlg-head h2").textContent = title(item);
    head.replaceChildren(...[extraHead?.(item)].flat().filter(Boolean));
    content.replaceChildren(...render(item, paint).flat().filter((x) => x != null && x !== false));
  };
  paint();
  const unsub = subscribe((reason) => { if (reason === "data" && ui.dlg.open) paint(); });
  ui.dlg.addEventListener("close", unsub);
  ui.foot.append(foot(ui));
  ui.open();
  ui.foot.querySelector("[type=submit]")?.focus();
  return ui;
}

function plantingRow(p, { showCrop = false, showBed = true, count } = {}) {
  const ph = phases(p);
  const crop = find.crop(p.crop_id);
  const bed = find.bed(p.bed_id);
  const n = count ?? (isMixed(p) ? mixPlan(p, crop, bed).total : plantCount(p, crop, bed));
  return h("button", { type: "button", class: "ov-row", onclick: () => openPlantingOverview(p) },
    h("span", { class: "ov-row-main" },
      showCrop ? h("span", { class: "dot", style: { background: crop?.color } }) : null,
      h("strong", {}, showCrop ? (crop?.name ?? "Kultur") : (varietyText(p) || "ohne Sorte")),
      showCrop && varietyText(p) ? h("span", { class: "muted" }, ` ${varietyText(p)}`) : null,
      showBed ? h("span", { class: "muted" }, ` · ${bed ? bed.name : "ohne Beet"}`) : null),
    h("span", { class: "ov-row-sub muted" },
      `${ph.plant != null ? `Aussaat ${fmtDay(ph.sow)}, pflanzen ${fmtDay(ph.plant)}` : `Aussaat ${fmtDay(ph.sow)}`}`
      + ` · Ernte ${fmtDay(ph.hs)} bis ${fmtDay(ph.he)} · ${plural(n, "Pflanze", "Pflanzen")}`),
    miniTimeline(p, yearOf(ph.fieldStart)));
}

function yearPlantings(filter, year) {
  const ys = yearStart(year), ye = ys + yearLength(year) - 1;
  return state.plantings.filter(filter)
    .filter((p) => { const ph = phases(p); return ph.sow <= ye && ph.he >= ys; })
    .sort((a, b) => phases(a).sow - phases(b).sow);
}

// ---------------------------------------------------------------- Kultur

// Merkmale je Sorte für die Karten; nach Änderungen im Hintergrund neu laden und dann neu zeichnen
let summaries = null;
let stale = true;
let loading = null;
function freshSummaries(repaint) {
  if (!stale || loading) return;
  loading = api.get("/api/varieties/profiles")
    .then((res) => { summaries = res; })
    .catch(() => { summaries = summaries || {}; })
    .finally(() => { stale = false; loading = null; repaint(); });
}
subscribe((reason) => { if (reason === "data") stale = true; });

function varietyCard(v, crop) {
  const traits = cardTraits(summaries?.[v.id] || [], 3);
  return h("button", { type: "button", class: "var-card ov-var", onclick: () => openVarietyDetail(v) },
    h("span", { class: "var-thumb" }, varietyThumb(v, crop)),
    h("span", { class: "var-body" },
      h("span", { class: "var-name" }, v.name),
      h("span", { class: "var-tags" }, [v.kind, v.seed].filter(Boolean).map((t) => h("span", { class: "fam" }, t))),
      traits.length ? h("span", { class: "var-traits" }, traits.map((t) => t.text).join(" · ")) : null));
}

export function openCropOverview(crop0) {
  liveDialog({
    get: () => find.crop(crop0.id),
    title: (c) => c.name,
    extraHead: (c) => c.family ? h("span", { class: "var-head-crop" }, h("span", { class: "dot", style: { background: c.color } }), c.family) : null,
    onEdit: (c) => openCropEditor(c),
    render: (c, repaint) => {
      freshSummaries(repaint);
      const year = yearOf(state.day);
      const transplant = c.method === "transplant";
      const second = cropFor(c, otherMethod(c.method));
      const sow = find.container(c.sow_container_id);
      const pot = find.container(c.pot_container_id);
      const place = find.place(c.place_id);
      const grow = find.place(c.grow_place_id);
      const rotation = Number(state.settings.rotation_years ?? 3);
      const main = facts([
        ["Anbau", `${transplant ? "Voranzucht und Pflanzung" : "Direktsaat"}${c.alt ? `, auch ${METHOD_LABEL[second.method]}` : ""}`],
        ["Kulturdauer", transplant
          ? `${c.nursery_days} Tage Anzucht, ${c.field_days} Tage im Beet bis zur Ernte, ${c.harvest_days} Tage Ernte`
          : `${c.field_days} Tage bis zur Ernte, ${c.harvest_days} Tage Ernte`],
        ["Abstände", `${c.row_spacing} × ${c.plant_spacing} cm (${fmtNum(10000 / (c.row_spacing * c.plant_spacing))} Pflanzen je m²)`],
        // die andere Anbauart mit ihrer Kulturdauer und, wenn sie abweichen, ihren Abständen
        [METHOD_LABEL[second.method], !c.alt ? null : (second.method === "transplant"
          ? `${second.nursery_days} Tage Anzucht, ${second.field_days} Tage im Beet bis zur Ernte`
          : `${second.field_days} Tage bis zur Ernte`) + (second.estimated ? " (geschätzt)" : "")
          + (second.row_spacing !== c.row_spacing || second.plant_spacing !== c.plant_spacing
            ? `, Abstände ${second.row_spacing} × ${second.plant_spacing} cm` : "")],
        ["Fruchtfolge", c.family ? `${c.family}, ${rotation} Jahre Anbaupause` : "keine Familie angegeben – keine Prüfung"],
        ["Düngung", c.feed ? (c.feed === "none" ? "kein Stickstoffdünger, Kompost genügt"
          : `Stickstoffbedarf ${feedLabel(c)}${c.feed_cut ? ", nach den Schnitten nachdüngen" : ""}`) : null],
        ["Bonitur", c.trait_group ? `Merkmale für ${TRAIT_GROUP[c.trait_group]}` : "allgemeine Merkmale"],
      ]);
      const nursery = transplant || c.alt ? block("Anzucht", h("ul", { class: "calc" },
        h("li", {}, sow ? `Aussaat in ${sow.name}` : h("span", { class: "muted" }, "Kein Anzuchtgefäß eingestellt"),
          pot ? `, nach ${c.prick_days} Tagen in ${pot.name} pikieren` : ""),
        h("li", {}, `${plural(c.seeds_per_cell ?? 1, "Korn", "Körner")} je Zelle · ${c.germination ?? 80} % Keimrate · `
          + `${c.reserve ?? 20} % Reserve · ${c.harden_days ?? 7} Tage abhärten`),
        h("li", {}, c.warm ? "braucht Wärme zum Keimen" : "keimt auch kühl",
          place ? ` · ${place.name}${grow && grow.id !== place.id ? `, nach dem Pikieren ${grow.name}` : ""}` : ""))) : null;

      // Sorten der Kultur, dazu Namen aus Sätzen, die noch nicht in der Sortenliste stehen
      const vs = state.varieties.filter((v) => v.crop_id === c.id);
      const listed = new Set(vs.map((v) => v.name.trim().toLowerCase()));
      const loose = new Map();
      for (const p of state.plantings) {
        if (p.crop_id !== c.id) continue;
        for (const n of isMixed(p) ? p.varieties.map((x) => x.name) : [p.variety]) {
          const k = (n || "").trim().toLowerCase();
          if (k && !listed.has(k)) loose.set(k, n.trim());
        }
      }
      const cards = vs.map((v) => varietyCard(v, c));
      const sorten = block(blockHead(`Sorten (${vs.length})`,
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openVarietyEditor(null, null, { crop_id: c.id }) }, icon("plus"), "Sorte")),
      vs.length ? h("div", { class: "ov-varieties" }, cards) : h("p", { class: "muted small", style: { margin: 0 } }, "Noch keine Sorte in der Sortenliste."),
      loose.size ? h("p", { class: "small", style: { margin: 0 } }, `In Sätzen, aber nicht in der Sortenliste: ${[...loose.values()].join(", ")}. `,
        link("In die Sortenliste aufnehmen", async () => {
          for (const name of loose.values()) {
            try { await create("varieties", { crop_id: c.id, name }); } catch (e) { toast(e.message, { error: true }); }
          }
        })) : null);

      const ps = yearPlantings((p) => p.crop_id === c.id, year);
      const other = state.plantings.filter((p) => p.crop_id === c.id).length - ps.length;
      const saetze = block(blockHead(`Sätze ${year}`,
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openPlantingEditor(null, { crop_id: c.id, anchor: state.day }) }, icon("plus"), "Satz")),
      ps.length ? h("div", { class: "ov-rows" }, ps.map((p) => plantingRow(p))) : h("p", { class: "muted small", style: { margin: 0 } }, `${year} ist noch kein Satz geplant.`),
      other > 0 ? h("p", { class: "muted small", style: { margin: 0 } }, `Dazu ${plural(other, "Satz", "Sätze")} in anderen Jahren.`) : null);

      const goals = (state.goals || []).filter((g) => g.crop_id === c.id);
      const wishes = state.handovers.filter((x) => x.crop_id === c.id && x.status !== "cancelled" && x.pickup_date.startsWith(String(year)));
      return [
        main,
        nursery,
        sorten,
        saetze,
        goals.length ? block("Ernteziele", h("ul", { class: "calc" }, goals.map((g) => h("li", {},
          link(`${fmtNum(g.amount)} ${g.unit} je Woche${g.variety ? ` (${g.variety})` : ""}`, () => openGoalOverview(g)),
          h("span", { class: "muted" }, ` · KW ${isoWeek(dayNum(g.start_date))} bis ${isoWeek(dayNum(g.end_date))}`))))) : null,
        wishes.length ? block("Für Freunde", h("ul", { class: "calc" }, wishes.map((x) => h("li", {},
          h("strong", {}, x.count), ` ${x.variety || "(Sorte offen)"} für ${find.person(x.person_id)?.name || "?"}`,
          h("span", { class: "muted" }, ` · ${fmtDay(dayNum(x.pickup_date))} · ${STATUS[x.status]}`)))),
        h("p", { class: "muted small", style: { margin: 0 } }, "Ändern unter ", h("a", { href: "#anzucht", onclick: closeAll }, "Anzucht → Abgaben"), ".")) : null,
        c.notes ? block("Notizen", h("p", { class: "var-notes" }, c.notes)) : null,
      ];
    },
    foot: (ui) => [
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Schließen"),
      h("button", { type: "submit", class: "btn btn-primary" }, icon("edit"), "Bearbeiten")],
  });
}

// ---------------------------------------------------------------- Beet

export function bedFacts(b) {
  return facts([
    ["Art", KIND_LABEL[b.kind]],
    ["Größe", `${fmtNum(b.length, 2)} × ${fmtNum(b.width, 2)} m · ${fmtNum(b.length * b.width)} m²`],
    b.rotation ? ["Drehung", `${Math.round(b.rotation)}°`] : null,
  ].filter(Boolean));
}

export function openBedOverview(bed0) {
  liveDialog({
    get: () => find.bed(bed0.id),
    title: (b) => b.name,
    extraHead: (b) => h("span", { class: "var-head-crop" }, KIND_LABEL[b.kind]),
    onEdit: (b) => openBedEditor(b),
    render: (b) => {
      const year = yearOf(state.day);
      const ps = yearPlantings((p) => p.bed_id === b.id, year);
      const issues = ps.flatMap((p) => issuesOf(p.id).map((i) => ({ ...i, p })));
      return [
        bedFacts(b),
        b.notes ? h("p", { class: "var-notes" }, b.notes) : null,
        issues.length ? h("ul", { class: "issues" }, issues.map((i) => h("li", { class: i.kind }, i.text))) : null,
        PLANTABLE.has(b.kind) ? block(`Belegung ${year}`,
          ps.length ? h("div", { class: "ov-rows" }, ps.map((p) => plantingRow(p, { showCrop: true, showBed: false })))
            : h("p", { class: "muted small", style: { margin: 0 } }, "Noch nichts geplant.")) : null,
        PLANTABLE.has(b.kind) ? block("Fruchtfolge", rotationHistory(b, year)) : null,
      ];
    },
    foot: (ui) => [
      h("button", { type: "button", class: "btn", onclick: () => showOnMap({ type: "bed", id: bed0.id }) }, "Auf der Karte"),
      PLANTABLE.has(bed0.kind) ? h("button", { type: "button", class: "btn", onclick: () => openPlantingEditor(null, { bed_id: bed0.id, anchor: state.day }) }, icon("plus"), "Satz") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Schließen"),
      h("button", { type: "submit", class: "btn btn-primary" }, icon("edit"), "Bearbeiten")],
  });
}

// ---------------------------------------------------------------- Satz

export function plantingStatus(p, day = state.day) {
  const ph = phases(p);
  if (day < ph.sow) return `Aussaat in ${plural(ph.sow - day, "Tag", "Tagen")}`;
  if (ph.plant != null && day < ph.plant) return `In Anzucht, Pflanzung in ${plural(ph.plant - day, "Tag", "Tagen")}`;
  if (day < ph.hs) return `Wächst, Ernte ab ${fmtDay(ph.hs)}`;
  if (day <= ph.he) return `Ernte läuft bis ${fmtDay(ph.he, { year: yearOf(ph.he) !== yearOf(day) })}`;
  return `Abgeräumt seit ${fmtDay(ph.he, { year: yearOf(ph.he) !== yearOf(day) })}`;
}

export function openPlantingOverview(p0) {
  liveDialog({
    get: () => find.planting(p0.id),
    title: (p) => `${find.crop(p.crop_id)?.name ?? "Satz"}${varietyText(p) ? ` ${varietyText(p)}` : ""}`,
    extraHead: (p) => h("span", { class: "var-head-crop" }, plantingStatus(p)),
    onEdit: (p) => openPlantingEditor(p),
    render: (p, repaint) => {
      freshSummaries(repaint);
      const crop = find.crop(p.crop_id);
      const bed = find.bed(p.bed_id);
      const ph = phases(p);
      const sp = spacing(p, crop);
      const names = isMixed(p) ? p.varieties.map((v) => v.name) : p.variety ? [p.variety] : [];
      const missing = names.filter((n) => n.trim() && !varietyOf(p.crop_id, n));
      const goal = p.goal_id ? (state.goals || []).find((g) => g.id === p.goal_id) : null;
      const steps = [
        h("li", { class: p.sown_done ? "done" : "" }, `${p.method === "transplant" ? "Aussaat (Anzucht)" : "Aussaat"} ${fmtDay(ph.sow, { year: true })}`),
        ph.plant != null ? h("li", { class: p.planted_done ? "done" : "" }, `Pflanzung ${fmtDay(ph.plant, { year: true })}`) : null,
        h("li", { class: p.harvest_done ? "done" : "" }, `Ernte ${fmtDay(ph.hs)} bis ${fmtDay(ph.he, { year: true })}`),
      ];
      return [
        miniTimeline(p, yearOf(ph.fieldStart)),
        issuesOf(p.id).length ? h("ul", { class: "issues" }, issuesOf(p.id).map((i) => h("li", { class: i.kind }, i.text))) : null,
        facts([
          ["Kultur", cropLink(crop)],
          [isMixed(p) ? "Sorten" : "Sorte", names.length ? names.flatMap((n, i) => [i ? ", " : "", varietyLink(p.crop_id, n)]) : null],
          ["Beet", bed ? [bedLink(bed), ` · ab ${fmtNum(p.start)} m`] : h("span", { class: "muted" }, "Ohne Beet")],
          ["Fläche", `${fmtNum(p.len)} × ${fmtNum(spanOf(p, bed))} m`],
          ["Pflanzen", isMixed(p)
            ? `${mixPlan(p, crop, bed).total} auf ${plantCount(p, crop, bed)} Plätzen in ${plural(rowCount(p, crop, bed), "Reihe", "Reihen")}`
            : `${plantCount(p, crop, bed)} in ${plural(rowCount(p, crop, bed), "Reihe", "Reihen")}`],
          ["Abstände", `${sp.row} × ${sp.plant} cm`],
        ]),
        missing.length ? h("p", { class: "small", style: { margin: 0 } },
          `${missing.join(", ")} ${missing.length === 1 ? "steht" : "stehen"} noch nicht in der Sortenliste. `,
          link("Aufnehmen", async () => {
            for (const name of missing) {
              try { await create("varieties", { crop_id: p.crop_id, name: name.trim() }); } catch (e) { toast(e.message, { error: true }); }
            }
          })) : null,
        block("Ablauf", h("ul", { class: "steps" }, steps),
          p.method === "transplant" ? h("p", { class: "muted small", style: { margin: 0 } }, "Aussaat, Körner und Gefäße stehen in der ",
            h("a", { href: "#anzucht", onclick: closeAll }, "Anzucht"), ".") : null),
        !isMixed(p) && names.some((n) => varietyOf(p.crop_id, n)) ? h("div", { class: "ov-varieties" },
          names.map((n) => varietyOf(p.crop_id, n)).filter(Boolean).map((v) => varietyCard(v, crop))) : null,
        isMixed(p) ? block("Sorten im Beet", mixLegend(p, crop, bed)) : null,
        bed ? block("Düngung", feedBlock(p)) : null,
        goal ? h("p", { class: "small", style: { margin: 0 } }, goalSeries(p) ? `Satz ${goalSeries(p).pos + 1} von ${goalSeries(p).total} im Ernteziel ` : "Gehört zum Ernteziel ",
          link(`${fmtNum(goal.amount)} ${goal.unit} je Woche`, () => openGoalOverview(goal)),
          ". Ändert sich das Ziel, passt sich der Satz an, solange er nicht gesät ist.") : null,
        p.notes ? block("Notizen", h("p", { class: "var-notes" }, p.notes)) : null,
      ];
    },
    foot: (ui) => {
      const p = find.planting(p0.id) || p0;
      const crop = find.crop(p.crop_id);
      return [
        h("button", { type: "button", class: "btn", onclick: () => {
          const now = find.planting(p0.id);
          if (!now) return;
          const visible = onBedAt(now, state.day) || !now.bed_id;
          showOnMap({ type: "planting", id: now.id }, visible ? null : phases(now).fieldStart);
        } }, "Auf der Karte"),
        p.goal_id
          ? (goalSeries(p)?.next ? h("button", { type: "button", class: "btn", title: "Nächster Satz des Ernteziels, der Stichtag springt zu seiner Aussaat bzw. Pflanzung",
            onclick: async () => {
              const item = await followUp(find.planting(p0.id) || p, { place: false });
              if (item) openPlantingOverview(item);
            } }, "Nächster Satz") : null)
          : h("button", { type: "button", class: "btn", title: "Gleiche Kultur 14 Tage später", onclick: async () => {
            const item = await followUp(find.planting(p0.id) || p, { place: false });
            if (item) openPlantingOverview(item);
          } }, icon("copy"), "Folgesatz"),
        crop?.trait_group ? h("button", { type: "button", class: "btn", onclick: () => { closeAll(); openBonitur(p0.id); } }, "Bonitieren") : null,
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Schließen"),
        h("button", { type: "submit", class: "btn btn-primary" }, icon("edit"), "Bearbeiten")];
    },
  });
}

// ---------------------------------------------------------------- Ernteziel mit seinen Folgesätzen

const DONE = [["harvest_done", "abgeerntet"], ["planted_done", "gepflanzt"], ["sown_done", "gesät"]];

function seriesAxis(range) {
  return h("div", { class: "series-axis" }, monthStarts(range.ys, range.len).map(({ day, month }) =>
    h("span", { style: { left: `${((day - range.ys) / range.len) * 100}%` } }, MONTHS_SHORT[month])));
}

export function openGoalOverview(g0) {
  liveDialog({
    get: () => (state.goals || []).find((g) => g.id === g0.id),
    title: (g) => `${find.crop(g.crop_id)?.name ?? "Kultur"}${g.variety ? ` ${g.variety}` : ""}`,
    extraHead: () => h("span", { class: "var-head-crop" }, "Satzweiser Anbau"),
    onEdit: (g) => openGoalEditor(g),
    cls: "goal-ov",
    render: (g) => {
      const crop = find.crop(g.crop_id);
      const ps = goalPlantings(g);
      const items = ps.map((p) => ({ p, ph: phases(p), bed: find.bed(p.bed_id) }));
      const count = ({ p, bed }) => (isMixed(p) ? mixPlan(p, crop, bed).total : plantCount(p, crop, bed));
      const loose = ps.filter((p) => !p.bed_id).length;
      const sown = ps.filter((p) => p.sown_done).length;
      const next = items.find(({ p, ph }) => !p.sown_done && ph.sow >= state.day);
      const interval = g.interval_days || (items.length > 1 ? items[1].ph.hs - items[0].ph.hs : null);
      const gs = dayNum(g.start_date), ge = dayNum(g.end_date);
      let rows = null;
      if (items.length) {
        // gemeinsamer Maßstab für alle Sätze, auf ganze Monate gerundet
        const from = Math.min(...items.map((x) => x.ph.sow)), to = Math.max(...items.map((x) => x.ph.he));
        const a = dayNum(`${isoOf(from).slice(0, 7)}-01`);
        const range = { ys: a, len: monthStarts(to + 1, 32)[0].day - a };
        rows = h("div", { class: "ov-rows series-rows" },
          h("div", { class: "ov-row ov-axis", "aria-hidden": "true" }, h("span", { class: "muted small" }, "Satz"), seriesAxis(range)),
          items.map((it, i) => {
            const { p, ph, bed } = it;
            const done = DONE.find(([k]) => p[k]);
            return h("button", { type: "button", class: "ov-row", onclick: () => openPlantingOverview(p) },
              h("span", { class: "ov-row-main" }, h("strong", {}, `Satz ${(p.goal_seq ?? i) + 1}`),
                h("span", { class: "muted" }, ` · ${bed ? bed.name : "ohne Beet"}`),
                done ? h("span", { class: "src src-bonitur" }, done[1]) : null,
                issuesOf(p.id).length ? h("span", { class: "flag-dot", title: issuesOf(p.id).map((x) => x.text).join("\n") }, "!") : null),
              h("span", { class: "ov-row-sub muted" },
                `${ph.plant != null ? `Aussaat ${fmtDay(ph.sow)}, pflanzen ${fmtDay(ph.plant)}` : `Aussaat ${fmtDay(ph.sow)}`}`
                + ` · Ernte ${fmtDay(ph.hs)} bis ${fmtDay(ph.he)} · ${plural(count(it), "Pflanze", "Pflanzen")}`),
              miniTimeline(p, null, range));
          }));
      }
      const bed = find.bed(g.bed_id);
      const odd = Object.entries(g.weeks || {}).sort();
      return [
        facts([
          ["Kultur", cropLink(crop)],
          ["Sorte", g.variety ? varietyLink(g.crop_id, g.variety) : null],
          ["Anbau", g.method && crop && g.method !== crop.method
            ? `${METHOD_LABEL[g.method]} (üblich: ${METHOD_LABEL[crop.method]})` : null],
          ["Ziel", `${fmtNum(g.amount)} ${g.unit} je Woche`
            + (odd.length ? ` · abweichend ${odd.map(([iso, a]) => `KW ${isoWeek(dayNum(iso))}: ${fmtNum(a)}`).join(", ")}` : "")],
          ["Beet", bed ? [bedLink(bed), ` · ${fmtNum(g.block_len || 0, 2)} m ab ${fmtNum(g.block_start || 0, 2)} m (${fmtNum((g.block_len || 0) * bed.width, 1)} m²)`] : "noch keins"],
          ["Erntezeit", `${fmtDay(gs)} bis ${fmtDay(ge, { year: true })} (KW ${isoWeek(gs)} bis ${isoWeek(ge)})`],
          ["Sätze", items.length ? `${items.length}${interval ? `, alle ${plural(interval, "Tag", "Tage")}` : ""}` : "keine"],
          ["Pflanzen", items.length ? `${items.reduce((n, it) => n + count(it), 0)} zusammen` : null],
          ["Stand", items.length ? `${sown} von ${items.length} gesät${next ? ` · nächste Aussaat ${fmtDay(next.ph.sow, { year: yearOf(next.ph.sow) !== yearOf(state.day) })}` : ""}` : null],
        ]),
        bed ? bedPlan(bed, itemsOf(g), { color: crop?.color, block: { start: g.block_start || 0, len: g.block_len || 0 },
          excludeGoal: g.id, width: 640, onItem: (p) => openPlantingOverview(p) }) : null,
        loose && !bed ? h("p", { class: "small", style: { margin: 0 } },
          `${plural(loose, "Satz hat", "Sätze haben")} noch kein Beet. `,
          link("Beet wählen", () => openGoalEditor(g, { focus: "bed" })), " – dann liegen alle Sätze als Block auf diesem Beet.") : null,
        rows ? block(blockHead("Sätze"), rows) : h("p", { class: "muted" }, "Zu diesem Ziel gibt es keine Sätze mehr."),
        g.notes ? block("Notizen", h("p", { class: "var-notes" }, g.notes)) : null,
      ];
    },
    foot: (ui) => {
      // Nur in der Zeitleiste: Satzfolge auf- oder zuklappen
      const toggle = h("button", { type: "button", class: "btn" });
      const paintToggle = () => {
        toggle.textContent = state.seriesOpen.has(g0.id) ? "Als Satzfolge zeigen" : "Sätze einzeln zeigen";
        toggle.title = state.seriesOpen.has(g0.id) ? "In der Zeitleiste wieder als eine Zeile zusammenfassen" : "In der Zeitleiste jeden Satz als eigenen Balken zeigen";
      };
      toggle.onclick = () => {
        if (state.seriesOpen.has(g0.id)) state.seriesOpen.delete(g0.id); else state.seriesOpen.add(g0.id);
        paintToggle();
        emit("view");
      };
      paintToggle();
      return [
        location.hash.replace("#", "") === "zeitleiste" ? toggle : null,
        h("button", { type: "button", class: "btn", title: "Stichtag in die Zeit der Folge setzen und das Beet auf der Karte zeigen",
          onclick: () => { const g = (state.goals || []).find((x) => x.id === g0.id); ui.dlg.close(); if (g) showGoalOnMap(g); } }, "Auf der Karte"),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Schließen"),
        h("button", { type: "submit", class: "btn btn-primary" }, icon("edit"), "Bearbeiten")];
    },
  });
}
