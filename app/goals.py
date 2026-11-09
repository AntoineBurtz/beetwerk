"""Ernteziele: Folgesätze rückwärts aus der gewünschten Erntemenge je Woche planen.

Beispiel: 6 Köpfe Kopfsalat je Woche von KW 18 bis KW 40. Jeder Satz liefert über
sein Erntefenster; alle paar Wochen kommt ein neuer. Aus Menge und Ertrag je Pflanze
ergibt sich die Pflanzenzahl, aus der Kulturdauer (im Frühjahr und Herbst länger)
Pflanz- und Aussaattermin. Die Sätze entstehen ohne Beet und laufen in die Anzucht.
"""
import math
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator

from . import db, weather

router = APIRouter()

SCHEMA = """
CREATE TABLE IF NOT EXISTS goals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    crop_id         INTEGER NOT NULL REFERENCES crops(id),
    variety         TEXT    NOT NULL DEFAULT '',
    start_date      TEXT    NOT NULL,            -- erste Ernte
    end_date        TEXT    NOT NULL,            -- letzte Ernte
    amount          REAL    NOT NULL DEFAULT 1,  -- je Woche
    unit            TEXT    NOT NULL DEFAULT 'Stück',
    yield_per_plant REAL    NOT NULL DEFAULT 1,  -- Ernte je Pflanze über ihr Erntefenster
    window_days     INTEGER,                     -- Erntefenster je Satz; leer: Erntedauer der Kultur
    interval_days   INTEGER,                     -- Abstand der Sätze; leer: wie das Erntefenster
    seasonal        INTEGER NOT NULL DEFAULT 1,  -- Kulturdauer an die Jahreszeit anpassen
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT ''
);
"""
PLANTING_COLUMNS = [("goal_id", "INTEGER"), ("goal_seq", "INTEGER")]

# Ohne eigene Klimadaten: mittlere Monatstemperaturen, wie sie für Süddeutschland typisch sind (°C)
TYPICAL_MONTHS = [-0.5, 0.7, 4.5, 9.0, 13.4, 16.8, 18.6, 18.1, 13.9, 9.3, 4.2, 0.8]
# Wärmesumme: Basistemperatur und Bezugstag, für den die Kulturdauer der Kultur gilt
COOL = (0.0, (5, 1))   # Salat, Kohl & Co.: Kulturdauer gilt für eine Pflanzung Anfang Mai
WARM = (8.0, (6, 1))   # Basilikum, Bohnen, Kürbisgewächse: für Anfang Juni
MAX_STRETCH = 3.0      # länger als das Dreifache: in dieser Jahreszeit nicht sinnvoll

# Vorschläge je Kultur (am Namen erkannt): Einheit, Ertrag je Pflanze
DEFAULTS = [
    ("pflücksalat", "Portionen", 4), ("schnittsalat", "Portionen", 3), ("rucola", "Portionen", 0.5),
    ("basilikum", "Bund", 5), ("petersilie", "Bund", 4), ("schnittlauch", "Bund", 4), ("dill", "Bund", 1),
    ("koriander", "Bund", 1), ("radieschen", "Stück", 1), ("spinat", "Portionen", 0.3), ("feldsalat", "Portionen", 0.1),
    ("mangold", "Portionen", 6), ("salat", "Köpfe", 1), ("endivie", "Köpfe", 1), ("kohlrabi", "Stück", 1),
    ("fenchel", "Stück", 1), ("brokkoli", "Stück", 1), ("bohne", "kg", 0.15),
]


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def init(conn) -> None:
    conn.executescript(SCHEMA)
    have = {r[1] for r in conn.execute("PRAGMA table_info(plantings)")}
    for name, decl in PLANTING_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE plantings ADD COLUMN {name} {decl}")


def suggest(crop_name: str) -> dict:
    low = crop_name.lower()
    unit, per = next(((u, y) for word, u, y in DEFAULTS if word in low), ("Stück", 1))
    return {"unit": unit, "yield_per_plant": per}


# ---------------------------------------------------------------- Kulturdauer je Jahreszeit

def _typical() -> list[float]:
    """Tagesmittel aus den Monatsmitteln, zwischen den Monatsmitten linear verbunden."""
    mids = [weather._norm(date(2001, m, 15)) for m in range(1, 13)]
    out = []
    for d in range(365):
        k = max((i for i, m in enumerate(mids) if m <= d), default=-1)
        a, b = (mids[k], mids[(k + 1) % 12] + (365 if k == 11 else 0)) if k >= 0 else (mids[11] - 365, mids[0])
        ta, tb = TYPICAL_MONTHS[k], TYPICAL_MONTHS[(k + 1) % 12]
        out.append(ta + (d - a) / (b - a) * (tb - ta))
    return out


def _normals() -> Optional[list[float]]:
    """Mittlere Tagestemperatur je Tag im Jahr aus den Klimadaten der letzten Jahre, sonst None."""
    rows = weather._climate_rows(date(1900, 1, 1), date(2100, 12, 31))
    if len(rows) < 365 * 3:
        return None
    normals = weather.climate_normals(rows)
    if not normals:
        return None
    tmin, tmax = normals["daily"]["tmin"], normals["daily"]["tmax"]
    if any(v is None for v in tmin) or any(v is None for v in tmax):
        return None
    return [(a + b) / 2 for a, b in zip(tmin, tmax)]


def duration_model(seasonal: bool = True) -> tuple[Callable[[date, int, bool], Optional[int]], str]:
    """Liefert eine Funktion (Pflanztag, Kulturdauer, warm) -> Tage bis zur Ernte und die Grundlage der Rechnung.

    Wärmesumme: Die Kultur braucht so viel Wärme wie bei einer Pflanzung am Bezugstag in ihrer
    Kulturdauer. Im kühlen Frühjahr und Herbst dauert es länger, nie kürzer als die Kulturdauer.
    """
    if not seasonal:
        return (lambda start, days, warm: days), "fest"
    temps = _normals()
    basis = "Klima"
    if temps is None:
        temps, basis = _typical(), "typisch"
    tables: dict[float, list[float]] = {}
    refs: dict[tuple[int, bool], float] = {}

    def by_heat(start: date, days: int, warm: bool) -> Optional[int]:
        if days <= 0:
            return days
        base, ref = WARM if warm else COOL
        if base not in tables:
            tables[base] = [max(0.0, min(t, 25.0) - base) for t in temps]
        g = tables[base]
        if (days, warm) not in refs:
            r0 = weather._norm(date(2001, *ref))
            refs[(days, warm)] = sum(g[(r0 + k) % 365] for k in range(days))
        need = refs[(days, warm)]
        if need <= 0:
            return days
        i0, acc, n = weather._norm(start), 0.0, 0
        limit = days * MAX_STRETCH
        while acc < need:
            acc += g[(i0 + n) % 365]
            n += 1
            if n > limit:
                return None
        return max(n, days)
    return by_heat, basis


# ---------------------------------------------------------------- Rechnen

def _layout(count: int, crop: dict, bed_width: Optional[float] = None) -> dict:
    """Fläche ohne Beet für genau so viele Pflanzen: Reihen quer, Länge entlang (aufgerundet auf volle Reihen).
    Sind alle Beete gleich breit, ist der Satz ein Streifen über die ganze Beetbreite."""
    rs, ps = crop["row_spacing"] or 30, crop["plant_spacing"] or 30
    if bed_width:
        rows = max(1, int((bed_width * 100 + 0.5) // rs))
        per_row = math.ceil(count / rows)
        return {"rows": rows, "len": round(per_row * ps / 100, 2), "span": round(bed_width, 2), "count": rows * per_row}
    max_rows = max(1, int((100 + 0.5) // rs))  # wie viele Reihen auf 1 m Breite passen
    for rows in range(max_rows, 0, -1):
        per_row = math.ceil(count / rows)
        length = round(per_row * ps / 100, 2)
        span = round(rows * rs / 100, 2)
        if length >= span:
            return {"rows": rows, "len": length, "span": span, "count": rows * per_row}
    per_row = count
    return {"rows": 1, "len": round(per_row * ps / 100, 2), "span": round(rs / 100, 2), "count": per_row}


def successions(goal: dict, crop: dict, fd: Callable[[date, int, bool], Optional[int]],
                bed_width: Optional[float] = None) -> list[dict]:
    """Die Sätze, die das Ziel braucht."""
    start, end = date.fromisoformat(goal["start_date"]), date.fromisoformat(goal["end_date"])
    window = goal.get("window_days") or crop["harvest_days"] or 14
    interval = goal.get("interval_days") or window
    transplant = crop["method"] == "transplant"
    per_interval = goal["amount"] * interval / 7  # was ein Satz liefern muss
    count = max(1, math.ceil(per_interval / (goal["yield_per_plant"] or 1)))
    layout = _layout(count, crop, bed_width)
    out = []
    n = max(1, math.ceil(((end - start).days + 1) / interval))
    for i in range(n):
        hs = start + timedelta(days=i * interval)
        he = hs + timedelta(days=window - 1)
        base = crop["field_days"] or 0
        # Spätester Pflanz- bzw. Saattag, an dem die Kultur bis zum Erntebeginn fertig wird
        planted, days = None, None
        for back in range(base, base * 4 + 1):
            cand = hs - timedelta(days=back)
            need = fd(cand, base, bool(crop.get("warm")))
            if need is not None and cand + timedelta(days=need) <= hs:
                planted, days = cand, need
                break
        item = {"seq": i, "harvest_start": hs.isoformat(), "harvest_end": he.isoformat(), "count": layout["count"],
                "need": count, "rows": layout["rows"], "len": layout["len"], "span": layout["span"],
                "field_days": days, "too_cold": planted is None}
        if planted is None:
            item.update(sow_date=None, plant_date=None)
        elif transplant:
            item.update(plant_date=planted.isoformat(),
                        sow_date=(planted - timedelta(days=crop["nursery_days"] or 28)).isoformat())
        else:
            item.update(sow_date=planted.isoformat(), plant_date=None)
        out.append(item)
    return out


def _started(conn, p: dict) -> bool:
    if p["sown_done"] or p["planted_done"] or p["harvest_done"]:
        return True
    return conn.execute("SELECT 1 FROM observations WHERE planting_id = ? LIMIT 1", (p["id"],)).fetchone() is not None


def apply(conn, goal: dict, fd) -> dict:
    """Sätze des Ziels anlegen bzw. anpassen. Begonnene Sätze (gesät, gepflanzt, bonitiert) bleiben, wie sie sind."""
    crop = dict(conn.execute("SELECT * FROM crops WHERE id = ?", (goal["crop_id"],)).fetchone())
    wanted = successions(goal, crop, fd, db.uniform_width(conn))
    existing = {p["goal_seq"]: p for p in db.rows(conn, "SELECT * FROM plantings WHERE goal_id = ?", (goal["id"],))}
    created, updated, kept, removed = [], [], [], []
    for s in wanted:
        p = existing.pop(s["seq"], None)
        if s["too_cold"]:
            if p and not _started(conn, p):
                _drop(conn, p)
                removed.append(p["id"])
            continue
        values = {"crop_id": crop["id"], "variety": goal["variety"], "method": crop["method"],
                  "sow_date": s["sow_date"], "plant_date": s["plant_date"], "harvest_start": s["harvest_start"],
                  "harvest_end": s["harvest_end"], "rows": s["rows"], "len": s["len"], "span": s["span"],
                  "row_spacing": None, "plant_spacing": None, "varieties": ""}
        if p is None:
            record = {**values, "bed_id": None, "start": 0, "offset": 0, "goal_id": goal["id"], "goal_seq": s["seq"],
                      "notes": f"Ernteziel: {_amount(goal)} je Woche"}
            cols = list(record)
            cur = conn.execute(f"INSERT INTO plantings({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                               [record[c] for c in cols])
            created.append(cur.lastrowid)
        elif _started(conn, p):
            kept.append(p["id"])
        else:
            conn.execute(f"UPDATE plantings SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                         [*values.values(), p["id"]])
            updated.append(p["id"])
    for p in existing.values():  # Ziel ist kürzer geworden
        if _started(conn, p):
            conn.execute("UPDATE plantings SET goal_id = NULL, goal_seq = NULL WHERE id = ?", (p["id"],))
            kept.append(p["id"])
        else:
            _drop(conn, p)
            removed.append(p["id"])
    return {"created": created, "updated": updated, "kept": kept, "removed": removed}


def _drop(conn, p: dict) -> None:
    from .bonitur import _forget
    for plant in db.rows(conn, "SELECT * FROM plants WHERE planting_id = ?", (p["id"],)):
        _forget(conn, "plants", plant)
    _forget(conn, "plantings", p)
    conn.execute("DELETE FROM plants WHERE planting_id = ?", (p["id"],))
    conn.execute("DELETE FROM plantings WHERE id = ?", (p["id"],))


def _amount(goal: dict) -> str:
    a = goal["amount"]
    return f"{a:g} {goal['unit']}".replace(".", ",")


def lists(conn) -> dict:
    return {"goals": db.rows(conn, "SELECT * FROM goals ORDER BY start_date, id")}


# ---------------------------------------------------------------- Schnittstelle

class GoalIn(BaseModel):
    crop_id: Optional[int] = None
    variety: Optional[str] = Field(None, max_length=120)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    amount: Optional[float] = Field(None, gt=0, le=10000)
    unit: Optional[str] = Field(None, min_length=1, max_length=30)
    yield_per_plant: Optional[float] = Field(None, gt=0, le=10000)
    window_days: Optional[int] = Field(None, ge=0, le=365)   # 0: wie die Kultur
    interval_days: Optional[int] = Field(None, ge=0, le=365)  # 0: wie das Erntefenster
    seasonal: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=2000)

    @field_validator("start_date", "end_date")
    @classmethod
    def _iso(cls, v):
        if v is None:
            return v
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError("Datum im Format JJJJ-MM-TT angeben") from exc
        return v


def _record(conn, base: dict, body: GoalIn) -> dict:
    g = {**base, **body.model_dump(exclude_unset=True, exclude_none=True)}
    for k in ("window_days", "interval_days"):
        if g.get(k) == 0:
            g[k] = None
    if "seasonal" in g:
        g["seasonal"] = int(bool(g["seasonal"]))
    for k, label in (("crop_id", "Welche Kultur?"), ("start_date", "Ab wann ernten?"), ("end_date", "Bis wann ernten?")):
        if not g.get(k):
            _err(422, f"{label} – bitte angeben")
    if conn.execute("SELECT 1 FROM crops WHERE id = ?", (g["crop_id"],)).fetchone() is None:
        _err(422, "Diese Kultur gibt es nicht")
    if g["end_date"] < g["start_date"]:
        _err(422, "Das Ernteende liegt vor dem Erntebeginn")
    if (date.fromisoformat(g["end_date"]) - date.fromisoformat(g["start_date"])).days > 366:
        _err(422, "Ein Ernteziel gilt höchstens für ein Jahr")
    window = g.get("window_days")
    interval = g.get("interval_days")
    if interval and window and interval > window:
        _err(422, "Der Abstand der Sätze ist länger als das Erntefenster – dann gibt es Lücken in der Ernte")
    g["variety"] = (g.get("variety") or "").strip()
    g["unit"] = (g.get("unit") or "Stück").strip()
    return g


def _plan_out(conn, g: dict, fd, basis: str) -> dict:
    crop = dict(conn.execute("SELECT * FROM crops WHERE id = ?", (g["crop_id"],)).fetchone())
    items = successions(g, crop, fd, db.uniform_width(conn))
    window = g.get("window_days") or crop["harvest_days"] or 14
    return {"successions": items, "basis": basis, "window_days": window, "interval_days": g.get("interval_days") or window,
            "method": crop["method"], "plants": sum(s["count"] for s in items if not s["too_cold"])}


@router.get("/api/goals/suggest")
def goal_suggest(crop_id: int):
    with db.session() as conn:
        crop = conn.execute("SELECT name, harvest_days FROM crops WHERE id = ?", (crop_id,)).fetchone()
        if crop is None:
            _err(404, "Diese Kultur gibt es nicht")
        return {**suggest(crop["name"]), "window_days": crop["harvest_days"]}


@router.post("/api/goals/preview")
def goal_preview(body: GoalIn):
    """Was das Ziel ergäbe, ohne zu speichern."""
    with db.session() as conn:
        g = _record(conn, {"amount": 1, "unit": "Stück", "yield_per_plant": 1, "seasonal": 1}, body)
    fd, basis = duration_model(bool(g["seasonal"]))
    with db.session() as conn:
        return _plan_out(conn, g, fd, basis)


@router.post("/api/goals", status_code=201)
def create_goal(body: GoalIn):
    with db.session() as conn:
        g = _record(conn, {"amount": 1, "unit": "Stück", "yield_per_plant": 1, "seasonal": 1, "notes": ""}, body)
    fd, basis = duration_model(bool(g["seasonal"]))
    with db.session() as conn:
        g["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        cols = [k for k in g if k != "id"]
        cur = conn.execute(f"INSERT INTO goals({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                           [g[c] for c in cols])
        g["id"] = cur.lastrowid
        result = apply(conn, g, fd)
        return {"goal": dict(conn.execute("SELECT * FROM goals WHERE id = ?", (g["id"],)).fetchone()), **result,
                "basis": basis}


@router.patch("/api/goals/{gid}")
def update_goal(gid: int, body: GoalIn):
    with db.session() as conn:
        row = conn.execute("SELECT * FROM goals WHERE id = ?", (gid,)).fetchone()
        if row is None:
            _err(404, "Dieses Ernteziel gibt es nicht")
        g = _record(conn, dict(row), body)
        if "window_days" in body.model_fields_set and not body.window_days:
            g["window_days"] = None
        if "interval_days" in body.model_fields_set and not body.interval_days:
            g["interval_days"] = None
    fd, basis = duration_model(bool(g["seasonal"]))
    with db.session() as conn:
        cols = [k for k in g if k not in ("id", "created_at")]
        conn.execute(f"UPDATE goals SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?", [*[g[c] for c in cols], gid])
        result = apply(conn, g, fd)
        return {"goal": dict(conn.execute("SELECT * FROM goals WHERE id = ?", (gid,)).fetchone()), **result, "basis": basis}


@router.delete("/api/goals/{gid}", status_code=204)
def delete_goal(gid: int, keep: bool = False):
    """Ziel löschen; seine noch nicht begonnenen Sätze auch (keep=true behält sie als normale Sätze)."""
    with db.session() as conn:
        if conn.execute("SELECT 1 FROM goals WHERE id = ?", (gid,)).fetchone() is None:
            _err(404, "Dieses Ernteziel gibt es nicht")
        for p in db.rows(conn, "SELECT * FROM plantings WHERE goal_id = ?", (gid,)):
            if keep or _started(conn, p):
                conn.execute("UPDATE plantings SET goal_id = NULL, goal_seq = NULL WHERE id = ?", (p["id"],))
            else:
                _drop(conn, p)
        conn.execute("DELETE FROM goals WHERE id = ?", (gid,))
    return Response(status_code=204)
