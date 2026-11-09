// Anzucht: Wochenplan, Anzuchten, Abgaben an Freunde, Plätze und Gefäße.
// Gerechnet wird auf dem Server (/api/nursery) aus den Sätzen und den Wünschen der Freunde.
import { state, api, find, create, patch, remove, subscribe, emit } from "./store.js";
import { h, fmtDay, dayNum, isoOf, isoWeek, yearOf, plural, fmtNum, todayNum } from "./util.js";
import { toast, confirmDialog, icon, iconBtn, replaceKeepingFocus } from "./ui.js";
import { shell, field, openCropEditor } from "./editor.js";
import { openGoalEditor } from "./goals.js";
import { openCropOverview, openPlantingOverview, link } from "./overview.js";

const VERB = { sow: "Aussäen", prick: "Pikieren", harden: "Abhärten", plant: "Auspflanzen", handover: "Abgeben" };
const STATUS = { wish: "gewünscht", promised: "zugesagt", done: "abgeholt", cancelled: "abgesagt" };
const KIND = { tray: "Saatschale", cells: "Multitopfplatte", pot: "Einzeltopf" };
const WEEKDAY = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

let tab = (() => { try { return sessionStorage.getItem("beetwerk.nurseryTab") || "plan"; } catch { return "plan"; } })();
let year = null;
let hideDone = false;

function weekday(iso) {
  return WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()];
}

function day(iso, opts) {
  return iso ? fmtDay(dayNum(iso), opts) : "–";
}

function kw(iso) {
  return `KW ${isoWeek(dayNum(iso))}`;
}

function monday(iso) {
  const n = dayNum(iso);
  return n - ((new Date(n * 86400000).getUTCDay() + 6) % 7);
}

function num(v, digits = 1) {
  return fmtNum(Math.round(v * 10 ** digits) / 10 ** digits, digits);
}

function title(b) {
  return [b.crop.name, b.variety || (b.only_friends ? "Sorte offen" : "")].filter(Boolean).join(" ");
}

// „34 Körner in Saatschale (0,3 Schalen)“, „14 Zellen einer Multitopfplatte 104“, „27 × Topf 9 cm“
function containerText(c, count) {
  if (!c) return "";
  if (c.kind === "pot") return `${count} × ${c.name}`;
  if (c.kind === "tray") return `${c.name} (${num(c.units)} ${c.units === 1 ? "Schale" : "Schalen"})`;
  return `${count} Zellen · ${num(c.units)} × ${c.name}`;
}

function sowText(b) {
  if (!b.sow) return `${b.seeds} Körner – Anzuchtgefäß fehlt`;
  if (b.sow.kind === "tray") return `${b.seeds} Körner in ${containerText(b.sow, b.cells)}`;
  const k = b.seeds_per_cell > 1 ? ` à ${b.seeds_per_cell} Körner` : "";
  return `${b.seeds} Körner: ${containerText(b.sow, b.cells)}${k}`;
}

function forText(b) {
  const parts = [];
  if (b.own_count) parts.push(`${b.own_count} Beet`);
  if (b.friend_count) parts.push(`${b.friend_count} Freunde`);
  return `${parts.join(" + ")} + ${b.reserve} % Reserve = ${b.target} Jungpflanzen`;
}

export function mountNursery(root) {
  const page = h("div", { class: "page" });
  root.append(page);
  if (year == null) {
    const d = new Date(state.day * 86400000);
    year = d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); // ab Oktober: nächste Saison
  }
  let plan = null;
  let error = null;
  let seq = 0;
  let timer = null;
  let jump = true; // nach dem Laden zur aktuellen Woche

  async function load() {
    const my = ++seq;
    try {
      const res = await api.get(`/api/nursery?year=${year}`);
      if (my !== seq) return;
      plan = res;
      error = null;
    } catch (e) {
      if (my !== seq) return;
      error = e.message;
    }
    render();
    if (jump && plan && tab === "plan") {
      jump = false;
      const target = page.querySelector(".nweek.now") || page.querySelector(".nweek:not(.past)");
      if (target && page.querySelector(".nweek.past")) {
        page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top - 16;
      }
    }
  }

  // Ändert sich die Planung (Sätze, Kulturen, Wünsche), neu rechnen
  const unsub = subscribe((reason) => {
    if (reason !== "data") return;
    clearTimeout(timer);
    timer = setTimeout(load, 120);
  });

  async function saveBatch(key, changes) {
    const res = await api.patch("/api/nursery", { key, ...changes });
    for (const [id, flag] of Object.entries(res.plantings_sown || {})) {
      const p = find.planting(Number(id));
      if (p) p.sown_done = flag ? 1 : 0;
    }
    plan = res;
    render();
    if (Object.keys(res.plantings_sown || {}).length) emit("data");
  }

  function setTab(k) {
    tab = k;
    try { sessionStorage.setItem("beetwerk.nurseryTab", k); } catch { /* egal */ }
    render();
  }

  function head() {
    const opt = (k, label) => {
      const input = h("input", { type: "radio", name: "nursery-tab", checked: tab === k });
      input.addEventListener("change", () => setTab(k));
      return h("label", {}, input, label);
    };
    const n = plan ? plan.batches.length : 0;
    const wishes = plan ? plan.handovers.filter((x) => x.status !== "cancelled").length : 0;
    return h("div", { class: "page-head" },
      h("h1", {}, "Anzucht"),
      h("div", { class: "year-switch" },
        iconBtn("left", "Jahr zurück", () => { year -= 1; plan = null; jump = true; render(); load(); }),
        h("strong", { class: "num" }, String(year)),
        iconBtn("right", "Jahr vor", () => { year += 1; plan = null; jump = true; render(); load(); })),
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Ansicht" },
        opt("plan", "Wochenplan"), opt("batches", ["Anzuchten", n ? h("span", { class: "seg-count" }, `\u00a0(${n})`) : null]),
        opt("friends", ["Abgaben", wishes ? h("span", { class: "seg-count" }, `\u00a0(${wishes})`) : null]), opt("places", "Plätze")));
  }

  function render() {
    const keep = page.scrollTop;
    let body;
    if (error) body = h("div", { class: "empty-note" }, `Die Anzucht konnte nicht berechnet werden: ${error}`);
    else if (!plan) body = h("p", { class: "muted" }, "Rechne …");
    else if (tab === "batches") body = batchesView();
    else if (tab === "friends") body = friendsView();
    else if (tab === "places") body = placesView();
    else body = planView();
    replaceKeepingFocus(page, [h("div", { class: "page-inner nursery" }, head(), body)]);
    page.scrollTop = keep;
  }

  const byKey = () => new Map((plan?.batches || []).map((b) => [b.key, b]));

  // ------------------------------------------------------------ Wochenplan

  function notices() {
    const out = [];
    const missing = [...new Map(plan.batches.filter((b) => b.setup_missing).map((b) => [b.crop.id, b.crop])).values()];
    if (missing.length) {
      out.push(h("div", { class: "note warn" }, icon("drop"),
        h("span", {}, "Für ", missing.flatMap((c, i) => [i ? ", " : "", h("button", { type: "button", class: "link",
          onclick: () => openCropEditor(find.crop(c.id)) }, c.name)]), " ist kein Anzuchtgefäß eingestellt. Ohne Gefäß zählt Beetwerk nur die Körner.")));
    }
    const over = [];
    for (const r of plan.occupancy.rows) {
      const weeks = plan.occupancy.weeks.filter((_, i) => r.over[i]);
      if (weeks.length) {
        const max = Math.max(...r.use.filter((_, i) => r.over[i]));
        over.push(`${r.name} in ${weeks.length === 1 ? `KW ${weeks[0].week}` : `KW ${weeks[0].week}–${weeks[weeks.length - 1].week}`} (bis ${num(max)} von ${num(r.slots)} Plattenplätzen)`);
      }
    }
    if (over.length) {
      out.push(h("div", { class: "note bad" }, h("strong", {}, "!"),
        h("span", {}, "Zu voll: ", over.join("; "), ". ",
          h("button", { type: "button", class: "link", onclick: () => setTab("places") }, "Belegung ansehen"))));
    }
    const short = plan.batches.filter((b) => b.short > 0);
    if (short.length) {
      out.push(h("div", { class: "note bad" }, h("strong", {}, "!"),
        h("span", {}, "Zu wenig Jungpflanzen: ", short.flatMap((b, i) => [i ? "; " : "", h("button", { type: "button", class: "link",
          onclick: () => openBatch(b) }, title(b)), ` fehlen ${b.short}`]))));
    }
    if (plan.orphans.length) {
      out.push(h("div", { class: "note" }, h("span", {},
        `Gesät, aber nicht mehr geplant: ${plan.orphans.map((o) => `${find.crop(o.crop_id)?.name || "Kultur"} ${o.variety} (${day(o.sow_date)})`).join(", ")}. `,
        "Wahrscheinlich hat sich ein Satz geändert. Die Pflanzen sind trotzdem da – vielleicht für Freunde?")));
    }
    return out;
  }

  function planView() {
    if (!plan.batches.length) {
      return h("div", { class: "empty-note" },
        `Für ${year} gibt es noch keine Anzucht. Sie entsteht aus den Sätzen mit „Anzucht und Pflanzung“, aus dem satzweisen Anbau und aus den Wünschen deiner Freunde. `,
        h("button", { type: "button", class: "link", onclick: () => openGoalEditor(null, { year }) }, "Satzweise anbauen"),
        plan.years.length ? h("div", { style: { marginTop: "8px" } }, "Anzucht gibt es in: ",
          plan.years.flatMap((y, i) => [i ? ", " : "", h("button", { type: "button", class: "link",
            onclick: () => { year = Number(y); plan = null; jump = true; render(); load(); } }, y)])) : null);
    }
    const batches = byKey();
    const today = todayNum();
    const thisWeek = monday(isoOf(today));
    const groups = new Map();
    for (const t of plan.tasks) {
      if (hideDone && t.done) continue;
      const m = monday(t.date);
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(t);
    }
    const weeks = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    const list = weeks.map(([m, items]) => {
      const open = items.filter((t) => !t.done).length;
      return h("section", { class: `nweek${m === thisWeek ? " now" : ""}${m < thisWeek ? " past" : ""}`, id: `kw-${m}` },
        h("div", { class: "nweek-head" },
          h("h3", {}, `KW ${isoWeek(m)}`),
          h("span", { class: "muted" }, `${fmtDay(m)} bis ${fmtDay(m + 6)}`),
          m === thisWeek ? h("span", { class: "src src-bonitur" }, "diese Woche") : null,
          h("span", { class: "muted small nweek-count" }, open ? `${open} offen` : "erledigt")),
        h("div", { class: "tasks" }, items.map((t) => taskRow(t, batches.get(t.key), m < thisWeek))));
    });
    const toggle = h("label", { class: "check" },
      h("input", { type: "checkbox", checked: hideDone, onchange: (e) => { hideDone = e.target.checked; render(); } }),
      "Erledigtes ausblenden");
    return h("div", { class: "section" },
      ...notices(),
      h("div", { class: "section-head" }, h("h2", {}, `Wochenplan ${year}`),
        h("span", { class: "muted small" }, "Aus den Sätzen mit Anzucht und den Wünschen deiner Freunde"), toggle,
        h("button", { type: "button", class: "btn btn-sm", title: "Folgesätze aus der gewünschten Erntemenge je Woche",
          onclick: () => openGoalEditor(null, { year }) }, "Satzweise anbauen")),
      list.length ? list : h("div", { class: "empty-note" }, "Alles erledigt."));
  }

  function taskRow(t, b, past) {
    if (!b) return null;
    const check = (checked) => {
      if (t.kind === "sow") return saveBatch(t.key, { sown_done: checked });
      if (t.kind === "prick") return saveBatch(t.key, { pricked_done: checked });
      if (t.kind === "harden") return saveBatch(t.key, { hardened_done: checked });
      if (t.kind === "plant") return patch("plantings", t.planting_id, { planted_done: checked });
      return patch("handovers", t.handover_id, { status: checked ? "done" : "promised" });
    };
    let detail;
    if (t.kind === "sow") detail = [sowText(b), b.warm ? " · warm" : "", b.place ? ` · ${b.place.name}` : ""];
    else if (t.kind === "prick") detail = [`in ${containerText(b.pot, b.target)}`, b.grow_place ? ` · ${b.grow_place.name}` : ""];
    else if (t.kind === "harden") detail = [`tagsüber nach draußen, Pflanzung ab ${day(b.ready_date)}`];
    else if (t.kind === "plant") detail = [`${t.count} auf ${t.bed || "Satz ohne Beet"}`];
    else detail = [`${t.count} an ${t.person}`, t.status === "wish" ? h("span", { class: "src src-manual" }, "noch nicht zugesagt") : null];
    const box = h("input", { type: "checkbox", checked: t.done, "aria-label": `${VERB[t.kind]} ${title(b)} erledigt`,
      onchange: async (e) => {
        try { await check(e.target.checked); } catch (err) { toast(err.message, { error: true }); e.target.checked = !e.target.checked; }
      } });
    return h("div", { class: `ntask k-${t.kind}${t.done ? " done" : ""}${past && !t.done ? " overdue" : ""}` },
      box,
      h("span", { class: "date num" }, `${weekday(t.date)} ${day(t.date)}`),
      h("span", { class: "verb" }, VERB[t.kind]),
      h("button", { type: "button", class: "what", onclick: () => openBatch(b) },
        h("span", { class: "dot", style: { background: b.crop.color } }), h("span", {}, title(b))),
      h("span", { class: "detail" }, ...detail));
  }

  // ------------------------------------------------------------ Anzuchten

  function batchesView() {
    if (!plan.batches.length) return planView();
    const rows = plan.batches.map((b) => h("tr", { tabindex: "0", onclick: () => openBatch(b), onkeydown: (e) => { if (e.key === "Enter") openBatch(b); } },
      h("td", { class: "nowrap num" }, `${kw(b.sow_date)} · ${day(b.sow_date)}`),
      h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: b.crop.color } }),
        h("span", {}, b.crop.name), h("span", { class: "v" }, b.variety || (b.only_friends ? "Sorte offen" : "")))),
      h("td", { class: "nowrap" }, [b.own_count ? `Beet ${b.own_count}` : null, b.friend_count ? `Freunde ${b.friend_count}` : null].filter(Boolean).join(" · ")),
      h("td", { class: "r" }, b.target),
      h("td", { class: "r" }, b.seeds),
      h("td", {}, b.sow ? b.sow.name : h("span", { class: "muted" }, "fehlt"), b.pot ? h("span", { class: "muted" }, ` → ${b.pot.name}`) : null),
      h("td", { class: "nowrap" }, b.place?.name || h("span", { class: "muted" }, b.warm ? "warm" : "–")),
      h("td", { class: "nowrap" }, statusChips(b))));
    return h("section", { class: "section" },
      ...notices(),
      h("div", { class: "section-head" }, h("h2", {}, `Anzuchten ${year}`),
        h("span", { class: "muted small" }, "Je Kultur, Sorte und Aussaattag – mit Reserve und Keimrate gerechnet")),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Aussaat"), h("th", {}, "Kultur und Sorte"), h("th", {}, "Für"),
          h("th", { class: "r" }, "Jungpflanzen"), h("th", { class: "r" }, "Körner"), h("th", {}, "Gefäß"), h("th", {}, "Platz"),
          h("th", {}, "Stand"))),
        h("tbody", {}, rows))));
  }

  function statusChips(b) {
    const out = [];
    if (b.hardened) out.push(h("span", { class: "src src-bonitur" }, "abgehärtet"));
    else if (b.pricked) out.push(h("span", { class: "src src-bonitur" }, "pikiert"));
    else if (b.sown) out.push(h("span", { class: "src src-bonitur" }, "gesät"));
    else out.push(h("span", { class: "src src-manual" }, "geplant"));
    if (b.short > 0) out.push(h("span", { class: "src src-short" }, `${b.short} fehlen`));
    return out;
  }

  // Übersicht einer Anzucht: Termine, Rechnung, für wen, Stand. Eintragen erst per Knopf.
  function openBatch(b0) {
    const b = byKey().get(b0.key) || b0;
    const crop = find.crop(b.crop_id);
    const st = b.state || {};
    const ui = shell(title(b), {
      extraHead: h("span", { class: "var-head-crop" }, crop ? link(crop.name, () => openCropOverview(crop), { dot: crop.color }) : null,
        ` · Aussaat ${kw(b.sow_date)}`),
      onSubmit: () => { openBatchEditor(b, () => { ui.dlg.close(); const fresh = byKey().get(b.key); if (fresh) openBatch(fresh); }); return false; },
    });
    ui.dlg.classList.add("var-detail");
    const dates = [["Aussaat", b.sow_date], ["Pikieren", b.prick_date], ["Abhärten ab", b.harden_date],
      [b.own.length ? "Pflanzung" : "Abholung", b.ready_date]].filter(([, d]) => d);
    const who = [
      ...b.own.map((o) => h("li", {}, h("strong", {}, o.count), " für ",
        link(o.bed || "Satz ohne Beet", () => { const p = find.planting(o.planting_id); if (p) openPlantingOverview(p); }, { title: "Satz ansehen" }),
        h("span", { class: "muted" }, ` · pflanzen ${weekday(o.plant_date)} ${day(o.plant_date)}`))),
      ...b.friends.map((f) => h("li", {}, h("strong", {}, f.count), ` für ${f.person}`,
        h("span", { class: "muted" }, ` · abholen ${weekday(f.pickup_date)} ${day(f.pickup_date)} · ${STATUS[f.status]}`))),
    ];
    const steps = [["gesät", b.sown], b.prick_date ? ["pikiert", b.pricked] : null, b.harden_date ? ["abgehärtet", b.hardened] : null].filter(Boolean);
    const place = find.place(st.place_id) || (crop && find.place(crop.place_id));
    const grow = find.place(st.grow_place_id) || (crop && find.place(crop.grow_place_id));
    ui.body.append(
      h("dl", { class: "var-facts nursery-dates" }, dates.map(([l, d]) => h("div", {}, h("dt", {}, l), h("dd", {}, `${weekday(d)} ${day(d, { year: true })}`)))),
      h("section", { class: "var-block" }, h("h3", {}, "Rechnung"),
        h("ul", { class: "calc" },
          h("li", {}, forText(b)),
          h("li", {}, `${b.germination} % Keimrate → ${sowText(b)}`),
          b.pot ? h("li", {}, `nach ${crop?.prick_days ?? "?"} Tagen pikieren: ${containerText(b.pot, b.target)}`) : null,
          h("li", { class: "muted" }, `Plattenplätze: ${num(b.sow?.slots || 0)} bei der Aussaat${b.pot ? `, ${num(b.pot.slots)} nach dem Pikieren` : ""}`))),
      h("section", { class: "var-block" }, h("h3", {}, "Für wen"), h("ul", { class: "calc" }, who)),
      h("section", { class: "var-block" }, h("h3", {}, "Stand"),
        h("ul", { class: "steps" }, steps.map(([label, done]) => h("li", { class: done ? "done" : "" }, label))),
        h("dl", { class: "var-facts" },
          h("div", {}, h("dt", {}, "Gesät"), h("dd", {}, st.seeds_sown != null ? `${st.seeds_sown} Körner` : `geplant ${b.seeds} Körner`)),
          h("div", {}, h("dt", {}, "Jungpflanzen"), h("dd", {}, b.have != null ? `${b.have} vorhanden${st.plants_raised == null ? " (geschätzt aus der Keimrate)" : ""}` : `gebraucht ${b.need}, mit Reserve ${b.target}`)),
          h("div", {}, h("dt", {}, "Platz"), h("dd", {}, place ? `${place.name}${b.pot && grow && grow.id !== place.id ? `, dann ${grow.name}` : ""}` : "–"))),
        b.short > 0 ? h("p", { class: "form-error", style: { margin: 0 } }, `Es fehlen ${b.short} Pflanzen für den Bedarf.`) : null,
        st.notes ? h("p", { class: "var-notes" }, st.notes) : null));
    ui.foot.append(
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Schließen"),
      h("button", { type: "submit", class: "btn btn-primary" }, icon("edit"), "Stand eintragen"));
    ui.open();
  }

  // Was wirklich passiert ist: Häkchen, Anzahlen, Platz, Notizen
  function openBatchEditor(b, onSaved) {
    const crop = find.crop(b.crop_id);
    const st = b.state || {};
    const numIn = (v) => h("input", { inputmode: "numeric", value: v ?? "", placeholder: "–" });
    const seeds = numIn(st.seeds_sown);
    const raised = numIn(st.plants_raised);
    const flag = (label, on) => {
      const input = h("input", { type: "checkbox", checked: on });
      return { input, el: h("label", { class: "check" }, input, label) };
    };
    const sown = flag("gesät", b.sown);
    const pricked = flag("pikiert", b.pricked);
    const hardened = flag("abgehärtet", b.hardened);
    const placeSel = (current, cropValue, label) => h("select", {},
      h("option", { value: "", selected: !current }, cropValue ? `wie bei der Kultur (${find.place(cropValue)?.name})` : `– ${label} –`),
      state.places.map((p) => h("option", { value: p.id, selected: current === p.id }, `${p.name}${p.warm ? " (warm)" : ""}`)));
    const place = placeSel(st.place_id, crop?.place_id, "kein Platz");
    const grow = placeSel(st.grow_place_id, crop?.grow_place_id, "wie Aussaat");
    const notes = h("textarea", {}, st.notes || "");
    const intOf = (el, label) => {
      const t = el.value.trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${label}: bitte eine ganze Zahl eingeben`);
      return n;
    };
    const ui = shell(`${title(b)}: Stand`, {
      onSubmit: async () => {
        const changes = {
          seeds_sown: intOf(seeds, "Gesät"), plants_raised: intOf(raised, "Jungpflanzen vorhanden"),
          place_id: Number(place.value) || 0, grow_place_id: Number(grow.value) || 0, notes: notes.value,
        };
        // Häkchen nur mitschicken, wenn sie sich geändert haben (gesät überträgt sich auf die Sätze)
        if (sown.input.checked !== b.sown) changes.sown_done = sown.input.checked;
        if (pricked.input.checked !== b.pricked) changes.pricked_done = pricked.input.checked;
        if (hardened.input.checked !== b.hardened) changes.hardened_done = hardened.input.checked;
        await saveBatch(b.key, changes);
        onSaved?.();
      },
    });
    ui.body.append(
      h("div", { class: "nursery-flags" }, sown.el, b.pot ? pricked.el : null, b.harden_date ? hardened.el : null),
      h("div", { class: "grid-2" }, field("Gesät (Körner)", seeds, `geplant ${b.seeds}`),
        field("Jungpflanzen vorhanden", raised, `gebraucht ${b.need}, geplant mit Reserve ${b.target}`)),
      h("div", { class: "grid-2" }, field("Platz bei der Aussaat", place), b.pot ? field("Platz nach dem Pikieren", grow) : null),
      field("Notizen", notes));
    ui.foot.append(
      crop ? h("button", { type: "button", class: "btn", onclick: () => openCropEditor(crop) }, "Kultur einstellen") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
    ui.open();
  }

  // ------------------------------------------------------------ Abgaben an Freunde

  function friendsView() {
    const batches = byKey();
    const list = plan.handovers;
    const groups = new Map();
    for (const x of list) {
      if (!groups.has(x.pickup_date)) groups.set(x.pickup_date, []);
      groups.get(x.pickup_date).push(x);
    }
    const sections = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, items]) => {
      const total = items.filter((x) => x.status !== "cancelled").reduce((t, x) => t + x.count, 0);
      return h("section", { class: "nweek" },
        h("div", { class: "nweek-head" }, h("h3", {}, `${weekday(d)} ${day(d)}`), h("span", { class: "muted" }, kw(d)),
          h("span", { class: "muted small nweek-count" }, plural(total, "Pflanze", "Pflanzen"))),
        h("div", { class: "tasks" }, items.map((x) => handoverRow(x, batches.get(x.batch)))));
    });
    const people = state.people.map((p) => {
      const mine = state.handovers.filter((x) => x.person_id === p.id && x.status !== "cancelled" && x.pickup_date.startsWith(String(year)));
      return h("button", { type: "button", class: "chip person", onclick: () => openPerson(p) },
        p.name, h("span", { class: "muted" }, ` ${mine.reduce((t, x) => t + x.count, 0)}`));
    });
    return h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, `Abgaben ${year}`),
        h("span", { class: "muted small" }, "Was du für wen mit anziehst. Die Pflanzen laufen in der Anzucht derselben Sorte mit."),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openHandover(null) }, icon("plus"), "Neuer Wunsch")),
      sections.length ? sections : h("div", { class: "empty-note" },
        `Noch keine Wünsche für ${year}. Trage ein, wer welche Jungpflanzen wann abholen möchte – Beetwerk sät sie dann mit.`),
      state.people.length ? h("div", { class: "section" }, h("h3", { class: "sub" }, "Personen"),
        h("div", { class: "people" }, people)) : null);
  }

  function handoverRow(x, b) {
    const crop = find.crop(x.crop_id);
    const person = find.person(x.person_id);
    const status = h("select", { class: "status-sel", "aria-label": "Stand",
      onchange: (e) => patch("handovers", x.id, { status: e.target.value }).catch(() => {}) },
    Object.entries(STATUS).map(([k, label]) => h("option", { value: k, selected: x.status === k }, label)));
    const from = x.status === "cancelled" ? "" : b
      ? (b.only_friends ? `eigene Aussaat ${day(b.sow_date)}` : `aus der Aussaat ${day(b.sow_date)}`)
      : "keine Anzucht gefunden";
    return h("div", { class: `ntask handover${x.status === "done" ? " done" : ""}${x.status === "cancelled" ? " cancelled" : ""}` },
      h("strong", { class: "num count" }, x.count),
      h("button", { type: "button", class: "what", onclick: () => openHandover(x) },
        h("span", { class: "dot", style: { background: crop?.color } }),
        h("span", {}, `${crop?.name || "Kultur"} ${x.variety || "(Sorte offen)"}`)),
      h("span", { class: "who" }, person?.name || "?"),
      status,
      h("span", { class: "detail muted" }, from, x.notes ? ` · ${x.notes}` : ""));
  }

  function openHandover(x) {
    const isNew = !x;
    const v = { person_id: null, crop_id: null, variety: "", count: 1, pickup_date: "", status: "wish", notes: "", ...x };
    const personIn = h("input", { value: find.person(v.person_id)?.name || "", list: "people-list", autocomplete: "off", required: true,
      placeholder: "Name" });
    const peopleList = h("datalist", { id: "people-list" }, state.people.map((p) => h("option", { value: p.name })));
    const cropSel = h("select", { required: true },
      h("option", { value: "", selected: !v.crop_id }, "– Kultur wählen –"),
      [...state.crops].filter((c) => c.method === "transplant" || c.id === v.crop_id).sort((a, b) => a.name.localeCompare(b.name, "de"))
        .map((c) => h("option", { value: c.id, selected: c.id === v.crop_id }, c.name)));
    const varietyIn = h("input", { value: v.variety, list: "handover-varieties", autocomplete: "off", placeholder: "leer lassen, wenn egal" });
    const varList = h("datalist", { id: "handover-varieties" });
    const fillVarieties = () => {
      const cid = Number(cropSel.value);
      const names = new Set(state.varieties.filter((s) => s.crop_id === cid).map((s) => s.name));
      for (const p of state.plantings) {
        if (p.crop_id !== cid) continue;
        if (p.variety) names.add(p.variety);
        for (const m of p.varieties || []) names.add(m.name);
      }
      varList.replaceChildren(...[...names].sort((a, b) => a.localeCompare(b, "de")).map((n) => h("option", { value: n })));
    };
    cropSel.addEventListener("change", fillVarieties);
    fillVarieties();
    const count = h("input", { inputmode: "numeric", value: v.count, required: true });
    const pickup = h("input", { type: "date", value: v.pickup_date || isoOf(dayNum(`${year}-05-15`)), required: true });
    const pickupHint = h("span", { class: "hint" });
    const paintHint = () => { pickupHint.textContent = pickup.value ? `${kw(pickup.value)}, ${weekday(pickup.value)}` : ""; };
    pickup.addEventListener("input", paintHint);
    paintHint();
    const status = h("select", {}, Object.entries(STATUS).map(([k, label]) => h("option", { value: k, selected: v.status === k }, label)));
    const notes = h("input", { value: v.notes, maxlength: 1000, placeholder: "z. B. lieber kleine Pflanzen" });
    const ui = shell(isNew ? "Neuer Wunsch" : "Wunsch bearbeiten", {
      onSubmit: async () => {
        const name = personIn.value.trim();
        if (!name) throw new Error("Für wen? Bitte einen Namen eingeben");
        if (!cropSel.value) throw new Error("Bitte eine Kultur wählen");
        const n = Number(count.value);
        if (!Number.isInteger(n) || n < 1) throw new Error("Anzahl: bitte eine ganze Zahl ab 1");
        if (!pickup.value) throw new Error("Bitte den Abholtermin angeben");
        let person = state.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (!person) person = await create("people", { name });
        const data = { person_id: person.id, crop_id: Number(cropSel.value), variety: varietyIn.value.trim(), count: n,
          pickup_date: pickup.value, status: status.value, notes: notes.value.trim() };
        if (isNew) await create("handovers", data);
        else await patch("handovers", v.id, data, { silent: true });
      },
    });
    ui.body.append(
      h("div", { class: "grid-2" }, field("Für wen", personIn), field("Abholung", pickup), peopleList),
      pickupHint,
      h("div", { class: "grid-2" }, field("Kultur", cropSel), field("Sorte", varietyIn, "Leer: aus irgendeiner Anzucht der Kultur"), varList),
      h("div", { class: "grid-2" }, field("Anzahl Pflanzen", count), field("Stand", status)),
      field("Notiz", notes));
    ui.foot.append(
      isNew ? null : h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
        if (!(await confirmDialog("Der Wunsch wird gelöscht.", { title: "Wunsch löschen?" }))) return;
        ui.dlg.close();
        await remove("handovers", v.id);
      } }, "Löschen"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Eintragen" : "Speichern"));
    ui.open();
    (isNew ? personIn : count).focus();
  }

  function openPerson(p) {
    const name = h("input", { value: p.name, required: true, maxlength: 80 });
    const contact = h("input", { value: p.contact, maxlength: 200, placeholder: "Telefon oder E-Mail" });
    const notes = h("textarea", {}, p.notes || "");
    const mine = state.handovers.filter((x) => x.person_id === p.id).sort((a, b) => a.pickup_date.localeCompare(b.pickup_date));
    const ui = shell(p.name, {
      onSubmit: async () => {
        if (!name.value.trim()) throw new Error("Bitte einen Namen eingeben");
        await patch("people", p.id, { name: name.value.trim(), contact: contact.value.trim(), notes: notes.value }, { silent: true });
      },
    });
    ui.body.append(
      h("div", { class: "grid-2" }, field("Name", name), field("Kontakt", contact)),
      field("Notizen", notes),
      mine.length ? h("section", { class: "var-block" }, h("h3", {}, "Wünsche"), h("ul", { class: "calc" }, mine.map((x) =>
        h("li", {}, h("strong", {}, x.count), ` ${find.crop(x.crop_id)?.name || ""} ${x.variety || "(Sorte offen)"}`,
          h("span", { class: "muted" }, ` · ${day(x.pickup_date, { year: true })} · ${STATUS[x.status]}`))))) : null);
    ui.foot.append(
      h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
        const text = mine.length ? `${p.name} und ${plural(mine.length, "Wunsch", "Wünsche")} werden gelöscht.` : `${p.name} wird gelöscht.`;
        if (!(await confirmDialog(text, { title: "Person löschen?" }))) return;
        ui.dlg.close();
        await remove("people", p.id);
      } }, "Löschen"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
    ui.open();
  }

  // ------------------------------------------------------------ Plätze, Belegung, Gefäße

  function placesView() {
    return h("div", { class: "section" },
      placesSection(), occupancySection(), containersSection(), cropsSection());
  }

  function inlineNum(value, onSave, { step = "any", label, key }) {
    const input = h("input", { class: "input num", type: "number", min: 0, step, value, "aria-label": label, style: { width: "84px" },
      "data-focus-key": key });
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (input.value === "" || Number.isNaN(n) || n < 0) { input.value = value; return; }
      onSave(n);
    });
    return input;
  }

  function inlineText(value, onSave, label, key) {
    const input = h("input", { class: "input", value, "aria-label": label, maxlength: 60, "data-focus-key": key });
    input.addEventListener("change", () => {
      const t = input.value.trim();
      if (!t) { input.value = value; return; }
      onSave(t);
    });
    return input;
  }

  const quiet = (p) => p.catch(() => {});

  function placesSection() {
    const rows = state.places.map((p) => h("tr", { style: { cursor: "default" } },
      h("td", {}, inlineText(p.name, (name) => quiet(patch("places", p.id, { name })), "Name des Platzes", `pn${p.id}`)),
      h("td", {}, h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!p.warm,
        onchange: (e) => quiet(patch("places", p.id, { warm: e.target.checked })) }), "warm")),
      h("td", { class: "r" }, inlineNum(p.slots, (slots) => quiet(patch("places", p.id, { slots })), { label: "Plattenplätze", key: `ps${p.id}` })),
      h("td", { class: "r" }, iconBtn("trash", `${p.name} löschen`, async () => {
        if (!(await confirmDialog(`${p.name} wird gelöscht. Kulturen und Anzuchten verlieren diesen Platz.`, { title: "Platz löschen?" }))) return;
        await remove("places", p.id);
      }))));
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, "Anzuchtplätze"),
        h("span", { class: "muted small" }, "Ein Plattenplatz ist die Fläche einer Standardplatte, etwa 30 × 50 cm"),
        h("button", { type: "button", class: "btn", onclick: () => create("places", { name: state.places.length ? "Neuer Platz" : "Fensterbank", warm: !state.places.length, slots: 4 }) },
          icon("plus"), "Platz")),
      state.places.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "data" },
          h("thead", {}, h("tr", {}, h("th", {}, "Platz"), h("th", {}, "Wärme"), h("th", { class: "r" }, "Plattenplätze"), h("th", {}))),
          h("tbody", {}, rows)))
        : h("div", { class: "empty-note" }, "Lege an, wo deine Jungpflanzen stehen, z. B. „Fensterbank“ (warm, 4 Plattenplätze) oder „Gewächshaus“ (12). Dann warnt Beetwerk, wenn es zu voll wird."));
  }

  function occupancySection() {
    const occ = plan.occupancy;
    if (!occ.weeks.length) return null;
    const thisWeek = monday(isoOf(todayNum()));
    const table = h("table", { class: "data occ" },
      h("thead", {}, h("tr", {}, h("th", {}, "Platz"),
        occ.weeks.map((w) => h("th", { class: `r${dayNum(w.start) === thisWeek ? " now" : ""}`, title: `ab ${day(w.start)}` }, w.week)))),
      h("tbody", {}, occ.rows.map((r) => h("tr", { style: { cursor: "default" } },
        h("th", { scope: "row" }, r.name, r.slots != null ? h("span", { class: "muted" }, ` · ${num(r.slots)}`) : null),
        r.use.map((u, i) => {
          const over = r.over[i];
          const share = r.slots ? Math.min(u / r.slots, 1) : 0;
          return h("td", { class: `r${over ? " over" : ""}${u ? "" : " zero"}`,
            title: u ? `${num(u, 2)} Plattenplätze${r.slots != null ? ` von ${num(r.slots)}` : ""}` : null,
            style: r.slots && u && !over
              ? { background: `linear-gradient(to top, var(--leaf-soft) ${Math.round(share * 100)}%, transparent ${Math.round(share * 100)}%)` } : null },
          u ? `${over ? "! " : ""}${num(u)}` : "·");
        })))));
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, `Belegung ${year}`),
        h("span", { class: "muted small" }, "Plattenplätze je Kalenderwoche, bis die Pflanzen zum Abhärten rausgehen. „!“ heißt zu voll.")),
      h("div", { class: "table-wrap" }, table));
  }

  function containersSection() {
    const rows = state.containers.map((c) => h("tr", { style: { cursor: "default" } },
      h("td", {}, inlineText(c.name, (name) => quiet(patch("containers", c.id, { name })), "Name des Gefäßes", `cn${c.id}`)),
      h("td", {}, h("select", { class: "input", "aria-label": "Art", onchange: (e) => quiet(patch("containers", c.id, { kind: e.target.value })) },
        Object.entries(KIND).map(([k, label]) => h("option", { value: k, selected: c.kind === k }, label)))),
      h("td", { class: "r" }, c.kind === "pot" ? h("span", { class: "muted" }, "1")
        : inlineNum(c.cells, (cells) => quiet(patch("containers", c.id, { cells: Math.max(1, Math.round(cells)) })),
          { step: 1, label: c.kind === "tray" ? "Körner je Schale" : "Zellen je Platte", key: `cc${c.id}` })),
      h("td", { class: "r" }, inlineNum(c.per_slot, (per_slot) => quiet(patch("containers", c.id, { per_slot })), { label: "Je Plattenplatz", key: `cs${c.id}` })),
      h("td", { class: "r" }, iconBtn("trash", `${c.name} löschen`, async () => {
        if (!(await confirmDialog(`${c.name} wird gelöscht.`, { title: "Gefäß löschen?" }))) return;
        await remove("containers", c.id);
      }))));
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, "Gefäße"),
        h("span", { class: "muted small" }, "Zellen je Platte bzw. Körner je Saatschale; wie viele davon auf einen Plattenplatz passen"),
        h("button", { type: "button", class: "btn", onclick: () => create("containers", { name: "Multitopfplatte 40", kind: "cells", cells: 40, per_slot: 1 }) },
          icon("plus"), "Gefäß")),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Gefäß"), h("th", {}, "Art"), h("th", { class: "r" }, "Zellen / Körner"),
          h("th", { class: "r" }, "Je Plattenplatz"), h("th", {}))),
        h("tbody", {}, rows))));
  }

  function cropsSection() {
    const used = new Set(plan.batches.map((b) => b.crop_id));
    const crops = state.crops.filter((c) => c.method === "transplant" || used.has(c.id))
      .sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)) || a.name.localeCompare(b.name, "de"));
    const rows = crops.map((c) => h("tr", { tabindex: "0", onclick: () => openCropOverview(c), onkeydown: (e) => { if (e.key === "Enter") openCropOverview(c); } },
      h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: c.color } }), c.name,
        used.has(c.id) ? h("span", { class: "v" }, year) : null)),
      h("td", {}, find.container(c.sow_container_id)?.name || h("span", { class: "muted" }, "fehlt")),
      h("td", {}, c.pot_container_id ? `${find.container(c.pot_container_id)?.name}, nach ${c.prick_days} Tagen` : h("span", { class: "muted" }, "–")),
      h("td", { class: "r" }, c.seeds_per_cell),
      h("td", { class: "r" }, `${c.germination} %`),
      h("td", { class: "r" }, `${c.reserve} %`),
      h("td", {}, [c.warm ? "warm" : "", find.place(c.place_id)?.name].filter(Boolean).join(" · ") || h("span", { class: "muted" }, "–"))));
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", {}, "Kulturen in der Anzucht"),
        h("span", { class: "muted small" }, "Antippen zum Ändern")),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Kultur"), h("th", {}, "Aussaat in"), h("th", {}, "Pikieren in"),
          h("th", { class: "r" }, "Körner je Zelle"), h("th", { class: "r" }, "Keimrate"), h("th", { class: "r" }, "Reserve"), h("th", {}, "Platz"))),
        h("tbody", {}, rows))));
  }

  render();
  load();
  return {
    update() { render(); },
    destroy() { unsub(); clearTimeout(timer); },
  };
}
