"""Beetwerk – Anbauplanung mit Beetkarte und Zeitleiste.

Start lokal:  uvicorn app.main:app --reload
"""
import base64
import os
import secrets
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import db
from .seed import seed_demo

VERSION = "1.0.0"
STATIC_DIR = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Beetwerk", version=VERSION, lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json")


# ---------------------------------------------------------------- Zugangsschutz

AUTH_USER = os.environ.get("BEETWERK_USER", "garten")
AUTH_PASSWORD = os.environ.get("BEETWERK_PASSWORD", "")


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


BED_DEFAULTS = dict(name="Neues Beet", kind="bed", x=1.0, y=1.0, length=4.0, width=1.2, rotation=0.0, sort=0, notes="")
CROP_DEFAULTS = dict(name="Neue Kultur", family="", color="#6a9b3c", method="direct", nursery_days=0,
                     field_days=60, harvest_days=21, row_spacing=30, plant_spacing=30, notes="")
PLANTING_DEFAULTS = dict(variety="", bed_id=None, method="direct", plant_date=None, start=0.0, len=1.0,
                         offset=0.0, span=None, rows=None, row_spacing=None, plant_spacing=None,
                         sown_done=False, planted_done=False, harvest_done=False, notes="")


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


def _bool_flags(record: dict) -> dict:
    for k in ("sown_done", "planted_done", "harvest_done"):
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


@app.get("/api/data")
def all_data():
    with db.session() as conn:
        return {
            "settings": {r["key"]: r["value"] for r in db.rows(conn, "SELECT key, value FROM settings")},
            "beds": db.rows(conn, "SELECT * FROM beds ORDER BY sort, name"),
            "crops": db.rows(conn, "SELECT * FROM crops ORDER BY name"),
            "plantings": db.rows(conn, "SELECT * FROM plantings ORDER BY sow_date, id"),
        }


# ---------------------------------------------------------------- Beete

@app.post("/api/beds", status_code=201)
def create_bed(body: BedIn):
    record = {**BED_DEFAULTS, **body.model_dump(exclude_unset=True, exclude_none=True)}
    with db.session() as conn:
        if "sort" not in body.model_fields_set:
            record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM beds").fetchone()[0]
        new_id = _insert(conn, "beds", record)
        return _get(conn, "beds", new_id)


@app.patch("/api/beds/{bed_id}")
def update_bed(bed_id: int, body: BedIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with db.session() as conn:
        _get(conn, "beds", bed_id)
        _update(conn, "beds", bed_id, changes)
        return _get(conn, "beds", bed_id)


@app.delete("/api/beds/{bed_id}", status_code=204)
def delete_bed(bed_id: int):
    with db.session() as conn:
        _get(conn, "beds", bed_id)
        conn.execute("UPDATE plantings SET bed_id = NULL WHERE bed_id = ?", (bed_id,))
        conn.execute("DELETE FROM beds WHERE id = ?", (bed_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Kulturen

@app.post("/api/crops", status_code=201)
def create_crop(body: CropIn):
    record = {**CROP_DEFAULTS, **body.model_dump(exclude_unset=True, exclude_none=True)}
    with db.session() as conn:
        new_id = _insert(conn, "crops", record)
        return _get(conn, "crops", new_id)


@app.patch("/api/crops/{crop_id}")
def update_crop(crop_id: int, body: CropIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with db.session() as conn:
        _get(conn, "crops", crop_id)
        _update(conn, "crops", crop_id, changes)
        return _get(conn, "crops", crop_id)


@app.delete("/api/crops/{crop_id}", status_code=204)
def delete_crop(crop_id: int):
    with db.session() as conn:
        _get(conn, "crops", crop_id)
        used = conn.execute("SELECT COUNT(*) FROM plantings WHERE crop_id = ?", (crop_id,)).fetchone()[0]
        if used:
            _err(409, f"Die Kultur wird noch in {used} {'Satz' if used == 1 else 'Sätzen'} verwendet")
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
    with db.session() as conn:
        _check_planting(conn, record)
        new_id = _insert(conn, "plantings", record)
        return _get(conn, "plantings", new_id)


@app.patch("/api/plantings/{planting_id}")
def update_planting(planting_id: int, body: PlantingIn):
    # Hier zählt auch ein explizites null (z. B. Beet entfernen, Reihen auf automatisch)
    changes = _bool_flags(body.model_dump(exclude_unset=True))
    for not_null in ("crop_id", "method", "sow_date", "harvest_start", "harvest_end", "start", "len", "offset"):
        if not_null in changes and changes[not_null] is None:
            changes.pop(not_null)
    with db.session() as conn:
        current = _get(conn, "plantings", planting_id)
        merged = _check_planting(conn, {**current, **changes})
        if "method" in changes or "plant_date" in changes:
            changes["plant_date"] = merged["plant_date"]
        _update(conn, "plantings", planting_id, changes)
        return _get(conn, "plantings", planting_id)


@app.delete("/api/plantings/{planting_id}", status_code=204)
def delete_planting(planting_id: int):
    with db.session() as conn:
        _get(conn, "plantings", planting_id)
        conn.execute("DELETE FROM plantings WHERE id = ?", (planting_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Einstellungen, Sicherung

@app.patch("/api/settings")
def update_settings(body: SettingsIn):
    with db.session() as conn:
        for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))
        return {r["key"]: r["value"] for r in db.rows(conn, "SELECT key, value FROM settings")}


@app.get("/api/export")
def export_all():
    data = all_data()
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
        conn.execute("DELETE FROM plantings")
        conn.execute("DELETE FROM beds")
        conn.execute("DELETE FROM crops")
        conn.execute("DELETE FROM settings")
        conn.execute("DELETE FROM sqlite_sequence")
        for key, value in (data.get("settings") or {}).items():
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?)", (key, str(value)))
        for table in ("crops", "beds", "plantings"):
            cols = {r["name"] for r in db.rows(conn, f"PRAGMA table_info({table})")}
            for item in data.get(table) or []:
                record = {k: v for k, v in item.items() if k in cols}
                conn.execute(
                    f"INSERT INTO {table}({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                    list(record.values()),
                )
        for key, value in db.DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
    return all_data()


@app.post("/api/demo")
def load_demo(replace: bool = False):
    with db.session() as conn:
        has_beds = conn.execute("SELECT COUNT(*) FROM beds").fetchone()[0] > 0
        if has_beds and not replace:
            _err(409, "Es gibt schon Beete. Zum Ersetzen replace=true mitschicken.")
        conn.execute("DELETE FROM plantings")
        conn.execute("DELETE FROM beds")
        conn.execute("UPDATE settings SET value = '16' WHERE key = 'garden_width'")
        conn.execute("UPDATE settings SET value = '11' WHERE key = 'garden_height'")
        seed_demo(conn)
    return all_data()


# ---------------------------------------------------------------- Oberfläche

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
