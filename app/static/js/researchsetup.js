// Einstellungen für die Saatgut-Recherche mit Claude: API-Schlüssel und Modell.
import { api } from "./store.js";
import { h } from "./util.js";
import { toast, confirmDialog } from "./ui.js";
import { field } from "./editor.js";
import { forgetResearchStatus } from "./varieties.js";

export function researchSection() {
  const box = h("fieldset", {}, h("legend", {}, "KI-Recherche"), h("p", { class: "muted small", style: { margin: 0 } }, "Lade …"));
  const paint = (st) => {
    const key = h("input", { type: "password", autocomplete: "off", spellcheck: "false",
      placeholder: st.configured ? `gespeichert (${st.key_hint || "…"})` : "sk-ant-…" });
    const model = h("select", {}, st.models.map((m) => h("option", { value: m.id, selected: m.id === st.model }, m.label)));
    const msg = h("p", { class: "small", style: { margin: 0 }, hidden: true });
    const show = (text, ok) => { msg.textContent = text; msg.hidden = false; msg.className = ok ? "small ok-note" : "form-error"; };
    const save = async () => {
      try {
        const next = await api.put("/api/research", { api_key: key.value.trim() || undefined, model: model.value });
        forgetResearchStatus();
        toast("KI-Recherche gespeichert");
        paint(next);
      } catch (e) { show(e.message, false); }
    };
    const test = async (btn) => {
      btn.disabled = true;
      try {
        const res = await api.post("/api/research/test", { api_key: key.value.trim() || undefined, model: model.value });
        show(`Der Schlüssel funktioniert (${res.model}).`, true);
      } catch (e) { show(e.message, false); }
      btn.disabled = false;
    };
    box.replaceChildren(
      h("legend", {}, "KI-Recherche"),
      h("p", { class: "muted small", style: { margin: 0 } },
        "Unter Kulturen → Sorten recherchiert Claude neue Samen im Netz: Einordnung, Beschreibung, Quellen und Bilder zur Auswahl. "
        + "Dafür braucht es einen API-Schlüssel aus der ",
        h("a", { href: "https://console.anthropic.com/", target: "_blank", rel: "noopener" }, "Claude Console"),
        ". Abgerechnet wird je Nutzung: die Websuche kostet 1 Cent je Suchanfrage, dazu kommen die Tokens; je Sorte sind das meist wenige Cent. "
        + "Der Schlüssel bleibt auf deinem Server und steht nicht in der Sicherung."),
      h("div", { class: "grid-2 stack-sm" }, field("API-Schlüssel", key), field("Modell", model)),
      msg,
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        h("button", { type: "button", class: "btn", onclick: save }, "Speichern"),
        h("button", { type: "button", class: "btn btn-quiet", onclick: (e) => test(e.currentTarget) }, "Prüfen"),
        st.configured ? h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
          if (!(await confirmDialog("Der API-Schlüssel wird gelöscht. Die Recherche geht danach erst wieder mit einem neuen Schlüssel.", { ok: "Löschen", title: "Schlüssel löschen?" }))) return;
          try { paint(await api.put("/api/research", { api_key: "" })); forgetResearchStatus(); } catch (e) { show(e.message, false); }
        } }, "Schlüssel löschen") : null));
  };
  api.get("/api/research").then(paint).catch((e) => {
    box.replaceChildren(h("legend", {}, "KI-Recherche"), h("p", { class: "form-error", style: { margin: 0 } }, e.message));
  });
  return box;
}
