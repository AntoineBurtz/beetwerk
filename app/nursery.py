"""Anzucht: Jungpflanzen aus den Sätzen und den Abgaben an Freunde planen.

Die Anzucht wird aus der Planung abgeleitet. Gespeichert werden nur die Einstellungen
(Gefäße, Plätze, Werte je Kultur), die Wünsche der Freunde und was in der Anzucht
wirklich passiert ist (gesät, pikiert, abgehärtet, Anzahlen).

Eine Anzucht fasst alles zusammen, was von einer Kultur und Sorte am selben Tag
gesät wird: Pflanzen für die Beete und für Freunde, dazu die Reserve.
"""
import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from . import bonitur, db, foils, methods

router = APIRouter()

SEEDED_KEY = "nursery_seeded"

SCHEMA = """
CREATE TABLE IF NOT EXISTS containers (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    kind     TEXT    NOT NULL DEFAULT 'cells',   -- tray (Saatschale) | cells (Multitopfplatte) | pot (Einzeltopf)
    cells    INTEGER NOT NULL DEFAULT 77,        -- Zellen je Platte, Körner je Schale, 1 je Topf
    per_slot REAL    NOT NULL DEFAULT 1,         -- wie viele davon auf einen Plattenplatz (ca. 30 × 50 cm) passen
    sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS places (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL,
    warm  INTEGER NOT NULL DEFAULT 0,            -- warm genug zum Keimen von Tomate, Paprika & Co.
    slots REAL    NOT NULL DEFAULT 4,            -- Plattenplätze
    sort  INTEGER NOT NULL DEFAULT 0,
    notes TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS people (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL,
    contact TEXT    NOT NULL DEFAULT '',
    notes   TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS handovers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    crop_id     INTEGER NOT NULL REFERENCES crops(id),
    variety     TEXT    NOT NULL DEFAULT '',     -- leer: Sorte offen
    count       INTEGER NOT NULL DEFAULT 1,
    pickup_date TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'wish', -- wish | promised | done | cancelled
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS nursery (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT    NOT NULL UNIQUE,       -- Kultur|sorte|Aussaattag
    crop_id       INTEGER NOT NULL,
    variety       TEXT    NOT NULL DEFAULT '',
    sow_date      TEXT    NOT NULL,
    seeds_sown    INTEGER,                       -- wirklich gesät (Körner)
    plants_raised INTEGER,                       -- wirklich vorhandene Jungpflanzen
    sown_done     INTEGER NOT NULL DEFAULT 0,
    pricked_done  INTEGER NOT NULL DEFAULT 0,
    hardened_done INTEGER NOT NULL DEFAULT 0,
    place_id      INTEGER,
    grow_place_id INTEGER,
    notes         TEXT    NOT NULL DEFAULT '',
    updated_at    TEXT    NOT NULL DEFAULT ''
);
"""

# Spalten der Kulturen für die Anzucht
CROP_COLUMNS = [
    ("sow_container_id", "INTEGER"),               # Gefäß für die Aussaat
    ("pot_container_id", "INTEGER"),               # Gefäß nach dem Pikieren; leer: nicht pikieren
    ("prick_days", "INTEGER NOT NULL DEFAULT 0"),  # Tage nach der Aussaat bis zum Pikieren
    ("seeds_per_cell", "INTEGER NOT NULL DEFAULT 1"),
    ("germination", "INTEGER NOT NULL DEFAULT 80"),  # Keimrate in %
    ("reserve", "INTEGER NOT NULL DEFAULT 20"),      # Reserve in %
    ("warm", "INTEGER NOT NULL DEFAULT 0"),          # braucht Wärme zum Keimen
    ("harden_days", "INTEGER NOT NULL DEFAULT 7"),   # Tage abhärten vor der Pflanzung
    ("place_id", "INTEGER"),                         # Anzuchtplatz
    ("grow_place_id", "INTEGER"),                    # Platz nach dem Pikieren
]

BACKUP_TABLES = ("containers", "places", "people", "handovers", "nursery")

# name, Art, Zellen bzw. Körner je Schale, je Plattenplatz
CONTAINERS = [
    ("Saatschale", "tray", 100, 2),
    ("Multitopfplatte 77", "cells", 77, 1),
    ("Multitopfplatte 104", "cells", 104, 1),
    ("Topf 7 cm", "pot", 1, 28),
    ("Topf 9 cm", "pot", 1, 15),
    ("Topf 12 cm", "pot", 1, 8),
]

# Richtwerte je Kultur (am Namen erkannt): Aussaat in, pikieren in, nach Tagen, Körner je Zelle, Keimrate, warm
CROP_DEFAULTS = [
    ("tomat", ("Saatschale", "Topf 9 cm", 14, 1, 85, 1)),
    ("paprika", ("Saatschale", "Topf 9 cm", 21, 1, 75, 1)),
    ("chili", ("Saatschale", "Topf 9 cm", 21, 1, 70, 1)),
    ("aubergine", ("Saatschale", "Topf 9 cm", 21, 1, 75, 1)),
    ("sellerie", ("Saatschale", "Multitopfplatte 77", 28, 1, 70, 1)),
    ("gurke", ("Topf 9 cm", None, 0, 1, 85, 1)),
    ("zucchini", ("Topf 9 cm", None, 0, 1, 85, 1)),
    ("kürbis", ("Topf 9 cm", None, 0, 1, 85, 1)),
    ("artischocke", ("Topf 9 cm", None, 0, 1, 70, 1)),
    ("mais", ("Multitopfplatte 77", None, 0, 1, 85, 1)),
    ("basilikum", ("Multitopfplatte 77", None, 0, 4, 75, 1)),
    ("salat", ("Multitopfplatte 104", None, 0, 1, 85, 0)),
    ("endivie", ("Multitopfplatte 104", None, 0, 1, 85, 0)),
    ("lauch", ("Multitopfplatte 104", None, 0, 1, 75, 0)),
    ("fenchel", ("Multitopfplatte 77", None, 0, 1, 75, 0)),
    ("kohl", ("Multitopfplatte 77", None, 0, 1, 85, 0)),
    ("brokkoli", ("Multitopfplatte 77", None, 0, 1, 85, 0)),
    ("blumenkohl", ("Multitopfplatte 77", None, 0, 1, 85, 0)),
]
FALLBACK = ("Multitopfplatte 77", None, 0, 1, 80, 0)

KIND_TEXT = {"tray": "Saatschale", "cells": "Multitopfplatte", "pot": "Einzeltopf"}
STATUS_TEXT = {"wish": "gewünscht", "promised": "zugesagt", "done": "abgeholt", "cancelled": "abgesagt"}
PICKUP_EARLY, PICKUP_LATE = 14, 28  # Abholung bis 2 Wochen vor und 4 Wochen nach dem Pflanztermin


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _d(iso: Optional[str]) -> Optional[date]:
    return date.fromisoformat(iso) if iso else None


def _iso(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


def vkey(name: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def batch_key(crop_id: int, variety: str, sow: str) -> str:
    return f"{crop_id}|{vkey(variety)}|{sow}"


# ---------------------------------------------------------------- Einrichten

def init(conn) -> None:
    conn.executescript(SCHEMA)
    have = {r[1] for r in conn.execute("PRAGMA table_info(crops)")}
    for name, decl in CROP_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE crops ADD COLUMN {name} {decl}")
    seed(conn)


def seed(conn) -> None:
    """Gefäße anlegen und den Kulturen einmal Richtwerte geben."""
    if conn.execute("SELECT COUNT(*) FROM containers").fetchone()[0] == 0:
        conn.executemany("INSERT INTO containers(name, kind, cells, per_slot, sort) VALUES (?, ?, ?, ?, ?)",
                         [(*c, i) for i, c in enumerate(CONTAINERS)])
    if conn.execute("SELECT 1 FROM settings WHERE key = ?", (SEEDED_KEY,)).fetchone():
        return
    assign_defaults(conn)
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))


def assign_defaults(conn, crop_ids=None) -> None:
    """Richtwerte für die Anzucht (Gefäß, Pikieren, Keimrate) für Kulturen, die vorgezogen werden können und noch
    kein Gefäß haben – alle oder nur die genannten (neu dazugekommene Kulturen)."""
    by_name = {r["name"]: r["id"] for r in db.rows(conn, "SELECT id, name FROM containers")}
    for c in db.rows(conn, "SELECT id, name, method, alt, sow_container_id FROM crops"):
        if (crop_ids is not None and c["id"] not in crop_ids) or not methods.can_transplant(c) or c["sow_container_id"]:
            continue
        low = c["name"].lower()
        sow, pot, days, k, germ, warm = next((v for word, v in CROP_DEFAULTS if word in low), FALLBACK)
        conn.execute("UPDATE crops SET sow_container_id = ?, pot_container_id = ?, prick_days = ?, seeds_per_cell = ?, "
                     "germination = ?, warm = ? WHERE id = ?",
                     (by_name.get(sow), by_name.get(pot) if pot else None, days, k, germ, warm, c["id"]))


def export_tables(conn) -> dict:
    return {"nursery": db.rows(conn, "SELECT * FROM nursery ORDER BY id")}


def clear_tables(conn) -> None:
    for t in ("nursery", "handovers", "people", "places", "containers"):
        conn.execute(f"DELETE FROM {t}")


# ---------------------------------------------------------------- Rechnen

def _parts(p: dict, crop: dict, bed: Optional[dict], grids: Optional[dict] = None) -> list[tuple[str, int]]:
    """Sorten eines Satzes mit Pflanzenzahl."""
    mixed = bonitur._loads(p.get("varieties"), []) or []
    if mixed:
        return [(str(v.get("name") or ""), int(v.get("count") or 0)) for v in mixed]
    lay = foils.layout(p, crop, bed, grids)  # gleiche Rechnung wie die Oberfläche
    return [(p["variety"] or "", lay["rows"] * lay["per_row"])]


def _ok_share(germination: float, k: int) -> float:
    """Anteil der Zellen mit mindestens einer Pflanze, wenn k Körner je Zelle liegen."""
    g = min(max(germination, 0.05), 1.0)
    return 1 - (1 - g) ** max(k, 1)


def _container(c: Optional[dict], units: float) -> Optional[dict]:
    if not c:
        return None
    return {"id": c["id"], "name": c["name"], "kind": c["kind"], "cells": c["cells"],
            "units": round(units, 2), "slots": round(units / (c["per_slot"] or 1), 2)}


def _amounts(crop: dict, target: int, containers: dict) -> dict:
    """Körner und Gefäße für eine Anzahl Jungpflanzen."""
    g = (crop.get("germination") or 80) / 100
    k = max(crop.get("seeds_per_cell") or 1, 1)
    sow_c = containers.get(crop.get("sow_container_id"))
    pot_c = containers.get(crop.get("pot_container_id"))
    if sow_c is None or sow_c["kind"] == "tray":
        # Breitsaat: so viele Körner, dass genug keimen
        seeds = math.ceil(target / g) if target else 0
        cells = seeds
    else:
        # Zellen oder Töpfe: so viele, dass in genug davon mindestens ein Korn keimt
        cells = math.ceil(target / _ok_share(g, k)) if target else 0
        seeds = cells * k
    sow_units = cells / (sow_c["cells"] or 1) if sow_c else 0
    pot_units = target / (pot_c["cells"] or 1) if pot_c else 0
    return {"seeds": seeds, "cells": cells, "sow": _container(sow_c, sow_units), "pot": _container(pot_c, pot_units)}


def _crop_view(c: dict) -> dict:
    return {"id": c["id"], "name": c["name"], "color": c["color"]}


def plan(conn, year: Optional[int] = None) -> dict:
    crops = {c["id"]: c for c in db.rows(conn, "SELECT * FROM crops")}
    beds = {b["id"]: b for b in db.rows(conn, "SELECT * FROM beds")}
    grids = foils.by_id(conn)
    containers = {c["id"]: c for c in db.rows(conn, "SELECT * FROM containers ORDER BY sort, id")}
    places = {p["id"]: p for p in db.rows(conn, "SELECT * FROM places ORDER BY sort, id")}
    people = {p["id"]: p for p in db.rows(conn, "SELECT * FROM people ORDER BY name COLLATE NOCASE")}
    handovers = db.rows(conn, "SELECT * FROM handovers ORDER BY pickup_date, id")
    states = {s["key"]: s for s in db.rows(conn, "SELECT * FROM nursery")}

    batches: dict[str, dict] = {}

    def batch(crop: dict, variety: str, sow: str) -> dict:
        key = batch_key(crop["id"], variety, sow)
        if key not in batches:
            batches[key] = {"key": key, "crop_id": crop["id"], "variety": variety.strip(), "sow_date": sow,
                            "own": [], "friends": [], "ready": None}
        return batches[key]

    # 1. Sätze mit Anzucht
    for p in db.rows(conn, "SELECT * FROM plantings WHERE method = 'transplant' AND plant_date IS NOT NULL "
                           "ORDER BY sow_date, id"):
        crop = crops.get(p["crop_id"])
        if crop is None:
            continue
        bed = beds.get(p["bed_id"])
        for variety, count in _parts(p, crop, bed, grids):
            if count <= 0:
                continue
            b = batch(crop, variety, p["sow_date"])
            b["own"].append({"planting_id": p["id"], "bed": bed["name"] if bed else None, "count": count,
                             "plant_date": p["plant_date"], "planted_done": bool(p["planted_done"]),
                             "sown_done": bool(p["sown_done"])})
            ready = _d(p["plant_date"])
            b["ready"] = min(b["ready"], ready) if b["ready"] else ready

    # 2. Wünsche der Freunde: in der passenden Anzucht mitlaufen lassen, sonst eigene Anzucht
    for ho in handovers:
        if ho["status"] == "cancelled":
            continue
        crop = crops.get(ho["crop_id"])
        if crop is None:
            continue
        pickup = _d(ho["pickup_date"])
        want = vkey(ho["variety"])
        best, best_gap = None, None
        for b in list(batches.values()):
            if b["crop_id"] != ho["crop_id"] or (want and vkey(b["variety"]) != want):
                continue
            gap = (pickup - b["ready"]).days
            if -PICKUP_EARLY <= gap <= PICKUP_LATE and (best is None or abs(gap) < best_gap
                                                        or (abs(gap) == best_gap and _own_count(b) > _own_count(best))):
                best, best_gap = b, abs(gap)
        if best is None:
            sow = pickup - timedelta(days=crop["nursery_days"] or 28)
            best = batch(crop, ho["variety"], sow.isoformat())
            best["ready"] = pickup if best["ready"] is None else min(best["ready"], pickup)
        person = people.get(ho["person_id"])
        best["friends"].append({"handover_id": ho["id"], "person_id": ho["person_id"],
                                "person": person["name"] if person else "?", "count": ho["count"],
                                "pickup_date": ho["pickup_date"], "status": ho["status"],
                                "variety": ho["variety"]})
        ho["batch"] = best["key"]

    # 3. Mengen, Termine, Plätze
    out = []
    for b in batches.values():
        crop = crops[b["crop_id"]]
        st = states.get(b["key"]) or {}
        own = sum(x["count"] for x in b["own"])
        friends = sum(x["count"] for x in b["friends"])
        need = own + friends
        reserve = crop.get("reserve") if crop.get("reserve") is not None else 20
        target = math.ceil(need * (1 + reserve / 100))
        sow = _d(b["sow_date"])
        ready = b["ready"] or sow
        amounts = _amounts(crop, target, containers)
        prick = sow + timedelta(days=crop["prick_days"] or 0) if amounts["pot"] else None
        if prick and prick >= ready:
            prick = None
        harden = ready - timedelta(days=crop.get("harden_days") or 0) if crop.get("harden_days") else None
        if harden and harden <= (prick or sow):
            harden = None
        place = places.get(st.get("place_id") or crop.get("place_id"))
        grow = places.get(st.get("grow_place_id") or crop.get("grow_place_id")) or place
        sown = bool(st.get("sown_done")) or (bool(b["own"]) and all(x["sown_done"] for x in b["own"]))
        # Was wirklich da ist, gegen den Bedarf
        have = st.get("plants_raised")
        if have is None and st.get("seeds_sown") is not None:
            have = math.floor(st["seeds_sown"] * (crop.get("germination") or 80) / 100)
        short = need - have if have is not None and have < need else 0
        out.append({
            **b, "ready": None, "crop": _crop_view(crop), "only_friends": not b["own"],
            "ready_date": _iso(ready), "prick_date": _iso(prick), "harden_date": _iso(harden),
            "own_count": own, "friend_count": friends, "need": need, "reserve": reserve, "target": target,
            "seeds": amounts["seeds"], "cells": amounts["cells"], "sow": amounts["sow"],
            "pot": amounts["pot"] if prick else None, "seeds_per_cell": crop.get("seeds_per_cell") or 1,
            "germination": crop.get("germination") or 80, "warm": bool(crop.get("warm")),
            "place": {"id": place["id"], "name": place["name"]} if place else None,
            "grow_place": {"id": grow["id"], "name": grow["name"]} if grow and prick else None,
            "setup_missing": amounts["sow"] is None,
            "state": {k: st.get(k) for k in ("seeds_sown", "plants_raised", "place_id", "grow_place_id", "notes")},
            "sown": sown, "pricked": bool(st.get("pricked_done")), "hardened": bool(st.get("hardened_done")),
            "have": have, "short": short,
        })
    out.sort(key=lambda x: (x["sow_date"], x["crop"]["name"].lower(), x["variety"].lower()))

    if year is not None:
        out = [b for b in out if b["sow_date"][:4] == str(year)]
    keys = {b["key"] for b in out}
    all_keys = set(batches)
    orphans = [{"key": s["key"], "crop_id": s["crop_id"], "variety": s["variety"], "sow_date": s["sow_date"],
                "seeds_sown": s["seeds_sown"], "plants_raised": s["plants_raised"], "sown_done": bool(s["sown_done"])}
               for s in states.values()
               if s["key"] not in all_keys and (year is None or s["sow_date"][:4] == str(year))
               and (s["sown_done"] or s["seeds_sown"] or s["plants_raised"])]
    ho_out = [{**ho, "batch": ho.get("batch")} for ho in handovers
              if year is None or ho["pickup_date"][:4] == str(year) or ho.get("batch") in keys]
    return {
        "year": year, "batches": out, "tasks": tasks(out), "occupancy": occupancy(out, places),
        "orphans": orphans, "handovers": ho_out,
        "years": sorted({b["sow_date"][:4] for b in batches.values()}),
    }


def _own_count(b: dict) -> int:
    return sum(x["count"] for x in b["own"])


def tasks(batches: list[dict]) -> list[dict]:
    """Was wann zu tun ist, nach Datum."""
    out = []
    for b in batches:
        base = {"key": b["key"]}
        out.append({**base, "date": b["sow_date"], "kind": "sow", "done": b["sown"], "count": b["seeds"]})
        if b["prick_date"]:
            out.append({**base, "date": b["prick_date"], "kind": "prick", "done": b["pricked"], "count": b["target"]})
        if b["harden_date"]:
            out.append({**base, "date": b["harden_date"], "kind": "harden", "done": b["hardened"], "count": b["target"]})
        for o in b["own"]:
            out.append({**base, "date": o["plant_date"], "kind": "plant", "done": o["planted_done"], "count": o["count"],
                        "planting_id": o["planting_id"], "bed": o["bed"]})
        for f in b["friends"]:
            out.append({**base, "date": f["pickup_date"], "kind": "handover", "done": f["status"] == "done",
                        "count": f["count"], "handover_id": f["handover_id"], "person": f["person"],
                        "status": f["status"]})
    order = {"sow": 0, "prick": 1, "harden": 2, "plant": 3, "handover": 4}
    out.sort(key=lambda t: (t["date"], order[t["kind"]]))
    return out


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def occupancy(batches: list[dict], places: dict) -> dict:
    """Plattenplätze je Platz und Woche, solange die Pflanzen drinnen stehen (bis zum Abhärten)."""
    spans = []  # (Platz-Schlüssel, von, bis, Plattenplätze)
    for b in batches:
        sow = _d(b["sow_date"])
        end = _d(b["harden_date"]) or _d(b["ready_date"])
        prick = _d(b["prick_date"])
        warm_key = f"none-{1 if b['warm'] else 0}"
        if b["sow"]:
            spans.append((b["place"]["id"] if b["place"] else warm_key, sow, prick or end, b["sow"]["slots"], b["key"]))
        if prick and b["pot"]:
            grow = b["grow_place"] or b["place"]
            spans.append((grow["id"] if grow else warm_key, prick, end, b["pot"]["slots"], b["key"]))
    if not spans:
        return {"weeks": [], "rows": []}
    first = _monday(min(s[1] for s in spans))
    last = _monday(max(s[2] for s in spans))
    weeks = []
    w = first
    while w <= last:
        weeks.append(w)
        w += timedelta(days=7)
    rows = {}
    for key, start, end, slots, bkey in spans:
        if key not in rows:
            p = places.get(key) if isinstance(key, int) else None
            rows[key] = {"place_id": key if isinstance(key, int) else None,
                         "name": p["name"] if p else ("ohne Platz, warm" if key.endswith("1") else "ohne Platz, kühl"),
                         "warm": bool(p["warm"]) if p else key.endswith("1"), "slots": p["slots"] if p else None,
                         "use": [0.0] * len(weeks), "batches": [[] for _ in weeks]}
        for i, wk in enumerate(weeks):
            if start < wk + timedelta(days=7) and end > wk:
                rows[key]["use"][i] += slots
                rows[key]["batches"][i].append(bkey)
    for pid, p in places.items():  # leere Plätze trotzdem zeigen
        rows.setdefault(pid, {"place_id": pid, "name": p["name"], "warm": bool(p["warm"]), "slots": p["slots"],
                              "use": [0.0] * len(weeks), "batches": [[] for _ in weeks]})
    order = list(places)
    out = sorted(rows.values(), key=lambda r: (r["place_id"] is None, order.index(r["place_id"]) if r["place_id"] in places else 0,
                                                not r["warm"]))
    for r in out:
        r["use"] = [round(u, 2) for u in r["use"]]
        r["over"] = [r["slots"] is not None and u > r["slots"] + 1e-9 for u in r["use"]]
    return {"weeks": [{"start": wk.isoformat(), "week": wk.isocalendar()[1]} for wk in weeks], "rows": out}


# ---------------------------------------------------------------- Schnittstelle

class ContainerIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    kind: Optional[Literal["tray", "cells", "pot"]] = None
    cells: Optional[int] = Field(None, ge=1, le=2000)
    per_slot: Optional[float] = Field(None, gt=0, le=500)
    sort: Optional[int] = None


class PlaceIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    warm: Optional[bool] = None
    slots: Optional[float] = Field(None, ge=0, le=1000)
    sort: Optional[int] = None
    notes: Optional[str] = Field(None, max_length=1000)


class PersonIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    contact: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=2000)


class HandoverIn(BaseModel):
    person_id: Optional[int] = None
    person_name: Optional[str] = Field(None, max_length=80)  # neue Person gleich mit anlegen
    crop_id: Optional[int] = None
    variety: Optional[str] = Field(None, max_length=120)
    count: Optional[int] = Field(None, ge=1, le=9999)
    pickup_date: Optional[str] = None
    status: Optional[Literal["wish", "promised", "done", "cancelled"]] = None
    notes: Optional[str] = Field(None, max_length=1000)

    @field_validator("pickup_date")
    @classmethod
    def _iso(cls, v):
        if v is None:
            return v
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError("Datum im Format JJJJ-MM-TT angeben") from exc
        return v


class BatchIn(BaseModel):
    key: str = Field(min_length=3, max_length=300)
    seeds_sown: Optional[int] = Field(None, ge=0, le=100000)
    plants_raised: Optional[int] = Field(None, ge=0, le=100000)
    sown_done: Optional[bool] = None
    pricked_done: Optional[bool] = None
    hardened_done: Optional[bool] = None
    place_id: Optional[int] = None
    grow_place_id: Optional[int] = None
    notes: Optional[str] = Field(None, max_length=2000)


def _get(conn, table: str, item_id: int, what: str) -> dict:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        _err(404, f"{what} gibt es nicht")
    return dict(row)


def _insert(conn, table: str, record: dict) -> int:
    cols = list(record)
    cur = conn.execute(f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                       [record[c] for c in cols])
    return cur.lastrowid


def _update(conn, table: str, item_id: int, changes: dict) -> None:
    if changes:
        conn.execute(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                     [*changes.values(), item_id])


def _clean(model: BaseModel) -> dict:
    out = model.model_dump(exclude_unset=True, exclude_none=True)
    for k, v in out.items():
        if isinstance(v, bool):
            out[k] = int(v)
        elif isinstance(v, str):
            out[k] = v.strip()
    return out


def lists(conn) -> dict:
    """Für /api/data: Gefäße, Plätze, Personen und ihre Wünsche."""
    return {
        "containers": db.rows(conn, "SELECT * FROM containers ORDER BY sort, id"),
        "places": db.rows(conn, "SELECT * FROM places ORDER BY sort, id"),
        "people": db.rows(conn, "SELECT * FROM people ORDER BY name COLLATE NOCASE"),
        "handovers": db.rows(conn, "SELECT * FROM handovers ORDER BY pickup_date, id"),
    }


@router.get("/api/nursery")
def nursery_plan(year: Optional[int] = None):
    if year is not None and not 1950 <= year <= 2100:
        _err(400, "Ungültiges Jahr")
    with db.session() as conn:
        return plan(conn, year)


@router.patch("/api/nursery")
def update_batch(body: BatchIn):
    """Was in einer Anzucht passiert ist. Gesät überträgt sich auf die Sätze, aus denen sie besteht."""
    changes = body.model_dump(exclude_unset=True)
    key = changes.pop("key")
    with db.session() as conn:
        found = next((b for b in plan(conn)["batches"] if b["key"] == key), None)
        row = conn.execute("SELECT * FROM nursery WHERE key = ?", (key,)).fetchone()
        if found is None and row is None:
            _err(404, "Diese Anzucht gibt es nicht mehr")
        for k in ("place_id", "grow_place_id"):
            if changes.get(k) == 0:
                changes[k] = None
            if changes.get(k) is not None:
                _get(conn, "places", changes[k], "Diesen Platz")
        for k in ("sown_done", "pricked_done", "hardened_done"):
            if k in changes:
                changes[k] = int(bool(changes[k]))
        if "notes" in changes:
            changes["notes"] = (changes["notes"] or "").strip()
        changes["updated_at"] = _now()
        if row is None:
            _insert(conn, "nursery", {"key": key, "crop_id": found["crop_id"], "variety": found["variety"],
                                      "sow_date": found["sow_date"], **changes})
        else:
            _update(conn, "nursery", row["id"], changes)
        sown = {}
        if "sown_done" in changes and found:
            sown = _sync_sown(conn, key, found, bool(changes["sown_done"]))
        out = plan(conn, int((found or dict(row))["sow_date"][:4]))
        out["plantings_sown"] = sown
        return out


def _sync_sown(conn, key: str, found: dict, done: bool) -> dict:
    """„Gesät“ auf die Sätze übertragen. Ein Mischsatz ist gesät, wenn alle seine Sorten gesät sind."""
    states = {s["key"]: s for s in db.rows(conn, "SELECT * FROM nursery")}
    out = {}
    for o in found["own"]:
        p = dict(conn.execute("SELECT * FROM plantings WHERE id = ?", (o["planting_id"],)).fetchone())
        names = [v.get("name", "") for v in bonitur._loads(p["varieties"], []) or []] or [p["variety"]]
        keys = {batch_key(p["crop_id"], n, p["sow_date"]): n for n in names}
        if done:
            flag = all(k == key or p["sown_done"] or (states.get(k) or {}).get("sown_done") for k in keys)
        else:
            if p["sown_done"]:
                # Die anderen Sorten galten mit dem Satz als gesät und bleiben es
                for k, n in keys.items():
                    if k != key and not (states.get(k) or {}).get("sown_done"):
                        if k in states:
                            conn.execute("UPDATE nursery SET sown_done = 1, updated_at = ? WHERE key = ?", (_now(), k))
                        else:
                            _insert(conn, "nursery", {"key": k, "crop_id": p["crop_id"], "variety": n.strip(),
                                                      "sow_date": p["sow_date"], "sown_done": 1, "updated_at": _now()})
            flag = False
        conn.execute("UPDATE plantings SET sown_done = ? WHERE id = ?", (int(flag), p["id"]))
        out[p["id"]] = bool(flag)
    return out


@router.post("/api/containers", status_code=201)
def create_container(body: ContainerIn):
    record = {"name": "Gefäß", "kind": "cells", "cells": 77, "per_slot": 1, **_clean(body)}
    if record["kind"] == "pot":
        record["cells"] = 1
    with db.session() as conn:
        if "sort" not in record:
            record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM containers").fetchone()[0]
        return _get(conn, "containers", _insert(conn, "containers", record), "Dieses Gefäß")


@router.patch("/api/containers/{cid}")
def update_container(cid: int, body: ContainerIn):
    changes = _clean(body)
    with db.session() as conn:
        cur = _get(conn, "containers", cid, "Dieses Gefäß")
        if changes.get("kind", cur["kind"]) == "pot":
            changes["cells"] = 1
        _update(conn, "containers", cid, changes)
        return _get(conn, "containers", cid, "Dieses Gefäß")


@router.delete("/api/containers/{cid}", status_code=204)
def delete_container(cid: int):
    with db.session() as conn:
        _get(conn, "containers", cid, "Dieses Gefäß")
        used = [r["name"] for r in db.rows(conn, "SELECT name FROM crops WHERE sow_container_id = ? OR pot_container_id = ? "
                                                 "ORDER BY name", (cid, cid))]
        if used:
            _err(409, f"Das Gefäß ist bei {', '.join(used[:5])}{' …' if len(used) > 5 else ''} eingestellt")
        conn.execute("DELETE FROM containers WHERE id = ?", (cid,))
    return Response(status_code=204)


@router.post("/api/places", status_code=201)
def create_place(body: PlaceIn):
    record = {"name": "Anzuchtplatz", "warm": 0, "slots": 4, "notes": "", **_clean(body)}
    with db.session() as conn:
        if "sort" not in record:
            record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM places").fetchone()[0]
        return _get(conn, "places", _insert(conn, "places", record), "Diesen Platz")


@router.patch("/api/places/{pid}")
def update_place(pid: int, body: PlaceIn):
    with db.session() as conn:
        _get(conn, "places", pid, "Diesen Platz")
        _update(conn, "places", pid, _clean(body))
        return _get(conn, "places", pid, "Diesen Platz")


@router.delete("/api/places/{pid}", status_code=204)
def delete_place(pid: int):
    with db.session() as conn:
        _get(conn, "places", pid, "Diesen Platz")
        for col in ("place_id", "grow_place_id"):
            conn.execute(f"UPDATE crops SET {col} = NULL WHERE {col} = ?", (pid,))
            conn.execute(f"UPDATE nursery SET {col} = NULL WHERE {col} = ?", (pid,))
        conn.execute("DELETE FROM places WHERE id = ?", (pid,))
    return Response(status_code=204)


@router.post("/api/people", status_code=201)
def create_person(body: PersonIn):
    record = {"name": "", "contact": "", "notes": "", **_clean(body)}
    if not record["name"]:
        _err(422, "Bitte einen Namen eingeben")
    with db.session() as conn:
        return _get(conn, "people", _insert(conn, "people", record), "Diese Person")


@router.patch("/api/people/{pid}")
def update_person(pid: int, body: PersonIn):
    with db.session() as conn:
        _get(conn, "people", pid, "Diese Person")
        _update(conn, "people", pid, _clean(body))
        return _get(conn, "people", pid, "Diese Person")


@router.delete("/api/people/{pid}", status_code=204)
def delete_person(pid: int):
    with db.session() as conn:
        _get(conn, "people", pid, "Diese Person")
        conn.execute("DELETE FROM handovers WHERE person_id = ?", (pid,))
        conn.execute("DELETE FROM people WHERE id = ?", (pid,))
    return Response(status_code=204)


def _person_for(conn, record: dict) -> None:
    name = (record.pop("person_name", None) or "").strip()
    if record.get("person_id") is None and name:
        row = conn.execute("SELECT id FROM people WHERE lower(name) = lower(?)", (name,)).fetchone()
        record["person_id"] = row["id"] if row else _insert(conn, "people", {"name": name, "contact": "", "notes": ""})
    if record.get("person_id") is not None:
        _get(conn, "people", record["person_id"], "Diese Person")


@router.post("/api/handovers", status_code=201)
def create_handover(body: HandoverIn):
    record = {"variety": "", "count": 1, "status": "wish", "notes": "", **_clean(body), "created_at": _now()}
    with db.session() as conn:
        _person_for(conn, record)
        for k, label in (("person_id", "Für wen?"), ("crop_id", "Welche Kultur?"), ("pickup_date", "Wann wird abgeholt?")):
            if record.get(k) in (None, ""):
                _err(422, f"{label} – bitte angeben")
        _get(conn, "crops", record["crop_id"], "Diese Kultur")
        return _get(conn, "handovers", _insert(conn, "handovers", record), "Diesen Wunsch")


@router.patch("/api/handovers/{hid}")
def update_handover(hid: int, body: HandoverIn):
    changes = _clean(body)
    with db.session() as conn:
        _get(conn, "handovers", hid, "Diesen Wunsch")
        _person_for(conn, changes)
        if "crop_id" in changes:
            _get(conn, "crops", changes["crop_id"], "Diese Kultur")
        _update(conn, "handovers", hid, changes)
        return _get(conn, "handovers", hid, "Diesen Wunsch")


@router.delete("/api/handovers/{hid}", status_code=204)
def delete_handover(hid: int):
    with db.session() as conn:
        _get(conn, "handovers", hid, "Diesen Wunsch")
        conn.execute("DELETE FROM handovers WHERE id = ?", (hid,))
    return Response(status_code=204)
