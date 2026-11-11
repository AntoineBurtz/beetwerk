"""Folien-Vorlagen: das Pflanzraster von Gewebe- oder Mulchfolie mit vorgestanzten Löchern.

Eine Vorlage hat Reihen (über die Beetbreite), Reihenabstand und Abstand in der Reihe. Sie liegt auf einem
Beet (beds.foil_id); alle Sätze darauf rechnen dann mit ihrem Raster statt mit den Abständen der Kultur –
außer die Kultur passt nicht ins Raster (crops.foil = 0, z. B. Radieschen und Möhren mit engem Abstand in
der Reihe) oder der Satz legt es anders fest (plantings.foil_id: NULL wie das Beet, 0 ohne Folie, sonst
eine Vorlage). Eigene Abstände und Reihen eines Satzes gehen immer vor.

Die Reihen der Folie liegen mittig auf der Beetbreite. Ein Satz, der nur einen Teil der Breite belegt,
bekommt die Reihen, die in seinem Streifen liegen. Gleiche Rechnung wie util.js (foilOf, plantLayout).
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import db, methods

router = APIRouter()

SEEDED_KEY = "foils_seeded"
MIN_PLANT_SPACING = 15  # cm; Kulturen mit engerem Abstand in der Reihe passen nicht ins Raster

SCHEMA = """
CREATE TABLE IF NOT EXISTS foils (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    rows          INTEGER NOT NULL,   -- Lochreihen über die Beetbreite
    row_spacing   INTEGER NOT NULL,   -- cm zwischen den Reihen
    plant_spacing INTEGER NOT NULL,   -- cm zwischen den Löchern einer Reihe
    sort          INTEGER NOT NULL DEFAULT 0
);
"""
BED_COLUMNS = [("foil_id", "INTEGER")]                     # Vorlage, die auf dem Beet liegt
PLANTING_COLUMNS = [("foil_id", "INTEGER")]                # NULL wie das Beet | 0 ohne Folie | Vorlage
CROP_COLUMNS = [("foil", "INTEGER NOT NULL DEFAULT 1")]    # Kultur passt ins Raster einer Folie

# name, Reihen, Reihenabstand, Abstand in der Reihe
DEFAULTS = [("Folie 20 × 20", 3, 20, 20), ("Folie 40 × 40", 2, 40, 40), ("Folie 50 × 50", 1, 50, 50)]


def fits(crop: dict) -> bool:
    """Richtwert: Eine Kultur passt ins Raster, wenn sie in der Reihe mindestens 15 cm Abstand hat."""
    return (crop.get("plant_spacing") or 0) >= MIN_PLANT_SPACING


def init(conn) -> None:
    conn.executescript(SCHEMA)
    for table, columns in (("beds", BED_COLUMNS), ("plantings", PLANTING_COLUMNS), ("crops", CROP_COLUMNS)):
        have = {r["name"] for r in db.rows(conn, f"PRAGMA table_info({table})")}
        for name, ddl in columns:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    seed(conn)


def seed(conn, force: bool = False) -> None:
    """Einmalig: drei Vorlagen als Beispiel und je Kultur, ob sie ins Raster passt."""
    if conn.execute("SELECT 1 FROM settings WHERE key = ?", (SEEDED_KEY,)).fetchone() and not force:
        return
    if conn.execute("SELECT COUNT(*) FROM foils").fetchone()[0] == 0:
        conn.executemany("INSERT INTO foils(name, rows, row_spacing, plant_spacing, sort) VALUES (?, ?, ?, ?, ?)",
                         [(*f, i) for i, f in enumerate(DEFAULTS)])
    conn.execute("UPDATE crops SET foil = CASE WHEN plant_spacing >= ? THEN 1 ELSE 0 END", (MIN_PLANT_SPACING,))
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))


def lists(conn) -> dict:
    return {"foils": db.rows(conn, "SELECT * FROM foils ORDER BY sort, id")}


def by_id(conn) -> dict[int, dict]:
    return {f["id"]: f for f in db.rows(conn, "SELECT * FROM foils")}


def import_tables(conn, data: dict) -> None:
    """Vorlagen aus der Sicherung. Eine ältere Sicherung ohne Folien bekommt die Beispiele und die Richtwerte je Kultur."""
    items = data.get("foils")
    conn.execute("DELETE FROM foils")
    if items is None:
        seed(conn, force=True)
        return
    cols = {r["name"] for r in db.rows(conn, "PRAGMA table_info(foils)")}
    for item in items:
        record = {k: v for k, v in item.items() if k in cols}
        conn.execute(f"INSERT INTO foils({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                     list(record.values()))
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))


# ---------------------------------------------------------------- Rechnen

def of_planting(p: dict, crop: Optional[dict], bed: Optional[dict], foils: dict[int, dict]) -> Optional[dict]:
    """Die Folie, deren Raster für den Satz gilt, oder None."""
    own = p.get("foil_id")
    if own:
        return foils.get(own)
    if own == 0 or not bed or not bed.get("foil_id"):
        return None
    if crop is not None and not crop.get("foil", 1):
        return None
    return foils.get(bed["foil_id"])


def rows_in(foil: dict, total: float, start: float, span: float) -> int:
    """Wie viele Reihen der Folie im Streifen start … start + span liegen (Meter quer zur Reihe).
    Die Folie liegt mittig auf der Breite total. Eine Reihe genau auf der Grenze zählt zum hinteren Streifen."""
    step = foil["row_spacing"] / 100
    first = (total - (foil["rows"] - 1) * step) / 2
    end = start + span
    to_edge = end >= total - 0.005
    n = 0
    for i in range(foil["rows"]):
        pos = first + i * step
        if pos >= start - 0.005 and (pos < end - 0.005 or (to_edge and pos <= total + 0.005)):
            n += 1
    return max(1, n)


def layout(p: dict, crop: dict, bed: Optional[dict], foils: Optional[dict[int, dict]] = None) -> dict:
    """Pflanzbild eines Satzes wie util.js plantLayout: Reihen laufen immer in Beetrichtung, also entlang der
    langen Beetseite (ohne Beet entlang der Länge des Satzes). Abstände: die eigenen des Satzes, sonst das
    Raster der Folie, sonst die der Kultur in der Anbauart des Satzes."""
    usual = methods.for_method(crop, p.get("method"))
    foil = of_planting(p, crop, bed, foils or {})
    row_sp = p.get("row_spacing") or (foil["row_spacing"] if foil else None) or usual["row_spacing"] or 30
    plant_sp = p.get("plant_spacing") or (foil["plant_spacing"] if foil else None) or usual["plant_spacing"] or 30
    offset = p.get("offset") or 0
    span = p["span"] if p.get("span") is not None else (max(0.05, bed["width"] - offset) if bed else 1)
    crosswise = bed is not None and bed["length"] < bed["width"]  # Beet breiter als lang: Reihen entlang der Breite
    long_m, short_m = (span, p["len"]) if crosswise else (p["len"], span)
    if p.get("rows"):
        rows = p["rows"]
    elif foil and not p.get("row_spacing"):
        total = (bed["length"] if crosswise else bed["width"]) if bed else short_m
        at = ((p.get("start") or 0) if crosswise else offset) if bed else 0
        rows = rows_in(foil, total, at, short_m)
    else:
        rows = max(1, int((short_m * 100 + 0.5) // row_sp))
    per_row = max(1, int((long_m * 100 + 0.5) // plant_sp))
    return {"rows": rows, "per_row": per_row, "row_spacing": row_sp, "plant_spacing": plant_sp, "foil": foil}


def pin_past(conn, bed_id: int, old: Optional[int]) -> None:
    """Das Beet bekommt eine andere Folie: Abgeerntete Sätze, die sich nach dem Beet richten, behalten ihr Raster."""
    conn.execute("UPDATE plantings SET foil_id = ? WHERE bed_id = ? AND foil_id IS NULL AND harvest_end < ?",
                 (old or 0, bed_id, date.today().isoformat()))


# ---------------------------------------------------------------- Schnittstelle

class FoilIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    rows: Optional[int] = Field(None, ge=1, le=50)
    row_spacing: Optional[int] = Field(None, ge=1, le=500)
    plant_spacing: Optional[int] = Field(None, ge=1, le=500)
    sort: Optional[int] = None
    bed_ids: Optional[list[int]] = Field(None, max_length=500)  # Beete, auf denen diese Folie liegt


def _get(conn, foil_id: int) -> dict:
    row = conn.execute("SELECT * FROM foils WHERE id = ?", (foil_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Folien-Vorlage nicht gefunden")
    return dict(row)


def _assign(conn, foil_id: int, bed_ids: list[int]) -> None:
    """Die Folie liegt genau auf diesen Beeten: neue dazu, die übrigen verlieren sie."""
    wanted = set(bed_ids)
    for bed in db.rows(conn, "SELECT id, foil_id FROM beds"):
        new = foil_id if bed["id"] in wanted else (None if bed["foil_id"] == foil_id else bed["foil_id"])
        if new != bed["foil_id"]:
            pin_past(conn, bed["id"], bed["foil_id"])
            conn.execute("UPDATE beds SET foil_id = ? WHERE id = ?", (new, bed["id"]))


@router.post("/api/foils", status_code=201)
def create_foil(body: FoilIn):
    record = body.model_dump(exclude_unset=True, exclude_none=True)
    bed_ids = record.pop("bed_ids", None)
    for required in ("name", "rows", "row_spacing", "plant_spacing"):
        if required not in record:
            raise HTTPException(422, f"Feld fehlt: {required}")
    with db.session() as conn:
        if "sort" not in record:
            record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM foils").fetchone()[0]
        cur = conn.execute(f"INSERT INTO foils({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                           list(record.values()))
        if bed_ids is not None:
            _assign(conn, cur.lastrowid, bed_ids)
        return _get(conn, cur.lastrowid)


@router.patch("/api/foils/{foil_id}")
def update_foil(foil_id: int, body: FoilIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    bed_ids = changes.pop("bed_ids", None)
    with db.session() as conn:
        _get(conn, foil_id)
        if changes:
            conn.execute(f"UPDATE foils SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), foil_id])
        if bed_ids is not None:
            _assign(conn, foil_id, bed_ids)
        return _get(conn, foil_id)


@router.delete("/api/foils/{foil_id}", status_code=204)
def delete_foil(foil_id: int):
    """Vorlage löschen. Abgeerntete Sätze behalten ihr Raster als eigene Abstände; Beete und kommende Sätze
    rechnen wieder mit den Abständen der Kultur."""
    with db.session() as conn:
        foil = _get(conn, foil_id)
        foils = {foil_id: foil}
        beds = {b["id"]: b for b in db.rows(conn, "SELECT * FROM beds")}
        crops = {c["id"]: c for c in db.rows(conn, "SELECT * FROM crops")}
        today = date.today().isoformat()
        for p in db.rows(conn, "SELECT * FROM plantings WHERE harvest_end < ?", (today,)):
            crop, bed = crops.get(p["crop_id"]), beds.get(p["bed_id"])
            if not crop or of_planting(p, crop, bed, foils) is None:
                continue
            lay = layout(p, crop, bed, foils)
            conn.execute("UPDATE plantings SET rows = ?, row_spacing = ?, plant_spacing = ? WHERE id = ?",
                         (lay["rows"], lay["row_spacing"], lay["plant_spacing"], p["id"]))
        conn.execute("UPDATE plantings SET foil_id = NULL WHERE foil_id = ?", (foil_id,))
        conn.execute("UPDATE beds SET foil_id = NULL WHERE foil_id = ?", (foil_id,))
        conn.execute("DELETE FROM foils WHERE id = ?", (foil_id,))
    return Response(status_code=204)
