// Kulturen: Grunddaten, aus denen Termine, Abstände und Fruchtfolge abgeleitet werden.
import { state } from "./store.js";
import { h } from "./util.js";
import { openCropEditor } from "./editor.js";
import { openCropOverview } from "./overview.js";
import { varietiesView, forgetProfiles } from "./varieties.js";
import { replaceKeepingFocus } from "./ui.js";

let filter = "";
let tab = (() => { try { return sessionStorage.getItem("beetwerk.cropsTab") || "kulturen"; } catch { return "kulturen"; } })();

function tabs(render) {
  const opt = (k, label) => {
    const input = h("input", { type: "radio", name: "crops-tab", checked: tab === k });
    input.addEventListener("change", () => {
      tab = k;
      try { sessionStorage.setItem("beetwerk.cropsTab", k); } catch { /* egal */ }
      render();
    });
    return h("label", {}, input, label);
  };
  return h("div", { class: "seg", role: "radiogroup", "aria-label": "Ansicht" },
    opt("kulturen", "Kulturen"), opt("sorten", `Sorten (${state.varieties.length})`));
}

export function mountCrops(root) {
  forgetProfiles(); // Bonitur kann sich inzwischen geändert haben
  const page = h("div", { class: "page" });
  root.append(page);

  function render() {
    if (tab === "sorten") {
      const keepTop = page.scrollTop;
      const inner = h("div", { class: "page-inner" },
        h("div", { class: "page-head" }, h("h1", {}, "Sorten"), tabs(render)),
        varietiesView(render));
      replaceKeepingFocus(page, [inner]);
      page.scrollTop = keepTop;
      return;
    }
    const keep = page.scrollTop;
    const used = new Map();
    for (const p of state.plantings) used.set(p.crop_id, (used.get(p.crop_id) || 0) + 1);
    const sorts = new Map();
    for (const v of state.varieties) sorts.set(v.crop_id, (sorts.get(v.crop_id) || 0) + 1);
    const q = filter.trim().toLowerCase();
    const crops = [...state.crops]
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.family || "").toLowerCase().includes(q))
      .sort((a, b) => (a.family || "").localeCompare(b.family || "", "de") || a.name.localeCompare(b.name, "de"));

    const search = h("input", { class: "input", type: "search", placeholder: "Kultur oder Familie", value: filter,
      style: { maxWidth: "260px" }, "aria-label": "Kulturen filtern",
      oninput: (e) => {
        filter = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const again = page.querySelector('input[type="search"]');
        again?.focus();
        again?.setSelectionRange(pos, pos);
      } });

    const rows = [];
    let lastFamily = null;
    for (const c of crops) {
      if (c.family !== lastFamily) {
        lastFamily = c.family;
        rows.push(h("tr", { style: { cursor: "default", background: "var(--surface-2)" } },
          h("td", { colspan: 8, style: { fontWeight: 600, fontSize: "13px", color: "var(--ink-2)", padding: "5px 10px" } }, c.family || "Ohne Familie")));
      }
      rows.push(h("tr", { tabindex: "0", onclick: () => openCropOverview(c), onkeydown: (e) => { if (e.key === "Enter") openCropOverview(c); } },
        h("td", {}, h("div", { class: "crop-cell" }, h("span", { class: "dot", style: { background: c.color } }), c.name)),
        h("td", {}, c.method === "transplant" ? "Anzucht" : "Direktsaat"),
        h("td", { class: "r" }, c.method === "transplant" ? `${c.nursery_days} Tage` : h("span", { class: "muted" }, "–")),
        h("td", { class: "r" }, `${c.field_days} Tage`),
        h("td", { class: "r" }, `${c.harvest_days} Tage`),
        h("td", { class: "r nowrap" }, `${c.row_spacing} × ${c.plant_spacing} cm`),
        h("td", { class: "r" }, sorts.get(c.id) || h("span", { class: "muted" }, "–")),
        h("td", { class: "r" }, used.get(c.id) || h("span", { class: "muted" }, "–"))));
    }

    const inner = h("div", { class: "page-inner" },
      h("div", { class: "page-head" },
        h("h1", {}, "Kulturen"),
        tabs(render),
        search,
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openCropEditor(null) }, "Neue Kultur")),
      h("p", { class: "muted", style: { margin: "-14px 0 0", maxWidth: "70ch" } },
        "Antippen zeigt die Übersicht einer Kultur mit ihren Sorten, Sätzen und der Anzucht. Die Tage bestimmen die vorgeschlagenen Termine, wenn du eine Kultur aufs Beet setzt; bis zur Ernte zählt ab Pflanzung, bei Direktsaat ab Aussaat. Die Familie nutzt die Fruchtfolge-Prüfung."),
      crops.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "data" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Kultur"), h("th", {}, "Anbau"), h("th", { class: "r" }, "Anzucht"), h("th", { class: "r" }, "Bis Ernte"),
            h("th", { class: "r" }, "Erntedauer"), h("th", { class: "r" }, "Abstände"), h("th", { class: "r" }, "Sorten"), h("th", { class: "r" }, "Sätze"))),
          h("tbody", {}, rows)))
        : h("div", { class: "empty-note" }, "Keine Kultur passt zum Filter."));
    page.replaceChildren(inner);
    page.scrollTop = keep;
  }

  render();
  return { update() { render(); } };
}
