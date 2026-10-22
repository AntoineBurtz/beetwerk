import { h } from "./util.js";

export function toast(message, { error = false, action, onAction, ms } = {}) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: `toast${error ? " error" : ""}` }, h("span", {}, message));
  if (action) {
    el.append(h("button", { type: "button", onclick: () => { el.remove(); onAction?.(); } }, action));
  }
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.remove(), ms ?? (action ? 6000 : error ? 5000 : 2600));
}

export function confirmDialog(text, { ok = "Löschen", danger = true, title = "Bist du sicher?" } = {}) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "confirm-dlg" });
    const form = h("form", { method: "dialog" },
      h("div", { class: "dlg-head" }, h("h2", {}, title)),
      h("div", { class: "dlg-body" }, h("p", { style: { margin: 0 } }, text)),
      h("div", { class: "dlg-foot" },
        h("span", { class: "spacer" }),
        h("button", { class: "btn btn-quiet", value: "cancel" }, "Abbrechen"),
        h("button", { class: danger ? "btn btn-primary danger-ok" : "btn btn-primary", value: "ok",
          style: danger ? { background: "var(--alert)", borderColor: "var(--alert)" } : null }, ok)));
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); });
    dlg.showModal();
  });
}

const ICONS = {
  plus: "M10 4v12 M4 10h12",
  minus: "M4 10h12",
  fit: "M3 7V3h4 M13 3h4v4 M17 13v4h-4 M7 17H3v-4",
  left: "M12 4l-6 6 6 6",
  right: "M8 4l6 6-6 6",
  edit: "M4 16l1-4 8-8 3 3-8 8z",
  copy: "M7 7h9v9H7z M4 13V4h9",
  trash: "M4 6h12 M8 6V4h4v2 M6 6l1 11h6l1-11",
  close: "M5 5l10 10 M15 5L5 15",
  rotate: "M15 6a6 6 0 1 0 1.5 5 M15 2v4h-4",
  layers: "M10 3l7 4-7 4-7-4z M3 11l7 4 7-4",
  parcel: "M4 6l7-3 6 5-2 9-10-2z",
};

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function iconBtn(name, label, onclick, extra = {}) {
  return h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick, ...extra }, icon(name));
}
