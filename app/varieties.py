"""Sortenliste: Saatgut und Sorten mit Einordnung, Foto und Quellen, dazu die KI-Recherche."""
import json
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from . import bonitur, db, research

router = APIRouter()

TEXT_FIELDS = ("name", "species", "kind", "seed", "growth", "color", "maturity", "supplier", "bought", "description",
               "photo", "photo_credit", "notes")


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def variety_out(row: dict) -> dict:
    try:
        row["links"] = json.loads(row["links"]) if row.get("links") else []
    except ValueError:
        row["links"] = []
    return row


class LinkIn(BaseModel):
    url: str = Field(max_length=1000)
    title: str = Field("", max_length=300)


class VarietyIn(BaseModel):
    crop_id: Optional[int] = None
    name: Optional[str] = Field(None, max_length=120)
    species: Optional[str] = Field(None, max_length=120)
    kind: Optional[str] = Field(None, max_length=120)
    seed: Optional[str] = Field(None, max_length=60)
    growth: Optional[str] = Field(None, max_length=200)
    color: Optional[str] = Field(None, max_length=120)
    maturity: Optional[str] = Field(None, max_length=200)
    supplier: Optional[str] = Field(None, max_length=200)
    bought: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=4000)
    photo: Optional[str] = Field(None, max_length=40)
    photo_credit: Optional[str] = Field(None, max_length=500)
    links: Optional[list[LinkIn]] = Field(None, max_length=20)
    notes: Optional[str] = Field(None, max_length=4000)

    @field_validator(*TEXT_FIELDS)
    @classmethod
    def _strip(cls, v):
        return v.strip() if isinstance(v, str) else v


def _check(conn, record: dict, own_id: Optional[int] = None) -> None:
    if not record.get("name"):
        _err(422, "Bitte einen Sortennamen eingeben")
    if record.get("crop_id") is not None and conn.execute(
            "SELECT 1 FROM crops WHERE id = ?", (record["crop_id"],)).fetchone() is None:
        _err(422, "Diese Kultur gibt es nicht")
    if record.get("photo") and not re.fullmatch(r"[0-9a-f]{20}", record["photo"]):
        _err(422, "Ungültiges Foto")
    dup = conn.execute(
        "SELECT v.id, c.name AS crop FROM varieties v LEFT JOIN crops c ON c.id = v.crop_id "
        "WHERE lower(v.name) = lower(?) AND v.crop_id IS ? AND v.id IS NOT ?",
        (record["name"], record.get("crop_id"), own_id)).fetchone()
    if dup:
        _err(409, f"„{record['name']}“ steht schon in der Sortenliste" + (f" ({dup['crop']})" if dup["crop"] else ""))


def _encode(record: dict) -> dict:
    if "links" in record:
        links = [x if isinstance(x, dict) else x.model_dump() for x in (record["links"] or [])]
        record["links"] = json.dumps(links, ensure_ascii=False) if links else ""
    return record


@router.get("/api/varieties")
def list_varieties():
    with db.session() as conn:
        return [variety_out(v) for v in db.rows(conn, "SELECT * FROM varieties ORDER BY name COLLATE NOCASE")]


@router.post("/api/varieties", status_code=201)
def create_variety(body: VarietyIn):
    record = {k: "" for k in TEXT_FIELDS}
    record.update({"crop_id": None, "links": []})
    record.update({k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None})
    _encode(record)
    now = _now()
    record.update(created_at=now, updated_at=now)
    with db.session() as conn:
        _check(conn, record)
        cols = list(record)
        cur = conn.execute(f"INSERT INTO varieties({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                           [record[c] for c in cols])
        return variety_out(dict(conn.execute("SELECT * FROM varieties WHERE id = ?", (cur.lastrowid,)).fetchone()))


def _get(conn, vid: int) -> dict:
    row = conn.execute("SELECT * FROM varieties WHERE id = ?", (vid,)).fetchone()
    if row is None:
        _err(404, "Diese Sorte gibt es nicht")
    return dict(row)


@router.patch("/api/varieties/{vid}")
def update_variety(vid: int, body: VarietyIn):
    changes = body.model_dump(exclude_unset=True)
    for k in TEXT_FIELDS:
        if k in changes and changes[k] is None:
            changes[k] = ""
    with db.session() as conn:
        current = _get(conn, vid)
        _check(conn, {**current, **changes}, vid)
        _encode(changes)
        if changes:
            changes["updated_at"] = _now()
            conn.execute(f"UPDATE varieties SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), vid])
        return variety_out(_get(conn, vid))


@router.delete("/api/varieties/{vid}", status_code=204)
def delete_variety(vid: int):
    with db.session() as conn:
        bonitur._forget(conn, "varieties", _get(conn, vid))
        conn.execute("DELETE FROM varieties WHERE id = ?", (vid,))
    return Response(status_code=204)


@router.post("/api/varieties/collect")
def collect_varieties():
    """Sorten, die in Sätzen vorkommen, aber noch nicht in der Sortenliste stehen, dort anlegen."""
    created = []
    with db.session() as conn:
        have = {(r["crop_id"], r["name"].lower()) for r in db.rows(conn, "SELECT crop_id, name FROM varieties")}
        now = _now()
        for p in db.rows(conn, "SELECT crop_id, variety, varieties FROM plantings"):
            names = [p["variety"]] if p["variety"] else []
            try:
                names += [v.get("name", "") for v in json.loads(p["varieties"] or "[]")]
            except ValueError:
                pass
            for name in names:
                name = (name or "").strip()
                if not name or (p["crop_id"], name.lower()) in have:
                    continue
                have.add((p["crop_id"], name.lower()))
                cur = conn.execute("INSERT INTO varieties(crop_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                                   (p["crop_id"], name, now, now))
                created.append(cur.lastrowid)
        rows = [variety_out(dict(conn.execute("SELECT * FROM varieties WHERE id = ?", (i,)).fetchone())) for i in created]
    return {"created": rows}


# ---------------------------------------------------------------- KI-Recherche

class ResearchConfigIn(BaseModel):
    api_key: Optional[str] = Field(None, max_length=300)
    model: Optional[str] = None


class ResearchIn(BaseModel):
    name: str = Field("", max_length=120)
    crop_id: Optional[int] = None
    hint: str = Field("", max_length=1000)
    image: Optional[str] = Field(None, max_length=8_000_000)  # data:image/jpeg;base64,…


class FromUrlIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)


def _fail(exc: research.ResearchError):
    raise HTTPException(status_code=502, detail=str(exc))


@router.get("/api/research")
def research_status():
    return research.status()


@router.put("/api/research")
def research_config(body: ResearchConfigIn):
    if body.model is not None and body.model not in {m for m, _ in research.MODELS}:
        _err(422, "Unbekanntes Modell")
    research.save_settings(body.api_key, body.model)
    return research.status()


@router.post("/api/research/test")
def research_test(body: ResearchConfigIn):
    try:
        return research.test_key(body.api_key, body.model)
    except research.ResearchError as exc:
        _fail(exc)


@router.post("/api/research/variety")
def research_variety(body: ResearchIn):
    with db.session() as conn:
        crops = db.rows(conn, "SELECT id, name FROM crops ORDER BY name")
    crop = next((c["name"] for c in crops if c["id"] == body.crop_id), "")
    try:
        image = research.decode_image(body.image) if body.image else None
        out = research.research(body.name, crop, [c["name"] for c in crops], body.hint, image)
    except research.ResearchError as exc:
        _fail(exc)
    # Kultur der Antwort einer vorhandenen zuordnen
    named = (out.get("crop") or "").strip().lower()
    match = next((c for c in crops if c["name"].lower() == named), None) or \
        next((c for c in crops if named and (c["name"].lower() in named or named in c["name"].lower())), None)
    out["crop_id"] = body.crop_id or (match["id"] if match else None)
    return out


@router.post("/api/photos/from-url", status_code=201)
def photo_from_url(body: FromUrlIn):
    """Bild aus dem Netz holen und wie ein eigenes Foto ablegen."""
    try:
        raw = research.download_image(body.url)
    except research.ResearchError as exc:
        _fail(exc)
    try:
        return {"name": bonitur.save_photo(raw)}
    except ValueError as exc:
        _err(422, str(exc))
