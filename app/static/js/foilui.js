// Folien-Vorlagen: Liste in den Einstellungen und Dialog einer Vorlage.
// Gerechnet wird in util.js (foilOf, plantLayout) und foils.py.
import { state, api, load } from "./store.js";
import { h, plural, foilLabel, PLANTABLE } from "./util.js";
import { shell, field } from "./editor.js";
import { confirmDialog, toast } from "./ui.js";

const num = (v) => {
  const n = Number(String(v).trim().replace(",", "."));
  return String(v).trim() && Number.isFinite(n) ? n : null;
};

// Dialog einer Vorlage: Raster und die Beete, auf denen sie liegt
export function openFoilEditor(foil, { onDone } = {}) {
  const f = foil ?? { name: "", rows: 2, row_spacing: 40, plant_spacing: 40 };
  const name = h("input", { value: f.name, maxlength: 60, placeholder: "z. B. Folie 30 × 30" });
  const rows = h("input", { inputmode: "numeric", value: f.rows });
  const rowSp = h("input", { inputmode: "numeric", value: f.row_spacing });
  const plantSp = h("input", { inputmode: "numeric", value: f.plant_spacing });
  const beds = state.beds.filter((b) => PLANTABLE.has(b.kind));
  const checks = beds.map((b) => {
    const other = b.foil_id && b.foil_id !== f.id ? state.foils.find((x) => x.id === b.foil_id) : null;
    const box = h("input", { type: "checkbox", value: b.id, checked: !!f.id && b.foil_id === f.id });
    return { box, el: h("label", { class: "check" }, box, b.name, other ? h("span", { class: "muted small" }, ` bisher ${other.name}`) : null) };
  });
  const need = h("p", { class: "calc", style: { margin: 0 } });
  const paintNeed = () => {
    const r = num(rows.value), rs = num(rowSp.value);
    need.textContent = r >= 1 && rs > 0
      ? (r > 1 ? `Die Reihen liegen mittig im Beet und brauchen ${Math.round((r - 1) * rs)} cm von der ersten bis zur letzten.` : "Die Reihe liegt in der Beetmitte.")
      : "";
  };
  for (const el of [rows, rowSp]) el.addEventListener("input", paintNeed);
  paintNeed();

  const ui = shell(foil ? foil.name : "Neue Folien-Vorlage", {
    onSubmit: async () => {
      const r = num(rows.value), rs = num(rowSp.value), ps = num(plantSp.value);
      if (!(r >= 1) || !Number.isInteger(r)) throw new Error("Reihen: bitte eine ganze Zahl ab 1 eingeben");
      if (!(rs >= 1) || !(ps >= 1)) throw new Error("Abstände: bitte Zahlen ab 1 cm eingeben");
      const payload = { name: name.value.trim() || `Folie ${Math.round(rs)} × ${Math.round(ps)}`, rows: r,
        row_spacing: Math.round(rs), plant_spacing: Math.round(ps),
        bed_ids: checks.filter((c) => c.box.checked).map((c) => Number(c.box.value)) };
      if (foil) await api.patch(`/api/foils/${foil.id}`, payload);
      else await api.post("/api/foils", payload);
      await load(); // Beete und abgeerntete Sätze können sich mit geändert haben
      onDone?.();
    },
  });
  ui.body.append(
    field("Name", name),
    h("div", { class: "grid-3" }, field("Reihen im Beet", rows), field("Reihenabstand (cm)", rowSp), field("Abstand in der Reihe (cm)", plantSp)),
    need,
    beds.length ? h("fieldset", {},
      h("legend", {}, "Liegt auf diesen Beeten"),
      h("div", { class: "foil-beds" }, checks.map((c) => c.el)),
      h("p", { class: "muted small", style: { margin: 0 } },
        "Sätze auf diesen Beeten rechnen mit dem Raster der Folie. Abgeerntete Sätze behalten ihr bisheriges Raster.")) : null);
  ui.foot.append(
    foil ? h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      const used = state.beds.filter((b) => b.foil_id === foil.id).length;
      const ok = await confirmDialog(`${foil.name} wird gelöscht.`
        + (used ? ` ${plural(used, "Beet rechnet", "Beete rechnen")} danach wieder mit den Abständen der Kulturen.` : "")
        + " Abgeerntete Sätze behalten ihre Abstände.", { title: "Vorlage löschen?" });
      if (!ok) return;
      try {
        await api.del(`/api/foils/${foil.id}`);
      } catch (e) {
        toast(e.message, { error: true });
        return;
      }
      ui.dlg.close();
      await load();
      onDone?.();
    } }, "Löschen") : null,
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn", onclick: () => ui.dlg.close() }, "Abbrechen"),
    h("button", { type: "submit", class: "btn btn-primary" }, foil ? "Speichern" : "Anlegen"));
  ui.open();
}

// Abschnitt der Einstellungen: die Vorlagen als antippbare Liste
export function foilSettings() {
  const list = h("div", { class: "fert-list" });
  function paint() {
    list.replaceChildren(...state.foils.map((f) => {
      const n = state.beds.filter((b) => b.foil_id === f.id).length;
      return h("button", { type: "button", class: "chip", onclick: () => openFoilEditor(f, { onDone: paint }) },
        f.name, h("span", { class: "muted" }, ` ${plural(f.rows, "Reihe", "Reihen")}, ${f.row_spacing} × ${f.plant_spacing} cm · ${plural(n, "Beet", "Beete")}`));
    }), h("button", { type: "button", class: "chip chip-add", onclick: () => openFoilEditor(null, { onDone: paint }) }, "+ Vorlage"));
  }
  paint();
  return h("fieldset", {},
    h("legend", {}, "Folien und Pflanzraster"),
    h("p", { class: "muted small", style: { margin: 0 } },
      "Für Gewebe- oder Mulchfolie mit Löchern: Eine Vorlage hat Reihen, Reihenabstand und Abstand in der Reihe. "
      + "Liegt sie auf einem Beet, rechnen die Sätze dort mit ihrem Raster statt mit den Abständen der Kultur – "
      + "außer bei Kulturen, die nicht ins Raster passen (Radieschen, Möhren und andere mit engem Abstand in der Reihe). "
      + "Vorlage antippen, um sie zu ändern oder Beeten zuzuweisen:"),
    list);
}

// Auswahl der Folie eines Beets (0 = keine)
export function bedFoilSelect(bed) {
  return h("select", { name: "foil_id" },
    h("option", { value: 0 }, "keine Folie"),
    state.foils.map((f) => h("option", { value: f.id, selected: f.id === bed.foil_id }, foilLabel(f))));
}
