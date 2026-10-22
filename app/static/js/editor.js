// Dialoge zum Bearbeiten von Sätzen, Beeten, Kulturen und Einstellungen.
import { state, find, create, patch, remove, issuesOf, api, replaceAll, select, emit } from "./store.js";
import {
  h, dayNum, isoOf, datesFromCrop, rowCount, plantCount, spanOf, fmtNum, KIND_LABEL, PLANTABLE,
  phases, rectOf, round2, clamp, plural,
} from "./util.js";
import { toast, confirmDialog, icon } from "./ui.js";
import { openGeoSetup } from "./geosetup.js";

function shell(title, { onSubmit, extraHead } = {}) {
  const dlg = h("dialog");
  const body = h("div", { class: "dlg-body" });
  const foot = h("div", { class: "dlg-foot" });
  const errorBox = h("div", { class: "form-error", hidden: true, role: "alert" });
  const form = h("form", { novalidate: true },
    h("div", { class: "dlg-head" }, h("h2", {}, title), extraHead),
    body, foot);
  body.append(errorBox);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    try {
      const ok = await onSubmit?.();
      if (ok !== false) dlg.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: "nearest" });
    }
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: "nearest" });
  };
  return { dlg, form, body, foot, showError, open: () => dlg.showModal() };
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null);
}

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function cancelBtn(dlg) {
  return h("button", { type: "button", class: "btn btn-quiet", onclick: () => dlg.close() }, "Abbrechen");
}

// ---------------------------------------------------------------- Freier Platz im Beet

export function firstFreeStart(bed, len, { offset = 0, span = null, from, to, excludeId } = {}) {
  const h0 = span ?? bed.width - offset;
  const others = state.plantings.filter((q) => {
    if (q.bed_id !== bed.id || q.id === excludeId) return false;
    const ph = phases(q);
    return ph.fieldStart <= to && from <= ph.he;
  }).map((q) => rectOf(q, bed));
  const step = 0.1;
  for (let x = 0; x <= bed.length - len + 0.0001; x += step) {
    const r = { x, y: offset, w: len, h: h0 };
    const hit = others.some((o) => r.x < o.x + o.w - 0.001 && o.x < r.x + r.w - 0.001 && r.y < o.y + o.h - 0.001 && o.y < r.y + r.h - 0.001);
    if (!hit) return round2(x);
  }
  return null;
}

// Folgesatz: gleiche Kultur, Termine um `days` verschoben, möglichst im gleichen Beet.
export async function createSuccession(p, days = 14) {
  const shift = (iso) => (iso ? isoOf(dayNum(iso) + days) : null);
  const copy = {
    crop_id: p.crop_id, variety: p.variety, method: p.method, bed_id: p.bed_id,
    sow_date: shift(p.sow_date), plant_date: shift(p.plant_date),
    harvest_start: shift(p.harvest_start), harvest_end: shift(p.harvest_end),
    start: p.start, len: p.len, offset: p.offset, span: p.span, rows: p.rows,
    row_spacing: p.row_spacing, plant_spacing: p.plant_spacing, notes: "",
  };
  const bed = find.bed(p.bed_id);
  if (bed) {
    const ph = phases({ ...p, ...copy });
    const x = firstFreeStart(bed, p.len, { offset: p.offset, span: p.span, from: ph.fieldStart, to: ph.he });
    if (x == null) copy.bed_id = null;
    else copy.start = x;
  }
  const item = await create("plantings", copy);
  select({ type: "planting", id: item.id });
  const crop = find.crop(p.crop_id);
  toast(copy.bed_id ? `Folgesatz ${crop?.name ?? ""} angelegt` : `Folgesatz angelegt, im Beet war kein Platz: steht unter „Ohne Beet“`);
  return item;
}

// ---------------------------------------------------------------- Satz

export function openPlantingEditor(planting, defaults = {}) {
  const isNew = !planting?.id;
  const p = { method: "direct", variety: "", start: 0, len: 1, offset: 0, span: null, notes: "", ...planting, ...defaults };
  const crops = [...state.crops].sort((a, b) => a.name.localeCompare(b.name, "de"));

  const cropSel = h("select", { name: "crop_id", required: true },
    isNew && !p.crop_id ? h("option", { value: "" }, "Kultur wählen") : null,
    crops.map((c) => h("option", { value: c.id, selected: c.id === p.crop_id }, c.name)));
  const varietyList = h("datalist", { id: "variety-list" });
  const variety = h("input", { name: "variety", value: p.variety || "", list: "variety-list", autocomplete: "off", placeholder: "z. B. Ochsenherz" });

  const beds = state.beds.filter((b) => PLANTABLE.has(b.kind) || b.id === p.bed_id);
  const bedSel = h("select", { name: "bed_id" },
    h("option", { value: "" }, "Ohne Beet"),
    beds.map((b) => h("option", { value: b.id, selected: b.id === p.bed_id }, b.name)));

  const methodSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Anbau" },
    h("label", {}, h("input", { type: "radio", name: "method", value: "direct", checked: p.method === "direct" }), "Direktsaat"),
    h("label", {}, h("input", { type: "radio", name: "method", value: "transplant", checked: p.method === "transplant" }), "Anzucht und Pflanzung"));

  const sow = h("input", { type: "date", name: "sow_date", value: p.sow_date || "", required: true });
  const plant = h("input", { type: "date", name: "plant_date", value: p.plant_date || "" });
  const hs = h("input", { type: "date", name: "harvest_start", value: p.harvest_start || "", required: true });
  const he = h("input", { type: "date", name: "harvest_end", value: p.harvest_end || "", required: true });
  const plantField = field("Pflanzung", plant);

  const recalcBtn = h("button", { type: "button", class: "btn btn-sm" }, "Termine aus Kulturdaten berechnen");

  const start = h("input", { name: "start", inputmode: "decimal", value: fmtInput(p.start) });
  const len = h("input", { name: "len", inputmode: "decimal", value: fmtInput(p.len) });
  const offset = h("input", { name: "offset", inputmode: "decimal", value: fmtInput(p.offset) });
  const span = h("input", { name: "span", inputmode: "decimal", value: fmtInput(p.span), placeholder: "bis Rand" });
  const rowSp = h("input", { name: "row_spacing", inputmode: "numeric", value: p.row_spacing ?? "" });
  const plantSp = h("input", { name: "plant_spacing", inputmode: "numeric", value: p.plant_spacing ?? "" });
  const rows = h("input", { name: "rows", inputmode: "numeric", value: p.rows ?? "", placeholder: "automatisch" });
  const calc = h("p", { class: "calc", style: { margin: 0 } });

  const sown = h("input", { type: "checkbox", name: "sown_done", checked: !!p.sown_done });
  const planted = h("input", { type: "checkbox", name: "planted_done", checked: !!p.planted_done });
  const harvested = h("input", { type: "checkbox", name: "harvest_done", checked: !!p.harvest_done });
  const plantedLabel = h("label", { class: "check" }, planted, "gepflanzt");
  const notes = h("textarea", { name: "notes" }, p.notes || "");

  const method = () => methodSeg.querySelector("input:checked")?.value || "direct";
  const crop = () => find.crop(Number(cropSel.value));
  const bed = () => find.bed(Number(bedSel.value));

  function refresh() {
    const c = crop();
    const isTp = method() === "transplant";
    plantField.hidden = !isTp;
    plantedLabel.hidden = !isTp;
    rowSp.placeholder = c ? `${c.row_spacing} (Kultur)` : "";
    plantSp.placeholder = c ? `${c.plant_spacing} (Kultur)` : "";
    varietyList.replaceChildren(...[...new Set(state.plantings
      .filter((q) => q.crop_id === c?.id && q.variety).map((q) => q.variety))].map((v) => h("option", { value: v })));
    const draft = currentDraft();
    if (c && draft.len > 0) {
      const b = bed();
      const sp = spanOf(draft, b);
      calc.replaceChildren(
        h("strong", {}, `${plural(rowCount(draft, c, b), "Reihe", "Reihen")}, ${plural(plantCount(draft, c, b), "Pflanze", "Pflanzen")}`),
        ` auf ${fmtNum(draft.len)} × ${fmtNum(sp)} m (${fmtNum(draft.len * sp)} m²)`);
    } else {
      calc.textContent = "";
    }
  }

  function currentDraft() {
    return {
      len: num(len.value) ?? 0, offset: num(offset.value) ?? 0, span: num(span.value),
      rows: num(rows.value), row_spacing: num(rowSp.value), plant_spacing: num(plantSp.value),
    };
  }

  // Termine aus Kulturdaten. Neue Sätze verankern am angeklickten Tag (Beginn der Beetbelegung).
  const anchorDay = p.anchor ?? state.day;
  function recalc(fromAnchor = false) {
    const c = crop();
    if (!c) return;
    const m = method();
    let anchor = anchorDay;
    if (!fromAnchor) {
      if (m === "transplant" && plant.value) anchor = dayNum(plant.value);
      else if (m === "transplant" && sow.value) anchor = dayNum(sow.value) + (c.nursery_days || 28);
      else if (m === "direct" && sow.value) anchor = dayNum(sow.value);
    }
    const d = datesFromCrop(c, anchor, m);
    sow.value = d.sow_date;
    plant.value = d.plant_date || "";
    hs.value = d.harvest_start;
    he.value = d.harvest_end;
  }

  cropSel.addEventListener("change", () => {
    const c = crop();
    if (isNew && c) {
      const radio = methodSeg.querySelector(`input[value="${c.method}"]`);
      if (radio) radio.checked = true;
      recalc(true);
    }
    refresh();
  });
  methodSeg.addEventListener("change", () => {
    const c = crop();
    if (method() === "transplant" && !plant.value && sow.value) {
      plant.value = isoOf(dayNum(sow.value) + (c?.nursery_days || 28));
    }
    refresh();
  });
  recalcBtn.addEventListener("click", () => recalc(false));
  let startTouched = !isNew;
  start.addEventListener("input", () => { startTouched = true; });
  for (const el of [len, offset, span, rows, rowSp, plantSp, bedSel]) el.addEventListener("input", refresh);

  const title = isNew ? "Neuer Satz" : `${find.crop(p.crop_id)?.name ?? "Satz"}${p.variety ? " " + p.variety : ""}`;
  const ui = shell(title, { onSubmit: save });

  async function save() {
    const c = crop();
    if (!c) throw new Error("Bitte eine Kultur wählen");
    const m = method();
    if (!sow.value || !hs.value || !he.value || (m === "transplant" && !plant.value)) {
      throw new Error("Bitte alle Termine ausfüllen");
    }
    const order = [sow.value, m === "transplant" ? plant.value : null, hs.value, he.value].filter(Boolean);
    if (order.join() !== [...order].sort().join()) {
      throw new Error("Die Termine müssen in der Reihenfolge Aussaat, Pflanzung, Erntebeginn, Ernteende liegen");
    }
    const draft = currentDraft();
    if (!(draft.len > 0)) throw new Error("Die Länge muss größer als 0 sein");
    const payload = {
      crop_id: c.id,
      variety: variety.value.trim(),
      bed_id: bedSel.value ? Number(bedSel.value) : null,
      method: m,
      sow_date: sow.value,
      plant_date: m === "transplant" ? plant.value : null,
      harvest_start: hs.value,
      harvest_end: he.value,
      start: Math.max(0, num(start.value) ?? 0),
      len: draft.len,
      offset: Math.max(0, draft.offset),
      span: draft.span && draft.span > 0 ? draft.span : null,
      rows: draft.rows && draft.rows >= 1 ? Math.round(draft.rows) : null,
      row_spacing: draft.row_spacing ? Math.round(draft.row_spacing) : null,
      plant_spacing: draft.plant_spacing ? Math.round(draft.plant_spacing) : null,
      sown_done: sown.checked,
      planted_done: m === "transplant" ? planted.checked : false,
      harvest_done: harvested.checked,
      notes: notes.value,
    };
    if (isNew) {
      const targetBed = find.bed(payload.bed_id);
      if (targetBed && !startTouched) {
        const ph = phases(payload);
        payload.len = Math.min(payload.len, targetBed.length);
        payload.start = firstFreeStart(targetBed, payload.len,
          { offset: payload.offset, span: payload.span, from: ph.fieldStart, to: ph.he }) ?? 0;
      }
      const item = await create("plantings", payload);
      select({ type: "planting", id: item.id });
      toast(`${c.name} angelegt`);
    } else {
      await patch("plantings", p.id, payload, { undoLabel: "Satz gespeichert", silent: true });
    }
  }

  const issueList = isNew ? [] : issuesOf(p.id);

  ui.body.append(
    h("div", { class: "grid-2" }, field("Kultur", cropSel), field("Sorte", variety), varietyList),
    h("div", { class: "grid-2 stack-sm" }, field("Beet", bedSel),
      h("div", { class: "field" }, h("span", {}, "Anbau"), methodSeg)),
    h("fieldset", {},
      h("legend", {}, "Termine"),
      h("div", { class: "grid-4" }, field("Aussaat", sow), plantField, field("Ernte ab", hs), field("Ernte bis", he)),
      h("div", {}, recalcBtn)),
    h("fieldset", {},
      h("legend", {}, "Platz im Beet"),
      h("div", { class: "grid-4" },
        field("Start (m)", start), field("Länge (m)", len), field("Abstand zum Rand (m)", offset), field("Breite (m)", span)),
      h("div", { class: "grid-3" },
        field("Reihenabstand (cm)", rowSp), field("Pflanzabstand (cm)", plantSp), field("Reihen", rows)),
      calc),
    h("fieldset", {},
      h("legend", {}, "Erledigt"),
      h("div", { style: { display: "flex", gap: "18px", flexWrap: "wrap" } },
        h("label", { class: "check" }, sown, "gesät"), plantedLabel,
        h("label", { class: "check" }, harvested, "abgeräumt"))),
    field("Notizen", notes),
    issueList.length ? h("ul", { class: "issues" }, issueList.map((i) => h("li", { class: i.kind }, i.text))) : null,
  );

  ui.foot.append(
    isNew ? null : h("button", {
      type: "button", class: "btn btn-danger", onclick: async () => {
        ui.dlg.close();
        await remove("plantings", p.id, { undoLabel: "Satz gelöscht" });
      },
    }, "Löschen"),
    isNew ? null : h("button", {
      type: "button", class: "btn btn-quiet", title: "Gleiche Kultur 14 Tage später",
      onclick: async () => { ui.dlg.close(); await createSuccession(p, 14); },
    }, "Folgesatz anlegen"),
    h("span", { class: "spacer" }),
    cancelBtn(ui.dlg),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Satz anlegen" : "Speichern"),
  );

  if (isNew && p.crop_id && !p.sow_date) recalc(true);
  refresh();
  ui.open();
  if (isNew && !p.crop_id) cropSel.focus();
}

function fmtInput(v) {
  if (v == null || v === "") return "";
  return String(round2(v)).replace(".", ",");
}

// ---------------------------------------------------------------- Beet

export function openBedEditor(bed, defaults = {}) {
  const isNew = !bed?.id;
  const b = { name: "", kind: "bed", length: 4, width: 1.2, rotation: 0, x: 1, y: 1, notes: "", ...bed, ...defaults };
  const name = h("input", { name: "name", value: b.name, required: true, maxlength: 80 });
  const kind = h("select", { name: "kind" },
    Object.entries(KIND_LABEL).map(([k, label]) => h("option", { value: k, selected: k === b.kind }, label)));
  const length = h("input", { name: "length", inputmode: "decimal", value: fmtInput(b.length) });
  const width = h("input", { name: "width", inputmode: "decimal", value: fmtInput(b.width) });
  const rotation = h("input", { name: "rotation", inputmode: "numeric", value: Math.round(b.rotation || 0) });
  const x = h("input", { name: "x", inputmode: "decimal", value: fmtInput(b.x) });
  const y = h("input", { name: "y", inputmode: "decimal", value: fmtInput(b.y) });
  const notes = h("textarea", { name: "notes" }, b.notes || "");

  const ui = shell(isNew ? "Neues Beet" : b.name, {
    onSubmit: async () => {
      const payload = {
        name: name.value.trim(),
        kind: kind.value,
        length: num(length.value),
        width: num(width.value),
        rotation: ((num(rotation.value) ?? 0) % 360 + 360) % 360,
        x: num(x.value) ?? 0,
        y: num(y.value) ?? 0,
        notes: notes.value,
      };
      if (!payload.name) throw new Error("Bitte einen Namen eingeben");
      if (!(payload.length > 0) || !(payload.width > 0)) throw new Error("Länge und Breite müssen größer als 0 sein");
      if (isNew) {
        const item = await create("beds", payload);
        select({ type: "bed", id: item.id });
      } else {
        await patch("beds", b.id, payload, { undoLabel: "Beet gespeichert", silent: true });
      }
    },
  });

  ui.body.append(
    h("div", { class: "grid-2" }, field("Name", name), field("Art", kind)),
    h("div", { class: "grid-3" }, field("Länge (m)", length), field("Breite (m)", width), field("Drehung (°)", rotation)),
    h("div", { class: "grid-2" }, field("Position links (m)", x), field("Position oben (m)", y)),
    field("Notizen", notes, "Zum Beispiel Bodenart, Bewässerung oder Mulch"),
  );
  ui.foot.append(
    isNew ? null : h("button", {
      type: "button", class: "btn btn-danger", onclick: async () => {
        const count = state.plantings.filter((p) => p.bed_id === b.id).length;
        const ok = await confirmDialog(count
          ? `${b.name} wird gelöscht. Die ${count} Sätze darin bleiben erhalten und stehen danach unter „Ohne Beet“.`
          : `${b.name} wird gelöscht.`, { title: "Beet löschen?" });
        if (!ok) return;
        ui.dlg.close();
        await remove("beds", b.id, { undoLabel: `${b.name} gelöscht` });
      },
    }, "Löschen"),
    h("span", { class: "spacer" }),
    cancelBtn(ui.dlg),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Beet anlegen" : "Speichern"),
  );
  ui.open();
}

// ---------------------------------------------------------------- Kultur

export function openCropEditor(crop) {
  const isNew = !crop?.id;
  const c = { name: "", family: "", color: "#6a9b3c", method: "direct", nursery_days: 0, field_days: 60,
    harvest_days: 21, row_spacing: 30, plant_spacing: 30, notes: "", ...crop };
  const families = [...new Set(state.crops.map((x) => x.family).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));

  const name = h("input", { name: "name", value: c.name, required: true, maxlength: 80 });
  const family = h("input", { name: "family", value: c.family, list: "family-list", autocomplete: "off" });
  const famList = h("datalist", { id: "family-list" }, families.map((f) => h("option", { value: f })));
  const color = h("input", { type: "color", name: "color", value: c.color });
  const method = h("select", { name: "method" },
    h("option", { value: "direct", selected: c.method === "direct" }, "Direktsaat"),
    h("option", { value: "transplant", selected: c.method === "transplant" }, "Anzucht und Pflanzung"));
  const nursery = h("input", { name: "nursery_days", inputmode: "numeric", value: c.nursery_days });
  const fieldDays = h("input", { name: "field_days", inputmode: "numeric", value: c.field_days });
  const harvest = h("input", { name: "harvest_days", inputmode: "numeric", value: c.harvest_days });
  const rowSp = h("input", { name: "row_spacing", inputmode: "numeric", value: c.row_spacing });
  const plantSp = h("input", { name: "plant_spacing", inputmode: "numeric", value: c.plant_spacing });
  const notes = h("textarea", { name: "notes" }, c.notes || "");

  const ui = shell(isNew ? "Neue Kultur" : c.name, {
    onSubmit: async () => {
      const intOf = (el, label, min = 0) => {
        const v = num(el.value);
        if (v == null || v < min) throw new Error(`${label}: bitte eine Zahl ab ${min} eingeben`);
        return Math.round(v);
      };
      const payload = {
        name: name.value.trim(),
        family: family.value.trim(),
        color: color.value,
        method: method.value,
        nursery_days: intOf(nursery, "Anzucht"),
        field_days: intOf(fieldDays, "Tage bis zur Ernte"),
        harvest_days: intOf(harvest, "Erntedauer"),
        row_spacing: intOf(rowSp, "Reihenabstand", 1),
        plant_spacing: intOf(plantSp, "Pflanzabstand", 1),
        notes: notes.value,
      };
      if (!payload.name) throw new Error("Bitte einen Namen eingeben");
      if (isNew) await create("crops", payload);
      else await patch("crops", c.id, payload, { silent: true });
    },
  });

  ui.body.append(
    h("div", { class: "grid-2" }, field("Name", name), field("Pflanzenfamilie", family, "Wird für die Fruchtfolge-Prüfung genutzt"), famList),
    h("div", { class: "grid-2" }, field("Farbe", color), field("Übliche Anbauart", method)),
    h("fieldset", {},
      h("legend", {}, "Kulturdauer in Tagen"),
      h("div", { class: "grid-3" },
        field("Anzucht", nursery, "Aussaat bis Pflanzung"),
        field("Bis zur Ernte", fieldDays, "ab Pflanzung bzw. Direktsaat"),
        field("Erntedauer", harvest))),
    h("fieldset", {},
      h("legend", {}, "Abstände in cm"),
      h("div", { class: "grid-2" }, field("Reihenabstand", rowSp), field("Pflanzabstand in der Reihe", plantSp))),
    field("Notizen", notes),
  );
  const used = isNew ? 0 : state.plantings.filter((p) => p.crop_id === c.id).length;
  ui.foot.append(
    isNew ? null : h("button", {
      type: "button", class: "btn btn-danger", disabled: used > 0,
      title: used ? `Wird in ${used} Sätzen verwendet` : null,
      onclick: async () => {
        if (!(await confirmDialog(`${c.name} wird aus der Kulturliste gelöscht.`, { title: "Kultur löschen?" }))) return;
        ui.dlg.close();
        await remove("crops", c.id);
        toast(`${c.name} gelöscht`);
      },
    }, "Löschen"),
    h("span", { class: "spacer" }),
    cancelBtn(ui.dlg),
    h("button", { type: "submit", class: "btn btn-primary" }, isNew ? "Kultur anlegen" : "Speichern"),
  );
  ui.open();
}

// ---------------------------------------------------------------- Einstellungen

export function openSettings() {
  const s = state.settings;
  const name = h("input", { name: "garden_name", value: s.garden_name || "", maxlength: 80 });
  const width = h("input", { name: "garden_width", inputmode: "decimal", value: fmtInput(Number(s.garden_width || 16)) });
  const height = h("input", { name: "garden_height", inputmode: "decimal", value: fmtInput(Number(s.garden_height || 11)) });
  const years = h("input", { name: "rotation_years", inputmode: "numeric", value: s.rotation_years ?? 3 });
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });

  const ui = shell("Einstellungen", {
    onSubmit: async () => {
      const payload = {
        garden_name: name.value.trim() || "Mein Garten",
        rotation_years: Math.round(num(years.value) ?? 3),
      };
      if (!geo) {
        payload.garden_width = num(width.value);
        payload.garden_height = num(height.value);
        if (!(payload.garden_width > 0) || !(payload.garden_height > 0)) throw new Error("Breite und Höhe müssen größer als 0 sein");
      }
      state.settings = await api.patch("/api/settings", payload);
      emit("data");
      toast("Einstellungen gespeichert");
    },
  });

  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { ui.showError("Die Datei ist kein gültiges JSON"); return; }
    if (!(await confirmDialog("Alle Beete, Kulturen und Sätze werden durch den Inhalt der Sicherung ersetzt.", { ok: "Ersetzen", title: "Sicherung einspielen?" }))) return;
    try {
      replaceAll(await api.post("/api/import", data));
      ui.dlg.close();
      toast("Sicherung eingespielt");
    } catch (e) { ui.showError(e.message); }
  });

  const geo = state.geo;
  const sourceLabel = () => {
    if (!geo) return "";
    if (geo.source === "custom") return "eigene Quelle";
    return state.imagery?.sources?.find((x) => x.id === geo.source)?.label ?? geo.source;
  };
  const reloadImage = async (btn) => {
    btn.disabled = true;
    btn.textContent = "Luftbild wird geladen …";
    try {
      replaceAll(await api.post("/api/garden/image", { source: geo.source }));
      ui.dlg.close();
      toast("Luftbild neu geladen");
    } catch (e) {
      ui.showError(e.message);
      btn.disabled = false;
      btn.textContent = "Luftbild neu laden";
    }
  };
  const removeGeo = async () => {
    if (!(await confirmDialog("Grenze und gespeichertes Luftbild werden entfernt. Deine Beete bleiben, wo sie sind.", { ok: "Entfernen", title: "Grenze entfernen?" }))) return;
    try {
      replaceAll(await api.del("/api/garden/geo"));
      ui.dlg.close();
      toast("Grenze entfernt");
    } catch (e) { ui.showError(e.message); }
  };
  const groundSection = geo
    ? h("fieldset", {},
      h("legend", {}, "Grundstück"),
      h("p", { class: "muted small", style: { margin: 0 } },
        `Auf dem Luftbild festgelegt: ${fmtNum(geo.width)} × ${fmtNum(geo.height)} m, ${fmtNum(geo.area, 0)} m². `,
        geo.image ? `Luftbild: ${sourceLabel()}, geladen am ${new Date(geo.image.fetched_at * 1000).toLocaleDateString("de-DE")}.`
          : geo.image_missing ? "Das gespeicherte Luftbild fehlt." : "Kein Luftbild gespeichert."),
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        h("button", { type: "button", class: "btn", onclick: () => { ui.dlg.close(); openGeoSetup(); } }, icon("parcel"), "Grenze bearbeiten"),
        geo.source && state.imagery?.sources?.find((x) => x.id === geo.source)?.snapshot !== false
          ? h("button", { type: "button", class: "btn", onclick: (e) => reloadImage(e.currentTarget) }, "Luftbild neu laden") : null,
        h("button", { type: "button", class: "btn btn-danger", onclick: removeGeo }, "Grenze entfernen")))
    : h("fieldset", {},
      h("legend", {}, "Grundstück"),
      h("div", { class: "grid-2" }, field("Breite (m)", width), field("Tiefe (m)", height)),
      h("div", {}, h("button", { type: "button", class: "btn", onclick: () => { ui.dlg.close(); openGeoSetup(); } },
        icon("parcel"), "Stattdessen auf dem Luftbild festlegen")));

  const loadDemo = async () => {
    const hasBeds = state.beds.length > 0;
    if (hasBeds && !(await confirmDialog("Alle Beete und Sätze werden durch den Beispielgarten ersetzt. Die Kulturliste bleibt.", { ok: "Ersetzen", title: "Beispielgarten laden?" }))) return;
    try {
      replaceAll(await api.post(`/api/demo?replace=${hasBeds}`));
      ui.dlg.close();
      toast("Beispielgarten geladen");
    } catch (e) { ui.showError(e.message); }
  };

  ui.body.append(
    field("Name des Gartens", name),
    groundSection,
    field("Anbaupause für die Fruchtfolge (Jahre)", years,
      "Gleiche Pflanzenfamilie an gleicher Stelle innerhalb dieser Zeit wird markiert. 0 schaltet die Prüfung ab."),
    h("fieldset", {},
      h("legend", {}, "Sicherung"),
      h("p", { class: "muted small", style: { margin: 0 } },
        "Die Daten liegen in einer SQLite-Datei auf deinem Server. Zusätzlich kannst du alles als JSON herunterladen."),
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        h("a", { class: "btn", href: "/api/export", download: "" }, "Sicherung herunterladen"),
        h("button", { type: "button", class: "btn", onclick: () => file.click() }, "Sicherung einspielen"),
        h("button", { type: "button", class: "btn btn-quiet", onclick: loadDemo }, "Beispielgarten laden"),
        file)),
  );
  ui.foot.append(h("span", { class: "spacer" }), cancelBtn(ui.dlg),
    h("button", { type: "submit", class: "btn btn-primary" }, "Speichern"));
  ui.open();
}

// ---------------------------------------------------------------- Neue Beete und Sätze an Ort und Stelle

export async function createBedAt(kind, cx, cy) {
  const sizes = { bed: [4, 1.2], raised: [2, 1], greenhouse: [4, 3], path: [4, 0.5], other: [1.5, 1.5] };
  const [length, width] = sizes[kind] || sizes.bed;
  const count = state.beds.filter((b) => b.kind === kind).length + 1;
  const base = { bed: "Beet", raised: "Hochbeet", greenhouse: "Gewächshaus", path: "Weg", other: "Fläche" }[kind];
  const gw = Number(state.settings.garden_width || 16);
  const gh = Number(state.settings.garden_height || 11);
  const item = await create("beds", {
    name: `${base} ${count}`, kind, length, width,
    x: round2(clamp(cx - length / 2, 0, Math.max(0, gw - length))),
    y: round2(clamp(cy - width / 2, 0, Math.max(0, gh - width))),
  });
  select({ type: "bed", id: item.id });
  return item;
}

export async function placeCrop(cropId, bed, local = null) {
  const crop = find.crop(cropId);
  if (!crop || !bed) return null;
  if (!PLANTABLE.has(bed.kind)) {
    toast(`${KIND_LABEL[bed.kind]} ist keine Anbaufläche`, { error: true });
    return null;
  }
  const dates = datesFromCrop(crop, state.day);
  const from = dayNum(crop.method === "transplant" ? dates.plant_date : dates.sow_date);
  const to = dayNum(dates.harvest_end);
  const len = Math.min(1, bed.length);
  let span = null;
  let offset = 0;
  if (bed.width > 1.6) {
    span = Math.min(1.2, bed.width);
    offset = local ? round2(clamp(Math.round((local.y - span / 2) * 10) / 10, 0, bed.width - span)) : 0;
  }
  let start;
  if (local) {
    start = round2(clamp(Math.round((local.x - len / 2) * 10) / 10, 0, bed.length - len));
  } else {
    start = firstFreeStart(bed, len, { offset, span, from, to }) ?? 0;
  }
  const item = await create("plantings", {
    crop_id: crop.id, method: crop.method, bed_id: bed.id, ...dates,
    start, len, offset, span,
  });
  select({ type: "planting", id: item.id });
  toast(`${crop.name} in ${bed.name} gesetzt`);
  return item;
}
