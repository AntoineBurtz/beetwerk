// Sätze: Aufgaben rund um den Stichtag, alle Sätze des Jahres und der Bedarf an Pflanzen.
import { state, find, patch, select, issuesOf } from "./store.js";
import {
  h, phases, fmtDay, fmtNum, yearOf, yearStart, yearLength, mix, clamp, spanOf, plantCount, rowCount, area,
} from "./util.js";
import { openPlantingEditor } from "./editor.js";

let filter = "";

export function mountPlantings(root) {
  const page = h("div", { class: "page" });
  root.append(page);

  function render() {
    const keep = page.scrollTop;
    const year = yearOf(state.day);
    const inner = h("div", { class: "page-inner" },
      h("div", { class: "page-head" },
        h("h1", {}, `Sätze ${year}`),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openPlantingEditor(null, { anchor: state.day }) }, "Neuer Satz")),
      tasksSection(),
      listSection(year),
      demandSection(year));
    page.replaceChildren(inner);
    page.scrollTop = keep;
  }

  // ------------------------------------------------------------ Aufgaben

  function tasksSection() {
    const day = state.day;
    const from = day - 30, to = day + 14;
    const tasks = [];
    for (const p of state.plantings) {
      const ph = phases(p);
      const push = (d, verb, flag) => {
        if (d < from || d > to) return;
        const done = flag ? !!p[flag] : d <= day;
        if (d < day && done && flag) return; // Erledigtes aus der Vergangenheit ausblenden
        if (d < day && !flag) return;
        tasks.push({ d, verb, flag, done, p });
      };
      push(ph.sow, p.method === "transplant" ? "Vorziehen" : "Säen", "sown_done");
      if (ph.plant != null) push(ph.plant, "Auspflanzen", "planted_done");
      push(ph.hs, "Ernte beginnt", null);
      push(ph.he, "Abräumen", "harvest_done");
    }
    tasks.sort((a, b) => a.d - b.d || a.verb.localeCompare(b.verb));
    const overdue = tasks.filter((t) => t.d < day);
    const upcoming = tasks.filter((t) => t.d >= day);

    const sectionEl = h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, "Aufgaben"),
        h("span", { class: "muted small" }, `Bis zwei Wochen nach dem Stichtag (${fmtDay(day)})`)));
    if (!tasks.length) {
      sectionEl.append(h("div", { class: "empty-note" }, "In diesem Zeitraum steht nichts an."));
      return sectionEl;
    }
    const list = h("div", { class: "tasks" });
    if (overdue.length) {
      list.append(h("div", { class: "task-group" }, "Noch offen"));
      for (const t of overdue) list.append(taskRow(t, true));
    }
    if (upcoming.length) {
      list.append(h("div", { class: "task-group" }, "Demnächst"));
      for (const t of upcoming) list.append(taskRow(t, false));
    }
    sectionEl.append(list);
    return sectionEl;
  }

  function taskRow(t, overdue) {
    const c = find.crop(t.p.crop_id);
    const bed = find.bed(t.p.bed_id);
    const box = t.flag
      ? h("input", { type: "checkbox", checked: t.done, "aria-label": `${t.verb} erledigt`, style: { width: "18px", height: "18px", accentColor: "var(--leaf)" },
        onchange: (e) => patch("plantings", t.p.id, { [t.flag]: e.target.checked }) })
      : h("span", { class: "dot", style: { background: c?.color, margin: "0 3px" } });
    return h("div", { class: `task${t.done && t.flag ? " done" : ""}${overdue ? " overdue" : ""}` },
      box,
      h("span", { class: "date num" }, fmtDay(t.d)),
      h("span", { class: "verb" }, t.verb),
      h("span", { class: "what" },
        h("button", { type: "button", style: { all: "unset", cursor: "pointer" }, onclick: () => openPlantingEditor(t.p) },
          c?.name ?? "Kultur", t.p.variety ? h("span", { class: "muted" }, ` ${t.p.variety}`) : null)),
      h("span", { class: "where" }, bed ? `${t.flag === "sown_done" && t.p.method === "transplant" ? "für " : ""}${bed.name}` : "Ohne Beet"));
  }

  // ------------------------------------------------------------ Liste

  function listSection(year) {
    const ys = yearStart(year), len = yearLength(year);
    const q = filter.trim().toLowerCase();
    const rows = state.plantings
      .map((p) => ({ p, ph: phases(p), c: find.crop(p.crop_id), b: find.bed(p.bed_id) }))
      .filter(({ ph }) => ph.sow < ys + len && ph.he >= ys)
      .filter(({ p, c, b }) => !q || [c?.name, p.variety, b?.name, c?.family].some((v) => (v || "").toLowerCase().includes(q)))
      .sort((a, b) => a.ph.sow - b.ph.sow);

    const search = h("input", { class: "input", type: "search", placeholder: "Kultur, Sorte oder Beet", value: filter,
      style: { maxWidth: "260px" }, "aria-label": "Sätze filtern",
      oninput: (e) => {
        filter = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const again = page.querySelector('input[type="search"]');
        again?.focus();
        again?.setSelectionRange(pos, pos);
      } });

    const head = h("div", { class: "section-head" }, h("h2", {}, "Alle Sätze"), search);
    if (!rows.length) {
      return h("section", { class: "section" }, head,
        h("div", { class: "empty-note" }, q ? "Kein Satz passt zum Filter." : `Für ${year} ist noch nichts geplant. Ziehe auf der Karte eine Kultur auf ein Beet oder lege hier einen Satz an.`));
    }

    const pct = (d) => clamp(((d - ys) / len) * 100, 0, 100);
    const table = h("table", { class: "data" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Kultur"), h("th", {}, "Beet"), h("th", {}, "Aussaat"), h("th", {}, "Pflanzung"),
        h("th", {}, "Ernte"), h("th", { class: "r" }, "Fläche"), h("th", { class: "r" }, "Pflanzen"),
        h("th", { class: "tl-cell" }, String(year)), h("th", {}, h("span", { class: "sr-only" }, "Hinweise")))),
      h("tbody", {}, rows.map(({ p, ph, c, b }) => {
        const issues = issuesOf(p.id);
        const color = c?.color || "#6a9b3c";
        const mini = h("div", { class: "mini-tl" });
        if (ph.plant != null) mini.append(h("i", { style: { left: `${pct(ph.sow)}%`, width: `${pct(ph.plant) - pct(ph.sow)}%`, background: mix(color, "#ffffff", 0.7), top: "3px", bottom: "3px" } }));
        mini.append(h("i", { style: { left: `${pct(ph.fieldStart)}%`, width: `${pct(ph.hs) - pct(ph.fieldStart)}%`, background: mix(color, "#ffffff", 0.45) } }));
        mini.append(h("i", { style: { left: `${pct(ph.hs)}%`, width: `${Math.max(0.6, pct(ph.he + 1) - pct(ph.hs))}%`, background: color } }));
        if (state.day >= ys && state.day < ys + len) mini.append(h("span", { class: "now", style: { left: `${pct(state.day)}%` } }));
        const issueKind = issues.some((i) => i.kind === "conflict") ? "conflict" : issues.length ? "rotation" : null;
        return h("tr", {
          tabindex: "0",
          onclick: () => { select({ type: "planting", id: p.id }); openPlantingEditor(p); },
          onkeydown: (e) => { if (e.key === "Enter") openPlantingEditor(p); },
        },
          h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: color } }),
            h("span", {}, c?.name ?? "Kultur"), p.variety ? h("span", { class: "v" }, p.variety) : null)),
          h("td", { class: "nowrap" }, b ? b.name : h("span", { class: "muted" }, "Ohne Beet")),
          h("td", { class: "nowrap num" }, fmtDay(ph.sow)),
          h("td", { class: "nowrap num" }, ph.plant != null ? fmtDay(ph.plant) : h("span", { class: "muted" }, "direkt")),
          h("td", { class: "nowrap num" }, `${fmtDay(ph.hs)} bis ${fmtDay(ph.he, { year: yearOf(ph.he) !== year })}`),
          h("td", { class: "r nowrap" }, `${fmtNum(area(p, b))} m²`),
          h("td", { class: "r" }, plantCount(p, c, b)),
          h("td", { class: "tl-cell" }, mini),
          h("td", {}, issueKind ? h("span", { class: `issue-dot ${issueKind}`, title: issues.map((i) => i.text).join("\n") }, "!") : null));
      })));
    return h("section", { class: "section" }, head, h("div", { class: "table-wrap" }, table));
  }

  // ------------------------------------------------------------ Bedarf

  function demandSection(year) {
    const groups = new Map();
    for (const p of state.plantings) {
      const ph = phases(p);
      if (yearOf(ph.sow) !== year) continue;
      const c = find.crop(p.crop_id);
      const b = find.bed(p.bed_id);
      const key = `${p.crop_id}|${p.variety}`;
      if (!groups.has(key)) groups.set(key, { c, variety: p.variety, sets: 0, meters: 0, area: 0, plants: 0, transplant: 0, rows: 0 });
      const g = groups.get(key);
      const n = plantCount(p, c, b);
      g.sets += 1;
      g.meters += p.len * rowCount(p, c, b);
      g.area += p.len * spanOf(p, b);
      g.plants += n;
      if (p.method === "transplant") g.transplant += n;
    }
    const list = [...groups.values()].sort((a, b) => (a.c?.name || "").localeCompare(b.c?.name || "", "de") || a.variety.localeCompare(b.variety, "de"));
    const head = h("div", { class: "section-head" }, h("h2", {}, `Bedarf ${year}`),
      h("span", { class: "muted small" }, "Nach Aussaatjahr. Jungpflanzen mit 20 % Reserve gerechnet."));
    if (!list.length) return h("section", { class: "section" }, head, h("div", { class: "empty-note" }, "Noch keine Sätze mit Aussaat in diesem Jahr."));
    const table = h("table", { class: "data" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Kultur und Sorte"), h("th", { class: "r" }, "Sätze"), h("th", { class: "r" }, "Fläche"),
        h("th", { class: "r" }, "Reihenmeter"), h("th", { class: "r" }, "Pflanzen"), h("th", { class: "r" }, "Jungpflanzen vorziehen"))),
      h("tbody", {}, list.map((g) => h("tr", { style: { cursor: "default" } },
        h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: g.c?.color } }),
          h("span", {}, g.c?.name ?? "Kultur"), g.variety ? h("span", { class: "v" }, g.variety) : null)),
        h("td", { class: "r" }, g.sets),
        h("td", { class: "r nowrap" }, `${fmtNum(g.area)} m²`),
        h("td", { class: "r nowrap" }, `${fmtNum(g.meters)} m`),
        h("td", { class: "r" }, g.plants),
        h("td", { class: "r" }, g.transplant ? Math.ceil(g.transplant * 1.2) : h("span", { class: "muted" }, "–"))))));
    return h("section", { class: "section" }, head, h("div", { class: "table-wrap" }, table));
  }

  render();
  return {
    update() { render(); },
  };
}
