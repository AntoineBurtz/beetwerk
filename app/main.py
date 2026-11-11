"""Beetwerk – Anbauplanung mit Beetkarte und Zeitleiste.

Start lokal:  uvicorn app.main:app --reload
"""
import base64
import json
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import baserow, bonitur, db, feeding, geo, goals, nursery, profile, research, varieties, weather
from .seed import guess_trait_groups, seed_demo

VERSION = "1.1.0"
STATIC_DIR = Path(__file__).resolve().parent / "static"
IMAGE_PATH = db.DATA_DIR / "imagery" / "garden.jpg"
INTERNAL_SETTINGS = {"geo", "imagery_custom", bonitur.SEEDED_KEY, profile.MIGRATED_KEY, nursery.SEEDED_KEY,
                     feeding.SEEDED_KEY, feeding.HERBS_KEY, *weather.STATE_KEYS, *baserow.KEYS, *research.KEYS}
# Nicht in die Sicherung: Abrufzustand und Zugangsdaten
NOT_EXPORTED = {*weather.STATE_KEYS, *baserow.KEYS, *research.KEYS}

@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    baserow.start_background()
    yield


app = FastAPI(title="Beetwerk", version=VERSION, lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json")


# ---------------------------------------------------------------- Zugangsschutz

AUTH_USER = os.environ.get("BEETWERK_USER", "garten")
AUTH_PASSWORD = os.environ.get("BEETWERK_PASSWORD", "")


@app.middleware("http")
async def fresh_ui(request: Request, call_next):
    """Oberfläche immer beim Server nachfragen lassen (dank ETag meist nur ein kurzes 304).

    Sonst kann der Browser nach einem Update alte und neue Programmteile mischen.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    return response


BONITUR_WRITES = re.compile(r"^/api/(observations|plants|traits|plantings|crops|beds|varieties)(/|$)")


@app.middleware("http")
async def baserow_after_change(request: Request, call_next):
    """Nach Änderungen an der Bonitur den Abgleich mit Baserow anstoßen (falls verbunden)."""
    response = await call_next(request)
    if request.method != "GET" and response.status_code < 400 and BONITUR_WRITES.match(request.url.path):
        baserow.schedule()
    return response


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if AUTH_PASSWORD and request.url.path != "/api/health":
        ok = False
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = secrets.compare_digest(user, AUTH_USER) and secrets.compare_digest(pw, AUTH_PASSWORD)
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Beetwerk"'})
    return await call_next(request)


# ---------------------------------------------------------------- Modelle

BedKind = Literal["bed", "raised", "greenhouse", "path", "other"]
Method = Literal["direct", "transplant"]


class BedIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    kind: Optional[BedKind] = None
    x: Optional[float] = None
    y: Optional[float] = None
    length: Optional[float] = Field(None, gt=0, le=500)
    width: Optional[float] = Field(None, gt=0, le=500)
    rotation: Optional[float] = None
    sort: Optional[int] = None
    notes: Optional[str] = None


class CropIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    family: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    method: Optional[Method] = None
    nursery_days: Optional[int] = Field(None, ge=0, le=400)
    field_days: Optional[int] = Field(None, ge=0, le=400)
    harvest_days: Optional[int] = Field(None, ge=0, le=400)
    row_spacing: Optional[int] = Field(None, ge=1, le=500)
    plant_spacing: Optional[int] = Field(None, ge=1, le=500)
    notes: Optional[str] = None
    trait_group: Optional[Literal["", "tomato", "pepper"]] = None  # Bonitur-Merkmale der Kultur
    # Anzucht; bei den Verweisen heißt 0 „keins“
    sow_container_id: Optional[int] = Field(None, ge=0)
    pot_container_id: Optional[int] = Field(None, ge=0)
    prick_days: Optional[int] = Field(None, ge=0, le=200)
    seeds_per_cell: Optional[int] = Field(None, ge=1, le=50)
    germination: Optional[int] = Field(None, ge=1, le=100)
    reserve: Optional[int] = Field(None, ge=0, le=300)
    warm: Optional[bool] = None
    harden_days: Optional[int] = Field(None, ge=0, le=60)
    place_id: Optional[int] = Field(None, ge=0)
    grow_place_id: Optional[int] = Field(None, ge=0)
    # Düngung
    feed: Optional[Literal["", "none", "low", "medium", "high"]] = None
    feed_n: Optional[float] = Field(None, ge=0, le=60)       # eigene Menge in g N/m², 0 = Menge der Stufe
    feed_cut: Optional[bool] = None
    feed_start: Optional[int] = Field(None, ge=0, le=120)
    feed_late: Optional[bool] = None
    feed_src: Optional[str] = Field(None, max_length=60)


class VarietyIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    count: int = Field(ge=1, le=9999)
    ref: Optional[str] = Field(None, max_length=200)  # später: Verweis auf die Sortendatenbank

    @field_validator("name")
    @classmethod
    def _strip(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Sortenname fehlt")
        return v


class PlantingIn(BaseModel):
    crop_id: Optional[int] = None
    variety: Optional[str] = None
    bed_id: Optional[int] = None
    method: Optional[Method] = None
    sow_date: Optional[str] = None
    plant_date: Optional[str] = None
    harvest_start: Optional[str] = None
    harvest_end: Optional[str] = None
    start: Optional[float] = Field(None, ge=0)
    len: Optional[float] = Field(None, gt=0)
    offset: Optional[float] = Field(None, ge=0)
    span: Optional[float] = Field(None, gt=0)
    rows: Optional[int] = Field(None, ge=1, le=200)
    row_spacing: Optional[int] = Field(None, ge=1, le=500)
    plant_spacing: Optional[int] = Field(None, ge=1, le=500)
    sown_done: Optional[bool] = None
    planted_done: Optional[bool] = None
    harvest_done: Optional[bool] = None
    notes: Optional[str] = None
    # Mischsatz: mehrere Sorten in einem Satz, gemeinsame Termine und Abstände
    varieties: Optional[list[VarietyIn]] = Field(None, max_length=200)
    fill: Optional[Literal["snake", "columns"]] = None
    fill_start: Optional[Literal["tl", "tr", "bl", "br"]] = None
    no_feed: Optional[bool] = None                           # diesen Satz nicht düngen
    fed: Optional[dict[str, str]] = Field(None, max_length=20)  # erledigte Düngergaben: Nummer der Gabe -> Datum

    @field_validator("sow_date", "plant_date", "harvest_start", "harvest_end")
    @classmethod
    def _iso_date(cls, v):
        if v in (None, ""):
            return None
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError("Datum im Format JJJJ-MM-TT angeben") from exc
        return v


class SettingsIn(BaseModel):
    garden_name: Optional[str] = Field(None, max_length=80)
    garden_width: Optional[float] = Field(None, gt=0, le=1000)
    garden_height: Optional[float] = Field(None, gt=0, le=1000)
    rotation_years: Optional[int] = Field(None, ge=0, le=10)
    weather_enabled: Optional[Literal["0", "1"]] = None
    weather_soil: Optional[Literal["sand", "loamy_sand", "loam"]] = None
    weather_frost: Optional[Literal["-2", "0", "2"]] = None
    weather_lat: Optional[float] = Field(None, ge=-90, le=90)
    weather_lon: Optional[float] = Field(None, ge=-180, le=180)
    bed_mode: Optional[Literal["uniform", "individual"]] = None
    bed_width: Optional[float] = Field(None, ge=0.2, le=10)
    beds_locked: Optional[Literal["0", "1"]] = None
    fert_id: Optional[int] = Field(None, ge=1)
    feed_factor: Optional[Literal["25", "50", "75", "100"]] = None


class CustomSource(BaseModel):
    type: Literal["wms", "xyz"]
    url: str = Field(min_length=8, max_length=500)
    layers: str = Field("", max_length=200)
    attribution: str = Field("", max_length=200)
    max_zoom: int = Field(19, ge=10, le=22)


class GeoIn(BaseModel):
    boundary: list[tuple[float, float]] = Field(min_length=3, max_length=200)
    bearing: float
    source: str = "bayern-dop20"
    custom: Optional[CustomSource] = None
    # Ausrichtung: gewählte Seite (Index der Kante ab Ecke i) und wo sie in der Beetkarte liegt
    orient: Literal["edge", "north"] = "edge"
    ref_edge: Optional[int] = Field(None, ge=0)
    ref_side: Optional[Literal["bottom", "left", "right", "top"]] = None
    anchor: Optional[int] = Field(None, ge=0)

    @field_validator("boundary")
    @classmethod
    def _coords(cls, v):
        for lat, lon in v:
            if not (-85 <= lat <= 85 and -180 <= lon <= 180):
                raise ValueError("Koordinaten außerhalb des gültigen Bereichs")
        return v


class ImageIn(BaseModel):
    source: str = "bayern-dop20"
    custom: Optional[CustomSource] = None


BED_DEFAULTS = dict(name="Neues Beet", kind="bed", x=1.0, y=1.0, length=4.0, width=1.2, rotation=0.0, sort=0, notes="")
CROP_DEFAULTS = dict(name="Neue Kultur", family="", color="#6a9b3c", method="direct", nursery_days=0,
                     field_days=60, harvest_days=21, row_spacing=30, plant_spacing=30, notes="", trait_group="",
                     feed="", feed_n=0, feed_cut=0, feed_start=0, feed_late=0, feed_src="")
PLANTING_DEFAULTS = dict(variety="", bed_id=None, method="direct", plant_date=None, start=0.0, len=1.0,
                         offset=0.0, span=None, rows=None, row_spacing=None, plant_spacing=None,
                         sown_done=False, planted_done=False, harvest_done=False, notes="",
                         varieties="", fill="snake", fill_start="tl", no_feed=False, fed="")


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _get(conn, table: str, item_id: int) -> dict:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        _err(404, "Eintrag nicht gefunden")
    return dict(row)


def _insert(conn, table: str, record: dict) -> int:
    cols = [k for k in record if k != "id"]
    cur = conn.execute(
        f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        [record[c] for c in cols],
    )
    return cur.lastrowid


def _update(conn, table: str, item_id: int, changes: dict) -> None:
    if not changes:
        return
    conn.execute(
        f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
        [*changes.values(), item_id],
    )


def _encode_varieties(record: dict) -> dict:
    """Sortenliste als JSON-Text speichern; leere Liste = einfacher Satz."""
    if "varieties" in record:
        v = record["varieties"]
        record["varieties"] = json.dumps(v, ensure_ascii=False, separators=(",", ":")) if v else ""
    if "fed" in record and not isinstance(record["fed"], str):
        record["fed"] = json.dumps(record["fed"], separators=(",", ":")) if record["fed"] else ""
    return record


def _planting_out(row: dict) -> dict:
    raw = row.get("varieties")
    try:
        row["varieties"] = json.loads(raw) if raw else []
    except ValueError:
        row["varieties"] = []
    try:
        row["fed"] = json.loads(row["fed"]) if row.get("fed") else {}
    except ValueError:
        row["fed"] = {}
    return row


def _get_planting(conn, planting_id: int) -> dict:
    return _planting_out(_get(conn, "plantings", planting_id))


def _bool_flags(record: dict) -> dict:
    for k in ("sown_done", "planted_done", "harvest_done", "no_feed"):
        if k in record and record[k] is not None:
            record[k] = int(bool(record[k]))
    return record


def _check_planting(conn, p: dict) -> dict:
    """Prüft einen vollständigen Satz und normalisiert ihn."""
    if conn.execute("SELECT 1 FROM crops WHERE id = ?", (p["crop_id"],)).fetchone() is None:
        _err(422, "Diese Kultur gibt es nicht")
    if p.get("bed_id") is not None and conn.execute("SELECT 1 FROM beds WHERE id = ?", (p["bed_id"],)).fetchone() is None:
        _err(422, "Dieses Beet gibt es nicht")
    if p["method"] == "direct":
        p["plant_date"] = None
    elif not p.get("plant_date"):
        _err(422, "Für Anzucht mit Pflanzung fehlt das Pflanzdatum")
    order = [p["sow_date"], p["plant_date"], p["harvest_start"], p["harvest_end"]]
    order = [d for d in order if d]
    if order != sorted(order):
        _err(422, "Termine müssen in der Reihenfolge Aussaat, Pflanzung, Erntebeginn, Ernteende liegen")
    return p


# ---------------------------------------------------------------- Lesen

@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION}


def _settings(conn) -> dict:
    return {r["key"]: r["value"] for r in db.rows(conn, "SELECT key, value FROM settings")}


def _set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def _geo_public(g: Optional[dict]) -> Optional[dict]:
    """Grundstück für die Oberfläche: Luftbild mit Lage im aktuellen Koordinatensystem."""
    if not g:
        return None
    out = {k: v for k, v in g.items() if k != "image"}
    img = g.get("image")
    out["image"] = None
    out["image_missing"] = False
    if img:
        if IMAGE_PATH.exists():
            f = geo.frame_from(g)
            s_, w_, n_, e_ = img["bbox"]
            e0, n0 = f.to_enu(s_, w_)
            e1, n1 = f.to_enu(n_, e_)
            out["image"] = {**img, "enu": [e0, n0, e1, n1], "url": f"/api/garden/image?v={img['fetched_at']}"}
        else:
            out["image_missing"] = True
    return out


def _imagery(raw: dict) -> dict:
    sources = [{"id": k, **v} for k, v in geo.SOURCES.items()]
    overlays = [{"id": k, **v} for k, v in geo.OVERLAYS.items()]
    return {"sources": sources, "overlays": overlays, "custom": geo.loads(raw.get("imagery_custom"))}


@app.get("/api/data")
def all_data():
    with db.session() as conn:
        raw = _settings(conn)
        return {
            "settings": {k: v for k, v in raw.items() if k not in INTERNAL_SETTINGS},
            "geo": _geo_public(geo.loads(raw.get("geo"))),
            "imagery": _imagery(raw),
            "beds": db.rows(conn, "SELECT * FROM beds ORDER BY sort, name"),
            "crops": db.rows(conn, "SELECT * FROM crops ORDER BY name"),
            "plantings": [_planting_out(p) for p in db.rows(conn, "SELECT * FROM plantings ORDER BY sow_date, id")],
            "varieties": [varieties.variety_out(v) for v in db.rows(conn, "SELECT * FROM varieties ORDER BY name COLLATE NOCASE")],
            **nursery.lists(conn),
            **goals.lists(conn),
            **feeding.lists(conn),
        }


# ---------------------------------------------------------------- Beete

@app.post("/api/beds", status_code=201)
def create_bed(body: BedIn):
    record = {**BED_DEFAULTS, **body.model_dump(exclude_unset=True, exclude_none=True)}
    with db.session() as conn:
        if "sort" not in body.model_fields_set:
            record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM beds").fetchone()[0]
        width = db.uniform_width(conn)
        if width and record["kind"] == "bed":
            record.update(_fit_geometry(record, width)[0])
        new_id = _insert(conn, "beds", record)
        return _get(conn, "beds", new_id)


@app.patch("/api/beds/{bed_id}")
def update_bed(bed_id: int, body: BedIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with db.session() as conn:
        _get(conn, "beds", bed_id)
        _update(conn, "beds", bed_id, changes)
        bed = _get(conn, "beds", bed_id)
        width = db.uniform_width(conn)
        if width and bed["kind"] == "bed":
            bed = _fit_bed(conn, bed, width)
        return bed


# ---------------------------------------------------------------- Einheitliche Beetbreite

def _fit_geometry(b: dict, width: float) -> tuple[dict, bool]:
    """Lage eines Beets mit Einheitsbreite: die lange Seite wird zur Länge (sonst um 90° gedreht), die Mitte bleibt."""
    length, w0, rot = b["length"], b["width"], b.get("rotation") or 0.0
    cx, cy = b["x"] + length / 2, b["y"] + w0 / 2
    turned = length < w0 and w0 > width + 1e-9
    if turned:
        length, rot = w0, (rot + 90) % 360
    return {"length": round(length, 2), "width": round(width, 2), "rotation": round(rot, 2),
            "x": round(cx - length / 2, 2), "y": round(cy - width / 2, 2)}, turned


def _fit_bed(conn, bed: dict, width: float) -> dict:
    """Beet auf die Einheitsbreite bringen. Sätze darin ziehen mit: beim Drehen wird quer zu längs."""
    new, turned = _fit_geometry(bed, width)
    if all(abs((bed[k] or 0) - v) < 1e-6 for k, v in new.items()):
        return bed
    length0, width0 = bed["length"], bed["width"]
    for p in db.rows(conn, "SELECT id, start, len, offset, span FROM plantings WHERE bed_id = ?", (bed["id"],)):
        start, ln, off = p["start"] or 0.0, p["len"], p["offset"] or 0.0
        full = p["span"] is None and off == 0
        span = p["span"] if p["span"] is not None else max(0.05, width0 - off)
        if turned:
            start, ln, off, span = off, span, max(0.0, length0 - start - ln), ln
            full = False
        span = min(span, width)
        off = min(max(off, 0.0), max(0.0, width - span))
        full = full or span >= width - 0.001
        _update(conn, "plantings", p["id"], {"start": round(start, 2), "len": round(ln, 2),
                                             "offset": 0.0 if full else round(off, 2), "span": None if full else round(span, 2)})
    _update(conn, "beds", bed["id"], new)
    return _get(conn, "beds", bed["id"])


def _fit_all_beds(conn) -> None:
    width = db.uniform_width(conn)
    if width:
        for bed in db.rows(conn, "SELECT * FROM beds WHERE kind = 'bed'"):
            _fit_bed(conn, bed, width)


@app.delete("/api/beds/{bed_id}", status_code=204)
def delete_bed(bed_id: int):
    with db.session() as conn:
        _get(conn, "beds", bed_id)
        conn.execute("UPDATE plantings SET bed_id = NULL WHERE bed_id = ?", (bed_id,))
        conn.execute("UPDATE goals SET bed_id = NULL, block_start = NULL, block_len = NULL WHERE bed_id = ?", (bed_id,))
        conn.execute("DELETE FROM beds WHERE id = ?", (bed_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Kulturen

def _crop_refs(conn, record: dict) -> dict:
    """Gefäße und Plätze der Anzucht: 0 heißt keins, sonst muss es sie geben."""
    for k in ("warm", "feed_cut", "feed_late"):
        if k in record:
            record[k] = int(bool(record[k]))
    for k, table, what in (("sow_container_id", "containers", "Dieses Gefäß"), ("pot_container_id", "containers", "Dieses Gefäß"),
                           ("place_id", "places", "Diesen Anzuchtplatz"), ("grow_place_id", "places", "Diesen Anzuchtplatz")):
        if k in record:
            if not record[k]:
                record[k] = None
            elif conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (record[k],)).fetchone() is None:
                _err(422, f"{what} gibt es nicht")
    return record


@app.post("/api/crops", status_code=201)
def create_crop(body: CropIn):
    record = {**CROP_DEFAULTS, **body.model_dump(exclude_unset=True, exclude_none=True)}
    with db.session() as conn:
        _crop_refs(conn, record)
        new_id = _insert(conn, "crops", record)
        return _get(conn, "crops", new_id)


@app.patch("/api/crops/{crop_id}")
def update_crop(crop_id: int, body: CropIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with db.session() as conn:
        _get(conn, "crops", crop_id)
        _crop_refs(conn, changes)
        _update(conn, "crops", crop_id, changes)
        return _get(conn, "crops", crop_id)


@app.delete("/api/crops/{crop_id}", status_code=204)
def delete_crop(crop_id: int):
    with db.session() as conn:
        _get(conn, "crops", crop_id)
        used = conn.execute("SELECT COUNT(*) FROM plantings WHERE crop_id = ?", (crop_id,)).fetchone()[0]
        if used:
            _err(409, f"Die Kultur wird noch in {used} {'Satz' if used == 1 else 'Sätzen'} verwendet")
        listed = conn.execute("SELECT COUNT(*) FROM varieties WHERE crop_id = ?", (crop_id,)).fetchone()[0]
        if listed:
            _err(409, f"Zu dieser Kultur stehen noch {listed} {'Sorte' if listed == 1 else 'Sorten'} in der Sortenliste")
        aimed = conn.execute("SELECT COUNT(*) FROM goals WHERE crop_id = ?", (crop_id,)).fetchone()[0]
        if aimed:
            _err(409, f"Für diese Kultur gibt es noch {aimed} {'Ernteziel' if aimed == 1 else 'Ernteziele'}")
        wished = conn.execute("SELECT COUNT(*) FROM handovers WHERE crop_id = ?", (crop_id,)).fetchone()[0]
        if wished:
            _err(409, f"Für diese Kultur gibt es noch {wished} {'Wunsch' if wished == 1 else 'Wünsche'} von Freunden")
        conn.execute("DELETE FROM nursery WHERE crop_id = ?", (crop_id,))
        bonitur._forget(conn, "crops", _get(conn, "crops", crop_id))
        conn.execute("DELETE FROM crops WHERE id = ?", (crop_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Sätze

@app.post("/api/plantings", status_code=201)
def create_planting(body: PlantingIn):
    given = _bool_flags(body.model_dump(exclude_unset=True))
    for required in ("crop_id", "sow_date", "harvest_start", "harvest_end"):
        if not given.get(required):
            _err(422, f"Feld fehlt: {required}")
    record = {**PLANTING_DEFAULTS, **given}
    _bool_flags(record)
    _encode_varieties(record)
    for k in ("fill", "fill_start"):
        if record.get(k) is None:
            record[k] = PLANTING_DEFAULTS[k]
    with db.session() as conn:
        _check_planting(conn, record)
        new_id = _insert(conn, "plantings", record)
        return _get_planting(conn, new_id)


@app.patch("/api/plantings/{planting_id}")
def update_planting(planting_id: int, body: PlantingIn):
    # Hier zählt auch ein explizites null (z. B. Beet entfernen, Reihen auf automatisch)
    changes = _bool_flags(body.model_dump(exclude_unset=True))
    for not_null in ("crop_id", "method", "sow_date", "harvest_start", "harvest_end", "start", "len", "offset",
                     "fill", "fill_start"):
        if not_null in changes and changes[not_null] is None:
            changes.pop(not_null)
    _encode_varieties(changes)
    with db.session() as conn:
        current = _get(conn, "plantings", planting_id)
        merged = _check_planting(conn, {**current, **changes})
        if "method" in changes or "plant_date" in changes:
            changes["plant_date"] = merged["plant_date"]
        _update(conn, "plantings", planting_id, changes)
        return _get_planting(conn, planting_id)


@app.delete("/api/plantings/{planting_id}", status_code=204)
def delete_planting(planting_id: int):
    with db.session() as conn:
        _get(conn, "plantings", planting_id)
        used = conn.execute("SELECT COUNT(*) FROM observations WHERE planting_id = ?", (planting_id,)).fetchone()[0]
        if used:
            _err(409, f"Für diesen Satz gibt es {used} {'Boniturwert' if used == 1 else 'Boniturwerte'}. "
                      "Lösche zuerst die Werte in der Bonitur oder behalte den Satz.")
        for plant in db.rows(conn, "SELECT * FROM plants WHERE planting_id = ?", (planting_id,)):
            bonitur._forget(conn, "plants", plant)
        bonitur._forget(conn, "plantings", _get(conn, "plantings", planting_id))
        conn.execute("DELETE FROM plants WHERE planting_id = ?", (planting_id,))
        conn.execute("DELETE FROM plantings WHERE id = ?", (planting_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Einstellungen, Sicherung

@app.patch("/api/settings")
def update_settings(body: SettingsIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with db.session() as conn:
        for key, value in changes.items():
            _set(conn, key, str(value))
        if "bed_mode" in changes or "bed_width" in changes:
            _fit_all_beds(conn)  # alle Beete auf die gleiche Breite, die Oberfläche lädt danach neu
        return {k: v for k, v in _settings(conn).items() if k not in INTERNAL_SETTINGS}


# ---------------------------------------------------------------- Wetter

@app.get("/api/weather")
def weather_year(year: int, refresh: bool = False):
    """Tageswerte (Niederschlag, Temperatur, Verdunstung) für ein Jahr, soweit vorhanden."""
    if not 1950 <= year <= 2100:
        _err(400, "Ungültiges Jahr")
    return weather.year_data(year, force=refresh)


@app.get("/api/frost")
def frost(threshold: Optional[float] = None):
    """Letzter Frost im Frühjahr und erster im Herbst für die letzten 20 Jahre, mit Statistik."""
    if threshold is not None and threshold not in weather.FROST_THRESHOLDS:
        _err(400, "Frostgrenze muss -2, 0 oder 2 °C sein")
    return weather.frost_data(threshold)


@app.get("/api/climate")
def climate():
    """Mittelwerte der letzten 20 Jahre: je Tag (geglättet) und je Monat."""
    return weather.climate_data()


@app.get("/api/export")
def export_all():
    data = all_data()
    with db.session() as conn:
        data["settings"] = {k: v for k, v in _settings(conn).items() if k not in NOT_EXPORTED}
        data.update(bonitur.export_tables(conn))
        data.update(nursery.export_tables(conn))
    data.pop("geo", None)
    data.pop("imagery", None)
    data["format"] = "beetwerk"
    data["version"] = 1
    filename = f"beetwerk-{date.today().isoformat()}.json"
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/api/import")
async def import_all(request: Request):
    try:
        data = await request.json()
    except Exception:
        _err(400, "Die Datei ist kein gültiges JSON")
    if not isinstance(data, dict) or data.get("format") != "beetwerk":
        _err(400, "Das ist keine Beetwerk-Sicherung")
    with db.session() as conn:
        bonitur.clear_tables(conn)
        nursery.clear_tables(conn)
        conn.execute("DELETE FROM goals")
        conn.execute("DELETE FROM plantings")
        conn.execute("DELETE FROM beds")
        conn.execute("DELETE FROM varieties")
        conn.execute("DELETE FROM crops")
        keep = {k: v for k, v in _settings(conn).items() if k in baserow.KEYS or k in research.KEYS}
        conn.execute("DELETE FROM settings")
        conn.execute("DELETE FROM sqlite_sequence")
        for key, value in (data.get("settings") or {}).items():
            if key in NOT_EXPORTED:
                continue
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?)", (key, str(value)))
        for table in ("containers", "places", "crops", "goals", "varieties", "beds", "plantings", *nursery.BACKUP_TABLES[2:]):
            cols = {r["name"] for r in db.rows(conn, f"PRAGMA table_info({table})")}
            for item in data.get(table) or []:
                record = {k: v for k, v in item.items() if k in cols}
                if table == "plantings" and (isinstance(record.get("varieties"), list) or isinstance(record.get("fed"), dict)):
                    _encode_varieties(record)
                if table == "varieties" and isinstance(record.get("links"), list):
                    record["links"] = json.dumps(record["links"], ensure_ascii=False) if record["links"] else ""
                if table == "goals" and isinstance(record.get("weeks"), dict):
                    record["weeks"] = json.dumps(record["weeks"])
                if table == "varieties" and isinstance(record.get("profile"), dict):
                    record["profile"] = json.dumps(record["profile"], ensure_ascii=False) if record["profile"] else ""
                conn.execute(
                    f"INSERT INTO {table}({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                    list(record.values()),
                )
        if any("trait_group" not in c for c in data.get("crops") or []):
            guess_trait_groups(conn)  # ältere Sicherung ohne Bonitur-Zuordnung
        bonitur.import_tables(conn, data)
        profile.migrate_legacy(conn)  # ältere Sicherung mit Wuchs, Fruchtfarbe und Reife als Freitext
        nursery.seed(conn)  # ältere Sicherung ohne Anzucht: Gefäße und Richtwerte
        feeding.import_tables(conn, data)  # Düngerliste; ältere Sicherung ohne Düngung: Stufen nach dem Namen
        for key, value in {**db.DEFAULT_SETTINGS, **keep}.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
    return all_data()


@app.post("/api/demo")
def load_demo(replace: bool = False):
    with db.session() as conn:
        has_beds = conn.execute("SELECT COUNT(*) FROM beds").fetchone()[0] > 0
        if has_beds and not replace:
            _err(409, "Es gibt schon Beete. Zum Ersetzen replace=true mitschicken.")
        bonitur.clear_tables(conn)
        conn.execute("DELETE FROM goals")
        conn.execute("DELETE FROM plantings")
        conn.execute("DELETE FROM beds")
        if not geo.loads(_settings(conn).get("geo")):
            _set(conn, "garden_width", "16")
            _set(conn, "garden_height", "11")
        seed_demo(conn)
        _fit_all_beds(conn)
    return all_data()


# ---------------------------------------------------------------- Grundstück und Luftbild

def _source_for(conn, source: str, custom: Optional[CustomSource]) -> dict:
    if source == "custom":
        if custom is not None:
            _set(conn, "imagery_custom", geo.dumps(custom.model_dump()))
        stored = geo.loads(_settings(conn).get("imagery_custom"))
        return geo.resolve_source("custom", stored)
    return geo.resolve_source(source, None)


@app.put("/api/garden/geo")
def set_garden_geo(body: GeoIn):
    """Grenze speichern, Beete mitnehmen und Luftbild holen."""
    try:
        new = geo.build_geo([tuple(p) for p in body.boundary], body.bearing, body.anchor)
        with db.session() as conn:
            src = _source_for(conn, body.source, body.custom)
            old = geo.loads(_settings(conn).get("geo"))
    except geo.GeoError as exc:
        _err(422, str(exc))
    new["source"] = body.source
    new["orient"] = body.orient
    if body.orient == "edge" and body.ref_edge is not None and body.ref_edge < len(body.boundary):
        new["ref_edge"] = body.ref_edge
        new["ref_side"] = body.ref_side or "bottom"

    warning = None
    if src.get("snapshot", True):
        try:
            new["image"] = geo.fetch_snapshot(new, src, IMAGE_PATH)
        except geo.GeoError as exc:
            warning = f"{exc}. Die Grenze ist gespeichert, das Luftbild kannst du später neu laden."
    if "image" not in new and old and old.get("image"):
        new["image"] = old["image"]  # altes Bild liegt geografisch weiter richtig

    with db.session() as conn:
        if old:
            f_old, f_new = geo.frame_from(old), geo.frame_from(new)
            for bed in db.rows(conn, "SELECT id, x, y, length, width, rotation FROM beds"):
                _update(conn, "beds", bed["id"], geo.reanchor_bed(bed, f_old, f_new))
        _set(conn, "geo", geo.dumps(new))
        _set(conn, "garden_width", str(round(new["width"], 1)))
        _set(conn, "garden_height", str(round(new["height"], 1)))
    return {**all_data(), "warning": warning}


@app.post("/api/garden/image")
def refresh_garden_image(body: ImageIn):
    with db.session() as conn:
        g = geo.loads(_settings(conn).get("geo"))
        if not g:
            _err(409, "Zuerst die Grundstücksgrenze festlegen")
        try:
            src = _source_for(conn, body.source, body.custom)
        except geo.GeoError as exc:
            _err(422, str(exc))
    try:
        g["image"] = geo.fetch_snapshot(g, src, IMAGE_PATH)
    except geo.GeoError as exc:
        _err(502, str(exc))
    g["source"] = body.source
    with db.session() as conn:
        _set(conn, "geo", geo.dumps(g))
    return all_data()


@app.get("/api/garden/image")
def garden_image():
    if not IMAGE_PATH.exists():
        _err(404, "Kein Luftbild gespeichert")
    return FileResponse(IMAGE_PATH, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.delete("/api/garden/geo")
def delete_garden_geo():
    with db.session() as conn:
        conn.execute("DELETE FROM settings WHERE key = 'geo'")
    IMAGE_PATH.unlink(missing_ok=True)
    return all_data()


# ---------------------------------------------------------------- Bonitur und Oberfläche

app.include_router(bonitur.router)
app.include_router(baserow.router)
app.include_router(varieties.router)
app.include_router(nursery.router)
app.include_router(goals.router)
app.include_router(feeding.router)
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
