"""Sortenliste: Saatgut und Sorten mit Einordnung, Foto und Quellen, dazu die KI-Recherche."""
import json
import re
import threading
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from . import baserow, bonitur, db, profile, research

router = APIRouter()

TEXT_FIELDS = ("name", "species", "kind", "seed", "supplier", "bought", "description", "photo", "photo_credit", "notes")


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def variety_out(row: dict) -> dict:
    try:
        row["links"] = json.loads(row["links"]) if row.get("links") else []
    except ValueError:
        row["links"] = []
    row["profile"] = bonitur._loads(row.get("profile"), {}) or {}
    for legacy in ("growth", "color", "maturity"):  # seit Version 3 im Profil
        row.pop(legacy, None)
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
    supplier: Optional[str] = Field(None, max_length=200)
    bought: Optional[str] = Field(None, max_length=60)
    description: Optional[str] = Field(None, max_length=4000)
    photo: Optional[str] = Field(None, max_length=40)
    photo_credit: Optional[str] = Field(None, max_length=500)
    links: Optional[list[LinkIn]] = Field(None, max_length=20)
    notes: Optional[str] = Field(None, max_length=4000)
    profile: Optional[dict] = None  # {Merkmal-Schlüssel: {"value": …, "source": "internet" | "manual"}}

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


def _encode(record: dict, conn=None) -> dict:
    if "profile" in record and not isinstance(record["profile"], str):
        record["profile"] = profile.clean_profile(conn, record["profile"])
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
    now = _now()
    record.update(created_at=now, updated_at=now)
    with db.session() as conn:
        _encode(record, conn)
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
        _encode(changes, conn)
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


@router.get("/api/varieties/profiles")
def variety_profiles():
    """Kurzfassung der Merkmale je Sorte (nur mit Wert), für die Liste."""
    with db.session() as conn:
        return {str(k): v for k, v in profile.summaries(conn).items()}


@router.get("/api/varieties/{vid}/profile")
def variety_profile(vid: int):
    """Alle Merkmale der Sorte: Bonitur, Recherche oder eigene Angabe."""
    with db.session() as conn:
        v = _get(conn, vid)
        return {"rows": profile.rows_for(conn, v)}


@router.get("/api/profile-traits")
def profile_traits_for(crop_id: Optional[int] = None):
    """Merkmale des Profils für eine Kultur (für neue Sorten ohne gespeichertes Profil)."""
    with db.session() as conn:
        return {"rows": profile.rows_for(conn, {"id": None, "crop_id": crop_id, "profile": {}}, bon={})}


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
        crops, asked, known = _asked(conn, body.crop_id)
    crop = known["name"] if known else ""
    try:
        image = research.decode_image(body.image) if body.image else None
        out = research.research(body.name, crop, [c["name"] for c in crops], body.hint, image, asked)
    except research.ResearchError as exc:
        _fail(exc)
    # Kultur der Antwort einer vorhandenen zuordnen
    named = (out.get("crop") or "").strip().lower()
    match = next((c for c in crops if c["name"].lower() == named), None) or \
        next((c for c in crops if named and (c["name"].lower() in named or named in c["name"].lower())), None)
    out["crop_id"] = body.crop_id or (match["id"] if match else None)
    group = next((c["trait_group"] or "" for c in crops if c["id"] == out["crop_id"]), "")
    out["traits"], out["trait_meta"] = _found_traits(asked, out.get("traits"), out["crop_id"], group)
    return out


def _asked(conn, crop_id: Optional[int]) -> tuple[list[dict], list[dict], Optional[dict]]:
    """Kulturen, die Merkmale für die Recherche und die bekannte Kultur."""
    crops = db.rows(conn, "SELECT id, name, trait_group FROM crops ORDER BY name")
    all_traits = [bonitur.trait_out(t) for t in db.rows(conn, "SELECT * FROM traits WHERE active = 1")]
    known = next((c for c in crops if c["id"] == crop_id), None)
    groups = {known["trait_group"] or "all"} if known else {"all", "tomato", "pepper"}
    asked = profile._sorted([t for t in all_traits if profile.researchable(t) and t["grp"] in groups | {"all"}])
    return crops, asked, known


def _found_traits(asked: list[dict], raw, crop_id: Optional[int], group: str) -> tuple[dict, list]:
    """Merkmale nur, wenn sie zur Kultur passen und ihr Wert erlaubt ist."""
    found, meta = {}, []
    raw = raw if isinstance(raw, dict) else {}
    for t in asked:
        if t["key"] not in raw or (t["grp"] != "all" and crop_id and t["grp"] != group):
            continue
        value = profile.normalize(t, raw[t["key"]])
        if value is not None:
            found[t["key"]] = value
            meta.append({"key": t["key"], "name": t["name"], "type": t["type"], "unit": t["unit"],
                         "options": t["options"], "min": t["min"], "max": t["max"], "hint": t["hint"],
                         "section": t["section"], "grp": t["grp"], "text": profile.fmt(t, value)})
    return found, meta


# ---------------------------------------------------------------- Mehrere Sorten nacheinander recherchieren

BATCH_MAX = 100
_batch_lock = threading.Lock()
BUSY_WAIT = 60
_batch: dict = {"running": False, "total": 0, "done": 0, "current": "", "filled": 0, "skipped": [], "failed": [],
                "stopped": "", "usage": {}, "started": None, "finished": None}


class BatchIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=BATCH_MAX)


def _merge_research(vid: int, out: dict, traits: dict) -> int:
    """Leere Angaben der Sorte aus der Recherche füllen; Vorhandenes bleibt. Gibt die Zahl der gefüllten Angaben zurück."""
    with db.session() as conn:
        v = conn.execute("SELECT * FROM varieties WHERE id = ?", (vid,)).fetchone()
        if v is None:
            return 0
        v = dict(v)
        changes, filled = {}, 0
        for k in ("species", "kind", "seed", "description"):
            if not (v[k] or "").strip() and out.get(k):
                changes[k] = out[k][:{"description": 4000, "seed": 60}.get(k, 120)]
                filled += 1
        stored = bonitur._loads(v["profile"], {}) or {}
        for key, value in traits.items():
            if key not in stored:
                stored[key] = {"value": value, "source": "internet"}
                filled += 1
        if traits:
            changes["profile"] = profile.clean_profile(conn, stored)
        links = json.loads(v["links"]) if v["links"] else []
        have = {x.get("url") for x in links}
        new = [x for x in out.get("sources") or [] if x["url"] not in have]
        if new:
            changes["links"] = json.dumps((links + new)[:20], ensure_ascii=False)
        if changes:
            changes["updated_at"] = _now()
            conn.execute(f"UPDATE varieties SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), vid])
        return filled


def _run_batch(ids: list[int]) -> None:
    try:
        usage = _batch["usage"]
        for vid in ids:
            with db.session() as conn:
                row = conn.execute("SELECT v.id, v.name, v.crop_id, c.name AS crop FROM varieties v "
                                   "LEFT JOIN crops c ON c.id = v.crop_id WHERE v.id = ?", (vid,)).fetchone()
                crops, asked, known = _asked(conn, row["crop_id"] if row else None)
            if row is None:
                _batch["done"] += 1
                continue
            _batch["current"] = row["name"]
            try:
                try:
                    out = research.research(row["name"], row["crop"] or "", [c["name"] for c in crops], "", None, asked,
                                            images=False)
                except research.BusyError:
                    time.sleep(BUSY_WAIT)  # einmal abwarten und noch einmal versuchen
                    out = research.research(row["name"], row["crop"] or "", [c["name"] for c in crops], "", None, asked,
                                            images=False)
                for k, n in (out.get("usage") or {}).items():
                    usage[k] = usage.get(k, 0) + n
                if out.get("confidence") == "niedrig":
                    _batch["skipped"].append(row["name"])  # nicht sicher genau diese Sorte: lieber nichts eintragen
                else:
                    group = (known or {}).get("trait_group") or ""
                    traits, _ = _found_traits(asked, out.get("traits"), row["crop_id"], group)
                    _batch["filled"] += _merge_research(vid, out, traits)
            except research.ResearchError as exc:
                _batch["failed"].append({"name": row["name"], "error": str(exc)})
                if isinstance(exc, research.FatalResearchError):
                    _batch["stopped"] = str(exc)  # mit diesem Fehler scheitern auch alle weiteren
                    break
            except Exception as exc:  # noqa: BLE001 – eine Sorte darf die anderen nicht aufhalten
                _batch["failed"].append({"name": row["name"], "error": f"Unerwarteter Fehler: {exc}"})
            _batch["done"] += 1
    finally:
        _batch.update(running=False, current="", finished=_now())
        baserow.schedule()


@router.get("/api/research/batch")
def batch_status():
    return dict(_batch)


@router.post("/api/research/batch", status_code=202)
def research_batch(body: BatchIn):
    if not research.status()["configured"]:
        _err(422, "Für die Recherche fehlt der API-Schlüssel (Einstellungen → KI-Recherche)")
    ids = list(dict.fromkeys(body.ids))
    with _batch_lock:
        if _batch["running"]:
            _err(409, "Claude recherchiert gerade schon Sorten")
        _batch.update(running=True, total=len(ids), done=0, current="", filled=0, skipped=[], failed=[],
                      stopped="", usage={}, started=_now(), finished=None)
    threading.Thread(target=_run_batch, args=(ids,), daemon=True, name="beetwerk-research").start()
    return dict(_batch)


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
