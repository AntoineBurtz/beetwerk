// Sortenliste: Saatgut mit Einordnung, Foto und Quellen, dazu die Recherche mit Claude.
import { state, find, create, patch, remove, api } from "./store.js";
import { h, plural, isMixed } from "./util.js";
import { toast, confirmDialog, icon } from "./ui.js";
import { shell, field } from "./editor.js";
import { shrinkPhoto } from "./bwidgets.js";
import { profileForm, cardTraits, SOURCE_LABEL } from "./profileform.js";

let query = "";
let cropFilter = "";

const FIELDS = [
  ["species", "Botanische Art", "z. B. Solanum lycopersicum"],
  ["kind", "Typ", "z. B. Fleischtomate"],
  ["seed", "Saatgut", "samenfest oder F1-Hybride"],
  ["supplier", "Bezugsquelle", "Händler oder Herkunft"],
  ["bought", "Gekauft", "z. B. 2026"],
];

// Inhalt ersetzen und dabei leere Einträge auslassen (sonst stünde dort „null“)
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

let researchState = null;
async function researchStatus() {
  if (researchState) return researchState;
  try { researchState = await api.get("/api/research"); } catch { researchState = { configured: false }; }
  return researchState;
}
export function forgetResearchStatus() { researchState = null; }

// Merkmale je Sorte für die Karten (Bonitur, Internet, eigene Angabe)
let summaries = null;
let summariesLoading = false;
export function forgetProfiles() { summaries = null; }
function loadSummaries(rerender) {
  if (summaries || summariesLoading) return;
  summariesLoading = true;
  api.get("/api/varieties/profiles")
    .then((res) => { summaries = res; rerender(); })
    .catch(() => { summaries = {}; })
    .finally(() => { summariesLoading = false; });
}

function hasProfile(v) {
  return Object.keys(v.profile || {}).length > 0;
}

// ---------------------------------------------------------------- Mehrere Sorten recherchieren

let batch = null; // Stand von /api/research/batch
let batchSeen = false;
let batchNote = null; // Ergebnis des letzten Laufs, bis es weggeklickt wird
let batchTimer = null;
let lastRerender = null;

async function pollBatch() {
  clearTimeout(batchTimer);
  const wasRunning = batch?.running;
  try { batch = await api.get("/api/research/batch"); } catch { batch = null; return; }
  if (batch.running) batchTimer = setTimeout(pollBatch, 2500);
  else if (wasRunning) {
    try {
      state.varieties = await api.get("/api/varieties");
    } catch { /* bleibt beim alten Stand */ }
    forgetProfiles();
    batchNote = batch;
    const ok = batch.done - batch.skipped.length - batch.failed.length;
    toast(batch.stopped ? "Recherche abgebrochen" : `${plural(Math.max(ok, 0), "Sorte", "Sorten")} ergänzt`, { error: !!batch.stopped });
  }
  lastRerender?.();
}

async function startBatch(ids) {
  const st = await researchStatus();
  if (!st.configured) {
    const ok = await confirmDialog("Für die Recherche braucht Beetwerk einen API-Schlüssel von Claude. Den trägst du in den Einstellungen unter „KI-Recherche“ ein.",
      { ok: "Zu den Einstellungen", danger: false, title: "API-Schlüssel fehlt" });
    if (ok) document.getElementById("settings-btn")?.click();
    return;
  }
  const ok = await confirmDialog(
    `Claude sucht für ${plural(ids.length, "Sorte", "Sorten")} ohne Merkmale nacheinander im Netz und füllt leere Angaben: `
    + "Merkmale, Art, Typ, Saatgut, Beschreibung und Quellen. Was schon eingetragen ist, bleibt. "
    + "Sorten, die Claude nicht sicher findet, bleiben leer. Bilder wählst du danach bei jeder Sorte selbst. "
    + "Das dauert bis zu einer Minute je Sorte und kostet je Sorte einige Cent API-Guthaben.",
    { ok: "Recherchieren", danger: false, title: "Merkmale recherchieren?" });
  if (!ok) return;
  try {
    batch = await api.post("/api/research/batch", { ids });
    batchNote = null;
    lastRerender?.();
    batchTimer = setTimeout(pollBatch, 2000);
  } catch (e) { toast(e.message, { error: true }); }
}

function batchBox() {
  if (batch?.running) {
    return h("div", { class: "research-batch", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }),
      h("span", {}, `Claude recherchiert Merkmale${batch.current ? `: ${batch.current}` : " …"} `,
        h("span", { class: "muted" }, `(${Math.min(batch.done + 1, batch.total)} von ${batch.total})`)));
  }
  if (!batchNote) return null;
  const b = batchNote;
  const u = b.usage || {};
  const ok = Math.max(b.done - b.skipped.length - b.failed.length, 0);
  return h("div", { class: `research-batch done${b.stopped ? " bad" : ""}`, role: "status" },
    h("div", {},
      h("strong", {}, b.stopped ? "Recherche abgebrochen. " : "Recherche fertig. "),
      `${plural(ok, "Sorte", "Sorten")} ergänzt, ${plural(b.filled, "Angabe", "Angaben")} eingetragen. `,
      b.skipped.length ? `Nicht sicher gefunden: ${b.skipped.slice(0, 6).join(", ")}${b.skipped.length > 6 ? ` und ${b.skipped.length - 6} weitere` : ""}`
        + " – öffne sie und nutze „Mit Claude ergänzen“ mit einem Hinweis, z. B. dem Händler. " : "",
      b.stopped ? b.stopped + " " : b.failed.length ? `Fehler bei ${b.failed.map((f) => f.name).join(", ")}: ${b.failed[0].error} ` : "",
      h("span", { class: "muted small" }, `${plural(u.web_search_requests || 0, "Suche", "Suchen")} · ${fmtTokens((u.input_tokens || 0) + (u.output_tokens || 0))} Tokens`)),
    h("button", { type: "button", class: "icon-btn", "aria-label": "Hinweis schließen", onclick: () => { batchNote = null; lastRerender?.(); } }, icon("close")));
}

// Wie oft eine Sorte in Sätzen vorkommt (gleiche Kultur, gleicher Name)
function usage() {
  const out = new Map();
  for (const p of state.plantings) {
    const names = isMixed(p) ? p.varieties.map((v) => v.name) : p.variety ? [p.variety] : [];
    for (const n of new Set(names.map((x) => x.trim().toLowerCase()))) {
      const k = `${p.crop_id}|${n}`;
      out.set(k, (out.get(k) || 0) + 1);
    }
  }
  return out;
}

function missingFromPlantings() {
  const have = new Set(state.varieties.map((v) => `${v.crop_id}|${v.name.trim().toLowerCase()}`));
  return [...usage().keys()].filter((k) => !have.has(k) && !k.endsWith("|")).length;
}

function thumb(v, crop) {
  if (v.photo) return h("img", { src: `/api/photos/${v.photo}?thumb=1`, alt: "", loading: "lazy" });
  return h("span", { class: "var-ph", style: `--c:${crop?.color || "#6a9b3c"}` }, (v.name || "?").slice(0, 1).toUpperCase());
}

// ---------------------------------------------------------------- Liste

export function varietiesView(rerender) {
  lastRerender = rerender;
  loadSummaries(rerender);
  if (!batchSeen) { batchSeen = true; pollBatch(); }
  const uses = usage();
  const q = query.trim().toLowerCase();
  const traitText = (v) => (summaries?.[v.id] || []).map((x) => x.text);
  const list = state.varieties
    .filter((v) => !cropFilter || String(v.crop_id) === cropFilter)
    .filter((v) => !q || [v.name, v.kind, v.species, v.supplier, find.crop(v.crop_id)?.name, ...traitText(v)]
      .some((x) => (x || "").toLowerCase().includes(q)));
  const bare = state.varieties.filter((v) => !hasProfile(v)).map((v) => v.id);
  const crops = [...new Set(state.varieties.map((v) => v.crop_id))].map((id) => find.crop(id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const open = missingFromPlantings();

  const search = h("input", { class: "input", type: "search", placeholder: "Sorte, Typ oder Händler", value: query,
    "aria-label": "Sorten durchsuchen", style: { maxWidth: "240px" }, "data-focus-key": "var-search",
    oninput: (e) => { query = e.target.value; rerender(); } });
  const cropSel = h("select", { class: "input", style: { maxWidth: "200px" }, "aria-label": "Nach Kultur filtern",
    onchange: (e) => { cropFilter = e.target.value; rerender(); } },
  h("option", { value: "" }, "Alle Kulturen"),
  crops.map((c) => h("option", { value: c.id, selected: String(c.id) === cropFilter }, c.name)));

  const cards = list.map((v) => {
    const crop = find.crop(v.crop_id);
    const n = uses.get(`${v.crop_id}|${v.name.trim().toLowerCase()}`) || 0;
    const sum = summaries?.[v.id] || [];
    const bonYear = Math.max(0, ...sum.filter((x) => x.source === "bonitur").map((x) => x.year || 0));
    const traits = cardTraits(sum);
    return h("button", { type: "button", class: "var-card", onclick: () => openVarietyEditor(v, rerender) },
      h("span", { class: "var-thumb" }, thumb(v, crop)),
      h("span", { class: "var-body" },
        h("span", { class: "var-name" }, v.name),
        h("span", { class: "var-meta" }, h("span", { class: "dot", style: { background: crop?.color } }), crop?.name || "ohne Kultur",
          n ? ` · ${plural(n, "Satz", "Sätze")}` : ""),
        h("span", { class: "var-tags" }, [v.kind, v.seed].filter(Boolean).map((t) => h("span", { class: "fam" }, t)),
          bonYear ? h("span", { class: "src src-bonitur", title: "Merkmale aus deiner Bonitur" }, `Bonitur ${bonYear}`) : null),
        traits.length ? h("span", { class: "var-traits" }, traits.map((t) => t.text).join(" · ")) : null));
  });

  return h("div", { class: "section" },
    h("div", { class: "toolbar-row" },
      search, cropSel, h("span", { class: "spacer" }),
      open ? h("button", { type: "button", class: "btn", title: "Sorten aus deinen Sätzen in die Liste übernehmen", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const res = await api.post("/api/varieties/collect");
          state.varieties.push(...res.created);
          state.varieties.sort((a, b) => a.name.localeCompare(b.name, "de"));
          toast(`${plural(res.created.length, "Sorte", "Sorten")} aus den Sätzen übernommen`);
          rerender();
        } catch (err) { toast(err.message, { error: true }); }
      } }, `Aus Sätzen übernehmen (${open})`) : null,
      bare.length && !batch?.running ? h("button", { type: "button", class: "btn",
        title: "Merkmale, Art, Typ und Beschreibung für Sorten ohne Merkmale aus dem Internet holen",
        onclick: () => startBatch(bare) }, `Merkmale recherchieren (${bare.length})`) : null,
      h("button", { type: "button", class: "btn", onclick: () => openVarietyEditor(null, rerender) }, icon("plus"), "Neue Sorte"),
      h("button", { type: "button", class: "btn btn-primary", onclick: () => openResearch({ after: rerender }) }, "Neue Samen recherchieren")),
    batchBox(),
    list.length ? h("div", { class: "var-grid" }, cards)
      : h("div", { class: "empty-note" }, state.varieties.length ? "Keine Sorte passt zum Filter."
        : "Noch keine Sorten. Lege eine an, recherchiere neue Samen mit Claude oder übernimm die Sorten aus deinen Sätzen."));
}

// ---------------------------------------------------------------- Bearbeiten

function cropSelect(value, { allowNone = true, extra } = {}) {
  const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"));
  return h("select", {},
    allowNone ? h("option", { value: "" }, "keine Kultur") : null,
    extra || null,
    crops.map((c) => h("option", { value: c.id, selected: c.id === value }, c.name)));
}

async function uploadFile(file) {
  const blob = await shrinkPhoto(file);
  const res = await fetch("/api/photos", { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Foto konnte nicht hochgeladen werden");
  return (await res.json()).name;
}

function linksEditor(initial) {
  let links = [...(initial || [])];
  const box = h("div", { class: "var-links" });
  const url = h("input", { class: "input", placeholder: "https://…", inputmode: "url" });
  const paint = () => fill(box, 
    ...links.map((l, i) => h("div", { class: "var-link" },
      h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.title || l.url),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Quelle entfernen", onclick: () => { links.splice(i, 1); paint(); } }, icon("close")))),
    h("div", { class: "var-link-add" }, url, h("button", { type: "button", class: "btn btn-sm", onclick: () => {
      const u = url.value.trim();
      if (!/^https?:\/\//i.test(u)) { toast("Bitte eine Adresse mit http:// oder https:// eingeben", { error: true }); return; }
      links.push({ url: u, title: "" });
      url.value = "";
      paint();
    } }, "Dazu")));
  paint();
  return { el: box, get: () => links };
}

export function openVarietyEditor(variety, after, prefill = null) {
  const isNew = !variety?.id;
  const v = { name: "", crop_id: null, photo: "", photo_credit: "", description: "", notes: "", links: [], profile: {}, ...variety, ...prefill };
  const name = h("input", { value: v.name, maxlength: 120, required: true });
  const crop = cropSelect(v.crop_id);
  const inputs = Object.fromEntries(FIELDS.map(([k, , ph]) => [k, h("input", { value: v[k] || "", placeholder: ph, maxlength: 200,
    list: k === "seed" ? "seed-list" : null })]));
  const seedList = h("datalist", { id: "seed-list" }, ["samenfest", "F1-Hybride"].map((x) => h("option", { value: x })));
  const description = h("textarea", { rows: 3 }, v.description || "");
  const notes = h("textarea", { rows: 2 }, v.notes || "");
  const credit = h("input", { value: v.photo_credit || "", placeholder: "z. B. eigenes Foto, Wikimedia Commons, CC BY-SA 4.0" });
  const links = linksEditor(v.links);
  let photo = v.photo || "";
  const photoBox = h("div", { class: "var-photo" });
  const fileIn = h("input", { type: "file", accept: "image/*", class: "sr-only" });
  const paintPhoto = () => fill(photoBox, 
    photo ? h("img", { src: `/api/photos/${photo}?thumb=1`, alt: "Foto der Sorte" }) : h("span", { class: "muted small" }, "Noch kein Foto"),
    h("div", { class: "actions-row" },
      h("button", { type: "button", class: "btn btn-sm", onclick: () => fileIn.click() }, photo ? "Anderes Foto" : "Foto wählen"),
      photo ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { photo = ""; credit.value = ""; paintPhoto(); } }, "Entfernen") : null));
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try { photo = await uploadFile(f); if (!credit.value) credit.value = "eigenes Foto"; paintPhoto(); } catch (e) { ui.showError(e.message); }
  });
  paintPhoto();

  // Merkmale: Bonitur vor Internet und eigener Angabe; für eine andere Kultur gelten andere Merkmale
  const prof = profileForm({ values: v.profile });
  const profNote = h("p", { class: "muted small", style: { margin: 0 } });
  const paintProfNote = () => {
    profNote.textContent = prof.count()
      ? "Werte aus deiner Bonitur gehen vor. Bis es sie gibt, gelten Angaben aus dem Internet oder deine eigenen."
      : "Noch keine Merkmale. „Mit Claude ergänzen“ holt sie aus dem Internet; nach der Saison stehen hier die Werte deiner Bonitur.";
  };
  let profSeq = 0;
  const loadProfile = async () => {
    const cropId = crop.value ? Number(crop.value) : null;
    const seq = ++profSeq;
    try {
      const res = v.id && cropId === v.crop_id ? await api.get(`/api/varieties/${v.id}/profile`)
        : await api.get(`/api/profile-traits${cropId ? `?crop_id=${cropId}` : ""}`);
      if (seq === profSeq) { prof.setRows(res.rows); paintProfNote(); }
    } catch (e) {
      prof.el.replaceChildren(h("p", { class: "form-error", style: { margin: 0 } }, `Merkmale konnten nicht geladen werden: ${e.message}`));
    }
  };
  crop.addEventListener("change", loadProfile);
  loadProfile();

  const collect = () => ({
    name: name.value.trim(), crop_id: crop.value ? Number(crop.value) : null,
    ...Object.fromEntries(FIELDS.map(([k]) => [k, inputs[k].value.trim()])),
    description: description.value, notes: notes.value, photo, photo_credit: credit.value.trim(), links: links.get(),
    profile: prof.get(),
  });

  const ui = shell(isNew ? "Neue Sorte" : v.name, {
    onSubmit: async () => {
      const data = collect();
      if (!data.name) throw new Error("Bitte einen Sortennamen eingeben");
      if (isNew) await create("varieties", data);
      else await patch("varieties", v.id, data, { silent: true });
      forgetProfiles();
      after?.();
    },
  });
  ui.body.append(
    h("div", { class: "grid-2" }, field("Sorte", name), field("Kultur", crop)),
    h("div", { class: "grid-2" }, FIELDS.map(([k, label]) => field(label, inputs[k]))), seedList,
    field("Beschreibung", description),
    h("section", { class: "prof-section", "aria-label": "Merkmale" },
      h("div", { class: "prof-head" }, h("h3", {}, "Merkmale"),
        h("span", { class: "prof-legend" }, ["bonitur", "internet", "manual"].map((k) => h("span", { class: `src src-${k}` }, SOURCE_LABEL[k])))),
      profNote, prof.el),
    h("div", { class: "field" }, h("span", {}, "Foto"), photoBox, fileIn),
    field("Bildquelle", credit, "Woher das Bild stammt und unter welcher Lizenz"),
    h("div", { class: "field" }, h("span", {}, "Quellen"), links.el),
    field("Notizen", notes));
  ui.foot.append(
    isNew ? null : h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      if (!(await confirmDialog(`„${v.name}“ wird aus der Sortenliste gelöscht. Sätze mit dieser Sorte bleiben.`, { title: "Sorte löschen?" }))) return;
      ui.dlg.close();
      try { await remove("varieties", v.id); after?.(); toast(`${v.name} gelöscht`); } catch { /* Meldung kam schon */ }
    } }, "Löschen"),
    h("button", { type: "button", class: "btn", onclick: () => {
      let data;
      try { data = collect(); } catch (e) { ui.showError(e.message); return; }
      if (!data.profile) delete data.profile;
      if (!data.name) { ui.showError("Für die Recherche zuerst den Sortennamen eintragen"); return; }
      ui.dlg.close();
      openResearch({ base: { ...v, ...data }, after });
    } }, "Mit Claude ergänzen"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Anlegen" : "Speichern"));
  ui.open();
  if (isNew) name.focus();
}

// ---------------------------------------------------------------- Recherche mit Claude

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Das Foto konnte nicht gelesen werden"));
    r.readAsDataURL(blob);
  });
}

function fmtTokens(n) {
  return Number(n || 0).toLocaleString("de-DE");
}

export async function openResearch({ base = null, after } = {}) {
  const st = await researchStatus();
  if (!st.configured) {
    const ok = await confirmDialog("Für die Recherche braucht Beetwerk einen API-Schlüssel von Claude. Den trägst du in den Einstellungen unter „KI-Recherche“ ein.",
      { ok: "Zu den Einstellungen", danger: false, title: "API-Schlüssel fehlt" });
    if (ok) document.getElementById("settings-btn")?.click();
    return;
  }
  let packet = null; // data:-URL des Tütchenfotos
  const name = h("input", { value: base?.name || "", placeholder: "z. B. Ochsenherz", maxlength: 120 });
  const crop = cropSelect(base?.crop_id ?? null, { allowNone: false, extra: h("option", { value: "", selected: !base?.crop_id }, "automatisch erkennen") });
  const hint = h("input", { placeholder: "z. B. gekauft bei Dreschflegel, gelbe Früchte", maxlength: 300 });
  const packetBox = h("div", { class: "var-photo" });
  const packetIn = h("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only" });
  const paintPacket = () => fill(packetBox, 
    packet ? h("img", { src: packet, alt: "Samentütchen" }) : null,
    h("div", { class: "actions-row" },
      h("button", { type: "button", class: "btn btn-sm", onclick: () => packetIn.click() }, packet ? "Anderes Foto" : "Tütchen fotografieren"),
      packet ? h("button", { type: "button", class: "btn btn-sm btn-quiet", onclick: () => { packet = null; paintPacket(); } }, "Entfernen") : null));
  packetIn.addEventListener("change", async () => {
    const f = packetIn.files?.[0];
    if (!f) return;
    packet = await readDataUrl(await shrinkPhoto(f, 1400));
    paintPacket();
  });
  paintPacket();

  const stage = h("div", { class: "research-stage" });
  const go = h("button", { type: "submit", class: "btn btn-primary" }, "Recherchieren");
  const back = h("button", { type: "button", class: "btn btn-quiet", onclick: () => (mode === "result" ? paintAsk() : ui.dlg.close()) }, "Abbrechen");
  let result = null;
  let mode = "ask";

  const ui = shell(base?.id ? `${base.name} ergänzen` : "Neue Samen recherchieren", {
    onSubmit: async () => {
      if (mode === "ask") { await run(); return false; }
      await save();
      return true;
    },
  });

  function paintAsk() {
    mode = "ask";
    back.textContent = "Abbrechen";
    go.textContent = "Recherchieren";
    go.disabled = false;
    fill(stage, 
      h("p", { class: "muted small", style: { margin: 0 } },
        "Claude sucht im Netz nach der Sorte und schlägt eine Einordnung vor. Du prüfst alles, bevor es gespeichert wird. "
        + "Mit einem Foto vom Samentütchen liest Claude Name, Händler und Angaben direkt ab."),
      h("div", { class: "grid-2 stack-sm" }, field("Sortenname", name, "kann leer bleiben, wenn ein Foto dabei ist"), field("Kultur", crop)),
      h("div", { class: "field" }, h("span", {}, "Foto vom Samentütchen (optional)"), packetBox, packetIn),
      field("Hinweis (optional)", hint));
  }

  async function run() {
    if (!name.value.trim() && !packet) throw new Error("Bitte einen Sortennamen eingeben oder das Tütchen fotografieren");
    mode = "busy";
    go.disabled = true;
    go.textContent = "Claude sucht …";
    fill(stage, h("div", { class: "research-busy" }, h("span", { class: "spinner", "aria-hidden": "true" }),
      h("span", {}, "Claude sucht im Netz und fragt bei fehlenden Merkmalen gezielt nach. Das dauert meist 30 Sekunden bis 2 Minuten.")));
    // Was die Sorte schon hat, muss Claude nicht suchen
    const known = [...Object.keys(base?.profile || {}), ...["species", "kind", "seed", "description"].filter((k) => base?.[k])];
    try {
      result = await api.post("/api/research/variety", {
        name: name.value.trim(), crop_id: crop.value ? Number(crop.value) : null, hint: hint.value.trim(), image: packet, known,
      });
    } catch (e) {
      paintAsk();
      throw e;
    }
    paintResult();
  }

  // Ergebnisfelder (vorhandene Werte bleiben, leere werden aus der Recherche gefüllt)
  let form = null;
  function paintResult() {
    mode = "result";
    back.textContent = "Zurück";
    go.disabled = false;
    go.textContent = base?.id ? "Übernehmen" : "Als Sorte speichern";
    const pick = (k) => (base?.[k] ? base[k] : result[k] || "");
    const filled = (k) => !base?.[k] && result[k];
    const nameIn = h("input", { value: pick("name") || name.value, maxlength: 120 });
    const unknownCrop = !result.crop_id && result.crop ? result.crop : "";
    const cropIn = cropSelect(base?.crop_id ?? result.crop_id ?? null, {
      extra: unknownCrop ? h("option", { value: "new", selected: !base?.crop_id }, `Neue Kultur „${unknownCrop}“ anlegen`) : null });
    const inputs = Object.fromEntries(FIELDS.map(([k]) => [k, h("input", { value: pick(k), class: filled(k) ? "filled" : null })]));
    const desc = h("textarea", { rows: 3, class: filled("description") ? "filled" : null }, pick("description"));
    const imgs = [...(base?.photo ? [{ keep: true, thumb: `/api/photos/${base.photo}?thumb=1`, credit: base.photo_credit || "vorhandenes Foto" }] : []),
      ...result.images];
    let chosen = base?.photo ? 0 : (imgs.length ? 0 : -1);
    const imgGrid = h("div", { class: "img-pick" });
    const paintImgs = () => fill(imgGrid, 
      ...imgs.map((im, i) => {
        const b = h("button", { type: "button", class: "img-opt", "aria-pressed": chosen === i ? "true" : "false",
          onclick: () => { chosen = i; paintImgs(); } },
        h("img", { src: im.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
          onerror: (e) => { e.target.closest(".img-opt").hidden = true; } }),
        h("span", { class: "credit" }, im.keep ? "behalten" : im.free ? "frei lizenziert" : "Shopfoto"),
        h("span", { class: "credit small" }, im.credit));
        return b;
      }),
      h("button", { type: "button", class: "img-opt none", "aria-pressed": chosen === -1 ? "true" : "false",
        onclick: () => { chosen = -1; paintImgs(); } }, h("span", {}, "kein Bild")));
    paintImgs();
    const keep = new Set(result.sources.map((_, i) => i));
    const srcList = h("div", { class: "var-links" }, result.sources.map((s, i) => h("label", { class: "check" },
      h("input", { type: "checkbox", checked: true, onchange: (e) => { if (e.target.checked) keep.add(i); else keep.delete(i); } }),
      h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title || s.url))));
    const u = result.usage || {};
    const conf = result.confidence ? h("span", { class: `conf conf-${result.confidence}` }, `Treffer: ${result.confidence}`) : null;
    // Merkmale: vorhandene Angaben bleiben, neue aus der Recherche sind grün hinterlegt
    const meta = result.trait_meta || [];
    const had = base?.profile || {};
    const values = Object.fromEntries(meta.map((m) => [m.key, had[m.key] || { value: result.traits[m.key], source: "internet" }]));
    const prof = meta.length ? profileForm({ rows: meta.map((m) => ({ ...m, bonitur: null })), values, compact: true,
      highlight: new Set(meta.map((m) => m.key).filter((k) => !had[k])) }) : null;
    form = { nameIn, cropIn, inputs, desc, imgs, get chosen() { return chosen; }, keep, unknownCrop, prof, meta };
    fill(stage, 
      h("div", { class: "research-meta" }, conf,
        h("span", { class: "muted small" }, `${plural(u.web_search_requests || 0, "Suche", "Suchen")} · ${fmtTokens((u.input_tokens || 0) + (u.output_tokens || 0))} Tokens${result.rounds > 1 ? " · mit Nachfrage" : ""} · ${result.model}`)),
      base?.id ? h("p", { class: "muted small", style: { margin: 0 } }, "Grün hinterlegt ist, was Claude ergänzt hat; vorhandene Angaben bleiben.") : null,
      h("div", { class: "grid-2" }, field("Sorte", nameIn), field("Kultur", cropIn)),
      h("div", { class: "grid-2" }, FIELDS.map(([k, label]) => field(label, inputs[k]))),
      field("Beschreibung", desc),
      h("div", { class: "field" }, h("span", {}, "Merkmale"),
        prof ? prof.el : h("span", { class: "muted small" }, "Claude hat keine belegten Merkmale gefunden."),
        prof ? h("span", { class: "hint" }, "Klasse und Zahl stehen getrennt. Werte aus deiner Bonitur gehen später vor.") : null),
      h("div", { class: "field" }, h("span", {}, "Bild"), imgGrid,
        h("span", { class: "hint" }, "Shopfotos sind urheberrechtlich geschützt: gut für die eigene Sortenliste, nicht zum Veröffentlichen.")),
      result.sources.length ? h("div", { class: "field" }, h("span", {}, "Quellen"), srcList) : null);
  }

  async function save() {
    const f = form;
    let cropId = f.cropIn.value === "new" ? null : f.cropIn.value ? Number(f.cropIn.value) : null;
    if (f.cropIn.value === "new") {
      const c = await create("crops", { name: f.unknownCrop });
      cropId = c.id;
    }
    const data = {
      name: f.nameIn.value.trim(), crop_id: cropId, description: f.desc.value,
      ...Object.fromEntries(FIELDS.map(([k]) => [k, f.inputs[k].value.trim()])),
    };
    if (!data.name) throw new Error("Bitte einen Sortennamen eingeben");
    const same = base?.id ? find.variety(base.id)
      : state.varieties.find((v) => v.crop_id === cropId && v.name.trim().toLowerCase() === data.name.toLowerCase());
    const found = f.prof ? f.prof.get() : {};
    const merged = { ...(base?.profile || same?.profile || {}) };
    for (const m of f.meta) delete merged[m.key];
    data.profile = { ...merged, ...found };
    const im = f.chosen >= 0 ? f.imgs[f.chosen] : null;
    if (im && !im.keep) {
      go.disabled = true;
      go.textContent = "Lade Bild …";
      try {
        const res = await api.post("/api/photos/from-url", { url: im.url });
        data.photo = res.name;
        data.photo_credit = [im.credit, im.page].filter(Boolean).join(" · ");
      } catch (e) {
        go.disabled = false;
        go.textContent = base?.id ? "Übernehmen" : "Als Sorte speichern";
        throw new Error(`${e.message}. Wähle ein anderes Bild oder „kein Bild“.`);
      }
    } else if (!im) {
      data.photo = "";
      data.photo_credit = "";
    }
    const old = new Set((base?.links || []).map((l) => l.url));
    data.links = [...(base?.links || []), ...result.sources.filter((s, i) => f.keep.has(i) && !old.has(s.url))].slice(0, 20);
    if (same) {
      await patch("varieties", same.id, data, { silent: true });
      toast(`${data.name} aktualisiert`);
    } else {
      await create("varieties", data);
      toast(`${data.name} in die Sortenliste übernommen`);
    }
    forgetProfiles();
    after?.();
  }

  paintAsk();
  ui.body.append(stage);
  ui.foot.append(h("span", { class: "spacer" }), back, go);
  ui.open();
}
