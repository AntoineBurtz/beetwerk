// Verbindung zu Baserow: einrichten, Zustand zeigen, von Hand abgleichen.
import { api } from "./store.js";
import { h, plural } from "./util.js";
import { toast, confirmDialog } from "./ui.js";
import { shell, field } from "./editor.js";

let cached = null;

export async function baserowStatus({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < 15000) return cached.data;
  const data = await api.get("/api/baserow");
  cached = { at: Date.now(), data };
  return data;
}

function remember(data) {
  cached = { at: Date.now(), data };
  return data;
}

function fmtWhen(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const today = new Date();
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `heute ${time}`;
  return `${d.toLocaleDateString("de-DE", { day: "numeric", month: "short" })} ${time}`;
}

export function resultText(r) {
  if (!r) return "";
  const parts = [];
  if (r.created) parts.push(`${r.created} neu`);
  if (r.updated) parts.push(`${r.updated} geändert`);
  if (r.deleted) parts.push(`${r.deleted} gelöscht`);
  if (r.photos) parts.push(plural(r.photos, "Foto", "Fotos"));
  return parts.length ? parts.join(", ") : "alles aktuell";
}

export async function syncNow() {
  try {
    const res = remember(await api.post("/api/baserow/sync"));
    toast(`Baserow: ${resultText(res.result)}`);
    return res;
  } catch (e) {
    toast(e.message, { error: true });
    cached = null;
    throw e;
  }
}

// Kurzer Zustand für die Kopfzeile der Bonitur
export function statusChip(st, onClick) {
  if (!st?.connected) return null;
  let text, cls = "";
  if (st.running) text = "Baserow: gleicht ab …";
  else if (st.last_error) { text = "Baserow: Fehler"; cls = " error"; }
  else if (st.pending) { text = `Baserow: ${st.pending} ${st.pending === 1 ? "Wert wartet" : "Werte warten"}`; cls = " wait"; }
  else text = st.last_sync ? `Baserow ✓ ${fmtWhen(st.last_sync)}` : "Baserow verbunden";
  return h("button", { type: "button", class: `btn btn-sm baserow-chip${cls}`, onclick: onClick,
    title: st.last_error || "Jetzt mit Baserow abgleichen" }, text);
}

// ---------------------------------------------------------------- Abschnitt in den Einstellungen

export function baserowSection() {
  const box = h("fieldset", {}, h("legend", {}, "Baserow"), h("p", { class: "muted small", style: { margin: 0 } }, "Lade …"));
  const paint = (st) => {
    const body = [h("legend", {}, "Baserow")];
    if (!st.connected) {
      body.push(
        h("p", { class: "muted small", style: { margin: 0 } },
          "Beetwerk kann Pflanzen, Merkmale und Boniturwerte samt Fotos in deine Baserow-Datenbank schreiben. "
          + "Neue und geänderte Werte gehen kurz nach dem Speichern automatisch hinüber."),
        h("div", {}, h("button", { type: "button", class: "btn", onclick: () => openBaserowSetup(st, () => refresh(true)) }, "Mit Baserow verbinden")));
    } else {
      body.push(
        h("p", { class: "small", style: { margin: 0 } },
          `Verbunden mit ${st.url}${st.database ? `, Datenbank „${st.database}“` : ""}. `,
          st.last_sync ? `Zuletzt abgeglichen ${fmtWhen(st.last_sync)} (${resultText(st.last_result)}). ` : "Noch nicht abgeglichen. ",
          st.pending ? `${plural(st.pending, "Wert wartet", "Werte warten")} auf die Übertragung.` : ""),
        st.last_error ? h("p", { class: "form-error", style: { margin: 0 } }, st.last_error) : null,
        st.missing?.length ? h("p", { class: "small warn-note", style: { margin: 0 } },
          `Neu: Beetwerk kann auch ${st.missing.map((n) => `„${n}“`).join(", ")} nach Baserow schreiben. `
          + "Mit „Neu einrichten“ legt es die Tabellen an; vorhandene Tabellen und Werte bleiben.") : null,
        Object.keys(st.missing_fields || {}).length ? h("p", { class: "small warn-note", style: { margin: 0 } },
          "In Baserow fehlen Spalten, die Beetwerk füllen kann: ",
          Object.entries(st.missing_fields).map(([t, cols]) => `${t}: ${cols.join(", ")}`).join("; "),
          ". Mit „Neu einrichten“ kommen sie dazu; vorhandene Spalten und Werte bleiben.") : null,
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          h("button", { type: "button", class: "btn", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await syncNow(); } catch { /* Meldung kam schon */ }
            refresh(true);
          } }, "Jetzt abgleichen"),
          h("button", { type: "button", class: "btn btn-quiet", onclick: () => openBaserowSetup(st, () => refresh(true)) }, "Neu einrichten"),
          h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
            if (!(await confirmDialog("Beetwerk vergisst Token und Tabellen. Was schon in Baserow steht, bleibt dort.", { ok: "Trennen", title: "Baserow trennen?" }))) return;
            try { paint(remember(await api.del("/api/baserow"))); toast("Baserow getrennt"); } catch (e) { toast(e.message, { error: true }); }
          } }, "Trennen")));
    }
    box.replaceChildren(...body.filter(Boolean));
  };
  const refresh = async (fresh) => {
    try { paint(await baserowStatus({ fresh })); } catch (e) {
      box.replaceChildren(h("legend", {}, "Baserow"), h("p", { class: "form-error", style: { margin: 0 } }, e.message));
    }
  };
  refresh(true);
  return box;
}

// ---------------------------------------------------------------- Einrichten

export function openBaserowSetup(st, after) {
  let mode = "auto";
  let dbs = null;
  const url = h("input", { value: st?.url || "", placeholder: "http://192.168.178.20:8090", autocomplete: "url", inputmode: "url" });
  const email = h("input", { type: "email", autocomplete: "username" });
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const dbSel = h("select", {});
  const varSel = h("select", {});
  const labelSel = h("select", {});
  const token = h("input", { autocomplete: "off", spellcheck: "false" });
  const ids = Object.fromEntries(["traits", "plants", "observations", "crops", "varieties", "plantings"]
    .map((k) => [k, h("input", { inputmode: "numeric" })]));
  for (const [k, el] of Object.entries(ids)) el.value = st?.tables?.[k] ?? "";
  const submit = h("button", { type: "submit", class: "btn btn-primary" });

  const fillTables = () => {
    const db = dbs?.find((d) => String(d.id) === dbSel.value);
    const opts = (re) => [h("option", { value: "" }, "keine"),
      ...(db?.tables || []).filter((t) => !/^(Bonitur-Merkmale|Bonitur-Pflanzen|Boniturwerte|Kulturen|Beetwerk-Sorten|Sätze)$/.test(t.name))
        .map((t) => h("option", { value: t.id, selected: re.test(t.name) }, t.name))];
    varSel.replaceChildren(...opts(/sorte/i));
    labelSel.replaceChildren(...opts(/etikett|label/i));
  };
  dbSel.addEventListener("change", fillTables);

  const loadBtn = h("button", { type: "button", class: "btn", onclick: async () => {
    ui.errorHide();
    loadBtn.disabled = true;
    loadBtn.textContent = "Melde an …";
    try {
      const res = await api.post("/api/baserow/databases", { url: url.value, email: email.value, password: password.value });
      dbs = res.databases;
      dbSel.replaceChildren(...dbs.map((d) => h("option", { value: d.id }, d.workspace ? `${d.name} (${d.workspace})` : d.name)));
      const guess = dbs.find((d) => d.tables.some((t) => /sorte/i.test(t.name))) || dbs[0];
      dbSel.value = String(guess.id);
      fillTables();
      paint();
    } catch (e) { ui.showError(e.message); }
    loadBtn.disabled = false;
    loadBtn.textContent = dbs ? "Neu laden" : "Anmelden";
  } }, "Anmelden");

  const autoBox = h("div", { class: "baserow-mode" });
  const manualBox = h("div", { class: "baserow-mode" });
  const specList = h("div", { class: "baserow-spec" },
    (st?.spec || []).map((t) => h("details", {}, h("summary", {}, t.name),
      h("ul", {}, t.fields.map((f) => h("li", {}, h("strong", {}, f.name), ` – ${f.type}`))))));

  function paint() {
    autoBox.hidden = mode !== "auto";
    manualBox.hidden = mode !== "manual";
    autoBox.replaceChildren(...[
      h("p", { class: "muted small", style: { margin: 0 } },
        "Melde dich einmal mit deinem Baserow-Konto an. Beetwerk legt in der gewählten Datenbank die Tabellen „Kulturen“, „Beetwerk-Sorten“, „Sätze“, "
        + "„Bonitur-Merkmale“, „Bonitur-Pflanzen“ und „Boniturwerte“ an (gibt es sie schon, ergänzt es fehlende Felder) sowie einen Datenbank-Token „Beetwerk“. "
        + "Das Passwort wird nicht gespeichert."),
      h("div", { class: "grid-2 stack-sm" }, field("E-Mail", email), field("Passwort", password)),
      h("div", {}, loadBtn),
      dbs ? h("div", { class: "grid-3 stack-sm" },
        field("Datenbank", dbSel),
        field("Sortentabelle", varSel, "Pflanzen und Werte werden mit der Sorte verknüpft (über das erste Feld)"),
        field("Etikettentabelle", labelSel, "Pflanzen werden über die Etikett-ID verknüpft")) : null].filter(Boolean));
    manualBox.replaceChildren(
      h("p", { class: "muted small", style: { margin: 0 } },
        "Lege die drei Tabellen mit genau diesen Feldnamen selbst an und erstelle unter „Einstellungen → Datenbank-Token“ einen Token mit Lese- und Schreibrecht. "
        + "Die Tabellen-ID steht in der Adresse, wenn die Tabelle offen ist (…/table/123/…). Optional: Felder „Sorte verknüpft“ und „Etikett verknüpft“ als Verknüpfung zu deinen Tabellen."),
      specList,
      field("Datenbank-Token", token),
      h("div", { class: "grid-3" }, field("Bonitur-Merkmale (ID)", ids.traits), field("Bonitur-Pflanzen (ID)", ids.plants),
        field("Boniturwerte (ID)", ids.observations)),
      h("div", { class: "grid-3" }, field("Kulturen (ID, optional)", ids.crops), field("Beetwerk-Sorten (ID, optional)", ids.varieties),
        field("Sätze (ID, optional)", ids.plantings)));
    submit.textContent = mode === "auto" ? "Tabellen anlegen und verbinden" : "Prüfen und verbinden";
    submit.disabled = mode === "auto" && !dbs;
  }

  const ui = shell("Mit Baserow verbinden", {
    onSubmit: async () => {
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = "Einen Moment …";
      try {
        let res;
        if (mode === "auto") {
          res = await api.post("/api/baserow/setup", {
            url: url.value, email: email.value, password: password.value, database_id: Number(dbSel.value),
            variety_table_id: varSel.value ? Number(varSel.value) : null, label_table_id: labelSel.value ? Number(labelSel.value) : null,
          });
        } else {
          const n = (el, what) => {
            const v = Number(el.value);
            if (!Number.isInteger(v) || v < 1) throw new Error(`Bitte die ID der Tabelle „${what}“ eintragen`);
            return v;
          };
          const opt = (el) => (el.value.trim() ? Number(el.value) : null);
          res = await api.post("/api/baserow/connect", {
            url: url.value, token: token.value, traits_table_id: n(ids.traits, "Bonitur-Merkmale"),
            plants_table_id: n(ids.plants, "Bonitur-Pflanzen"), observations_table_id: n(ids.observations, "Boniturwerte"),
            crops_table_id: opt(ids.crops), varieties_table_id: opt(ids.varieties), plantings_table_id: opt(ids.plantings),
          });
        }
        remember(res);
        toast("Mit Baserow verbunden, der erste Abgleich läuft");
        after?.();
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    },
  });
  ui.errorHide = () => ui.body.querySelector(".form-error")?.setAttribute("hidden", "");

  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Art der Einrichtung" },
    ...[["auto", "Tabellen anlegen lassen"], ["manual", "Eigene Tabellen nutzen"]].map(([k, label]) => {
      const input = h("input", { type: "radio", name: "bsr-mode", checked: mode === k });
      input.addEventListener("change", () => { mode = k; paint(); });
      return h("label", {}, input, label);
    }));
  ui.body.append(
    field("Adresse von Baserow", url, "Am besten dieselbe wie im Browser (BASEROW_PUBLIC_URL). „localhost“ geht nicht, Beetwerk läuft in einem eigenen Container."),
    seg, autoBox, manualBox);
  ui.foot.append(h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-quiet", onclick: () => ui.dlg.close() }, "Abbrechen"), submit);
  paint();
  ui.open();
  if (!url.value) url.focus();
}

