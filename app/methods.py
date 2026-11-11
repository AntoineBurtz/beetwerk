"""Anbauart: Jede Kultur hat eine übliche Anbauart (Direktsaat oder Voranzucht) und kann auch die andere haben.

Die Spalten field_days, row_spacing und plant_spacing gelten für die übliche Anbauart. Für die andere stehen
eigene Werte in alt_field_days, alt_row_spacing und alt_plant_spacing; 0 heißt: nicht eingetragen. Dann gelten
dieselben Abstände, und die Kulturdauer wird geschätzt:
  Direktsaat statt Voranzucht:  Tage im Beet + Anzuchtdauer - 7   (die Pflanze wächst die Anzuchtzeit im Beet,
                                                                   spart aber den Pflanzschock)
  Voranzucht statt Direktsaat:  Tage im Beet - Anzuchtdauer + 7,  mindestens 14
Die Schätzung ist eine Faustregel dieser Software, keine Angabe aus einer Quelle. Die Oberfläche rechnet in
util.js (cropFor) genauso.
"""
from __future__ import annotations

from . import db

SEEDED_KEY = "methods_seeded"
NURSERY_FALLBACK = 28   # Anzuchtdauer, wenn bei einer Direktsaat-Kultur keine eingetragen ist
SHOCK_DAYS = 7

CROP_COLUMNS = [
    ("alt", "INTEGER NOT NULL DEFAULT 0"),                 # die andere Anbauart ist ebenfalls gängig
    ("alt_field_days", "INTEGER NOT NULL DEFAULT 0"),      # Tage im Beet bis zur Ernte bei der anderen Anbauart; 0 = geschätzt
    ("alt_row_spacing", "INTEGER NOT NULL DEFAULT 0"),     # Abstände bei der anderen Anbauart; 0 = wie üblich
    ("alt_plant_spacing", "INTEGER NOT NULL DEFAULT 0"),
]

# Kulturen, bei denen beide Anbauarten gängig sind (am Namen erkannt). Für Kräuter nach der Tabelle
# „Gemüse, Obst & Co.“ des aid (2017), die Anzucht und Direktsaat nebeneinander nennt; sonst gärtnerische Praxis.
BOTH = ("salat", "endivie", "kohlrabi", "grünkohl", "mangold", "fenchel", "gurke", "zucchini", "kürbis", "mais",
        "rote bete", "spinat", "bohne", "erbse", "zwiebel", "petersilie", "basilikum", "dill", "koriander",
        "schnittlauch", "bohnenkraut", "rucola")


def for_method(crop: dict, method: str | None = None) -> dict:
    """Die Kultur mit den Werten der gewünschten Anbauart: method, nursery_days, field_days, Abstände.
    estimated sagt, ob die Kulturdauer geschätzt ist."""
    usual = crop.get("method")
    if not method or not usual or method == usual:
        return {**crop, "estimated": False}
    nursery = crop["nursery_days"] or NURSERY_FALLBACK
    own = crop.get("alt_field_days") or 0
    if method == "transplant":
        days = own or max(14, (crop["field_days"] or 0) - nursery + SHOCK_DAYS)
    else:
        days = own or (crop["field_days"] or 0) + max(0, (crop["nursery_days"] or 0) - SHOCK_DAYS)
    return {**crop, "method": method, "nursery_days": nursery if method == "transplant" else crop["nursery_days"],
            "field_days": days, "row_spacing": crop.get("alt_row_spacing") or crop["row_spacing"],
            "plant_spacing": crop.get("alt_plant_spacing") or crop["plant_spacing"], "estimated": not own}


def can_transplant(crop: dict) -> bool:
    return crop["method"] == "transplant" or bool(crop.get("alt"))


def init(conn) -> set[int]:
    have = {r[1] for r in conn.execute("PRAGMA table_info(crops)")}
    for name, decl in CROP_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE crops ADD COLUMN {name} {decl}")
    return seed(conn)


def both_common(name: str) -> bool:
    low = (name or "").lower()
    return any(word in low for word in BOTH)


def after_import(conn, data: dict) -> set[int]:
    """Eine Sicherung von vor dieser Funktion kennt die zweite Anbauart nicht: dann nach dem Namen vermerken."""
    known = any("alt" in c for c in data.get("crops") or [])
    if known:
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))
        return set()
    return seed(conn, force=True)


def seed(conn, force: bool = False) -> set[int]:
    """Einmal vermerken, bei welchen Kulturen beide Anbauarten gängig sind. Gibt zurück, welche Kulturen dabei
    erstmals vorgezogen werden können – sie brauchen noch Richtwerte für die Anzucht. Dazu zählen die später
    ergänzten Kräuter, die zur Voranzucht noch kein Gefäß haben."""
    if not force and conn.execute("SELECT 1 FROM settings WHERE key = ?", (SEEDED_KEY,)).fetchone():
        return set()
    from .feeding import HERBS
    fresh = set()
    for c in db.rows(conn, "SELECT * FROM crops"):  # die Spalten der Anzucht gibt es beim allerersten Start noch nicht
        if not c["alt"] and both_common(c["name"]):
            conn.execute("UPDATE crops SET alt = 1 WHERE id = ?", (c["id"],))
            if c["method"] == "direct":  # kann jetzt erstmals vorgezogen werden
                fresh.add(c["id"])
        if c["name"] in HERBS and c["method"] == "transplant" and not c.get("sow_container_id"):
            fresh.add(c["id"])
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))
    return fresh
