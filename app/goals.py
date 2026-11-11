"""Satzweiser Anbau: Folgesätze rückwärts aus der gewünschten Erntemenge je Kalenderwoche planen.

Beispiel: 6 Köpfe Kopfsalat je Woche von KW 18 bis KW 40, in den Ferien weniger. Jeder Satz
liefert über sein Erntefenster; alle paar Wochen kommt ein neuer. Aus der Menge der Wochen,
die ein Satz abdeckt, und dem Ertrag je Pflanze ergibt sich seine Pflanzenzahl, aus der
Kulturdauer (im Frühjahr und Herbst länger) Pflanz- und Aussaattermin.

Mit einem Beet wird die ganze Folge dort als Block angelegt: jeder Satz ist ein Streifen über
die Beetbreite, so lang, wie seine Pflanzen brauchen. Ein Satz kommt auf die Fläche, die ein
abgeernteter Satz gerade frei gemacht hat – so braucht die Folge so wenig Beetlänge wie möglich.
Ohne Beet entstehen die Sätze wie bisher frei und laufen trotzdem in die Anzucht.
"""
import json
import math
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from . import db, methods, weather

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
GOAL_COLUMNS = [
    ("bed_id", "INTEGER"),                          # Beet, auf dem die Folge als Block liegt
    ("block_start", "REAL"),                        # Anfang des Blocks entlang der Beetlänge (m)
    ("block_len", "REAL"),                          # Länge, die der Block braucht (m), beim Planen gesetzt
    ("gap_days", "INTEGER NOT NULL DEFAULT 0"),     # Pause zwischen Abernten und Neubelegung
    ("weeks", "TEXT NOT NULL DEFAULT '{}'"),        # abweichende Menge je Woche: {"Montag-ISO": Menge}
    ("method", "TEXT NOT NULL DEFAULT ''"),         # Anbauart der Folge: direct | transplant; leer = wie die Kultur üblich
]
PLANTABLE = ("bed", "raised", "greenhouse")
STRIP_STEP = 0.05  # Länge der Streifen in 5-cm-Schritten

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
    for table, columns in (("plantings", PLANTING_COLUMNS), ("goals", GOAL_COLUMNS)):
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


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


def _strip(count: int, crop: dict, bed: dict) -> dict:
    """Streifen über die ganze Beetbreite, gerade lang genug für so viele Pflanzen (gleich gerechnet wie die Karte).
    Die Reihen laufen in Beetrichtung; der Streifen ist mindestens einen Pflanzabstand lang
    (in einem Beet, das breiter als lang ist, einen Reihenabstand)."""
    from .baserow import plant_count
    rs, ps = crop["row_spacing"] or 30, crop["plant_spacing"] or 30
    p = {"span": None, "offset": 0, "rows": None, "row_spacing": None, "plant_spacing": None, "varieties": None}
    longest = max(bed["length"], 1.0) * 4
    k = 1
    while True:
        length = round(k * STRIP_STEP, 2)
        along = bed["length"] >= bed["width"]
        if length * 100 + 0.5 >= (ps if along else rs):
            n = plant_count({**p, "len": length}, crop, bed)
            if n >= count or length >= longest:
                return {"rows": None, "len": length, "span": None, "count": n}
        k += 1


def weeks_of(goal: dict) -> dict[str, float]:
    """Abweichende Mengen je Woche (Schlüssel: Montag der Woche, ISO)."""
    w = goal.get("weeks")
    if isinstance(w, str):
        try:
            w = json.loads(w or "{}")
        except ValueError:
            w = {}
    return {str(k): float(v) for k, v in (w or {}).items() if v is not None}


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def successions(goal: dict, crop: dict, fd: Callable[[date, int, bool], Optional[int]],
                bed_width: Optional[float] = None, bed: Optional[dict] = None) -> list[dict]:
    """Die Sätze, die das Ziel braucht. Jeder Satz deckt die Tage bis zum nächsten ab; was in diesen
    Tagen geerntet werden soll (Menge der jeweiligen Kalenderwoche), bestimmt seine Pflanzenzahl.
    Mit Beet ist jeder Satz ein Streifen über die Beetbreite."""
    start, end = date.fromisoformat(goal["start_date"]), date.fromisoformat(goal["end_date"])
    window = goal.get("window_days") or crop["harvest_days"] or 14
    interval = goal.get("interval_days") or window
    transplant = crop["method"] == "transplant"
    weeks = weeks_of(goal)
    per_week = lambda d: weeks.get(_monday(d).isoformat(), goal["amount"])  # noqa: E731
    layouts: dict[int, dict] = {}
    out = []
    n = max(1, math.ceil(((end - start).days + 1) / interval))
    for i in range(n):
        hs = start + timedelta(days=i * interval)
        he = hs + timedelta(days=window - 1)
        last = min(hs + timedelta(days=interval - 1), end)
        demand = sum(per_week(hs + timedelta(days=k)) for k in range((last - hs).days + 1)) / 7  # was ein Satz liefern muss
        count = max(1, math.ceil(demand / (goal["yield_per_plant"] or 1) - 1e-9))
        if count not in layouts:
            layouts[count] = _strip(count, crop, bed) if bed else _layout(count, crop, bed_width)
        layout = layouts[count]
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
                "demand": round(demand, 2), "skip": demand <= 1e-9,
                "field_days": days, "too_cold": planted is None}
        if item["skip"]:  # in diesen Wochen soll nichts geerntet werden: kein Satz
            item.update(count=0, need=0)
        if planted is None:
            item.update(sow_date=None, plant_date=None)
        elif transplant:
            item.update(plant_date=planted.isoformat(),
                        sow_date=(planted - timedelta(days=crop["nursery_days"] or 28)).isoformat())
        else:
            item.update(sow_date=planted.isoformat(), plant_date=None)
        out.append(item)
    return out


# ---------------------------------------------------------------- Auf einem Beet blocken

def _ord(iso: Optional[str]) -> Optional[int]:
    return date.fromisoformat(iso).toordinal() if iso else None


def _goal_plantings(conn, gid: Optional[int]) -> dict[int, dict]:
    if not gid:
        return {}
    return {p["goal_seq"]: p for p in db.rows(conn, "SELECT * FROM plantings WHERE goal_id = ?", (gid,))}


def _pack(items: list[dict], bed: dict, start: float, fixed: list[tuple], gap: int) -> dict:
    """Sätze nach ihrem Tag im Beet nacheinander an die erste freie Stelle ab `start` legen.

    fixed: belegte Flächen (von, bis, erster Tag, letzter Tag) – andere Sätze im Beet und schon begonnene.
    Eine Fläche ist wieder frei ab dem Tag nach dem Abernten (plus Pause). Liefert die Lage je Satz."""
    placed = list(fixed)
    pos, unplaced = {}, []
    for it in sorted(items, key=lambda x: (x["t0"], x["seq"])):
        t0, t1, ln = it["t0"], it["t1"] + gap, it["len"]
        busy = [o for o in placed if o[2] <= t1 and t0 <= o[3]]
        x_at = None
        for x in sorted({start, *(round(o[1], 2) for o in busy if o[1] > start)}):
            if x + ln > bed["length"] + 1e-6:
                break
            if not any(x < o[1] - 1e-6 and o[0] < x + ln - 1e-6 for o in busy):
                x_at = x
                break
        if x_at is None:
            # kein Platz in seiner Zeit: der Satz bleibt ohne Beet, statt etwas anderes zu überdecken
            unplaced.append(it["seq"])
            pos[it["seq"]] = None
            continue
        x_at = round(x_at, 2)
        pos[it["seq"]] = x_at
        placed.append((x_at, x_at + ln, t0, t1))
    ends = [pos[it["seq"]] + it["len"] for it in items if pos.get(it["seq"]) is not None]
    return {"pos": pos, "unplaced": unplaced, "block_start": round(start, 2),
            "block_len": round(max(ends) - start, 2) if ends else 0.0}


def place(conn, g: dict, bed: dict, items: list[dict], start: Optional[float] = None) -> dict:
    """Lage aller Sätze im Beet. Ohne Anfang: die Stelle, an der die Folge am wenigsten Länge braucht."""
    own = _goal_plantings(conn, g.get("id"))
    gap = int(g.get("gap_days") or 0)
    fixed, todo = [], []
    for it in items:
        if it["too_cold"] or it["skip"]:
            continue
        p = own.get(it["seq"])
        if p is not None and _started(conn, p):
            continue  # bleibt, wie er ist (unten als belegt)
        todo.append({"seq": it["seq"], "len": it["len"], "t0": _ord(it["plant_date"] or it["sow_date"]), "t1": _ord(it["harvest_end"])})
    for p in db.rows(conn, "SELECT * FROM plantings WHERE bed_id = ?", (bed["id"],)):
        if g.get("id") and p["goal_id"] == g["id"] and not _started(conn, p):
            continue  # wird neu gelegt
        t0 = _ord(p["plant_date"] if p["method"] == "transplant" and p["plant_date"] else p["sow_date"])
        fixed.append((p["start"] or 0.0, (p["start"] or 0.0) + p["len"], t0, _ord(p["harvest_end"]) + gap))
    if start is not None:
        return _pack(todo, bed, min(max(start, 0.0), bed["length"]), fixed, gap)
    best = None
    for s in sorted({0.0, *(round(o[1], 2) for o in fixed if o[1] < bed["length"])}):
        r = _pack(todo, bed, s, fixed, gap)
        score = (len(r["unplaced"]), r["block_len"], s)
        if best is None or score < best[0]:
            best = (score, r)
    return best[1]


def _rotation_clash(conn, bed_id: int, crop: dict, year: int) -> bool:
    years = int((conn.execute("SELECT value FROM settings WHERE key = 'rotation_years'").fetchone() or ["3"])[0] or 3)
    if not crop.get("family") or years <= 0:
        return False
    for r in conn.execute("SELECT p.sow_date, p.plant_date FROM plantings p JOIN crops c ON c.id = p.crop_id "
                          "WHERE p.bed_id = ? AND c.family = ?", (bed_id, crop["family"])):
        y = int((r[1] or r[0])[:4])
        if y < year and year - y <= years:
            return True
    return False


def _started(conn, p: dict) -> bool:
    if p["sown_done"] or p["planted_done"] or p["harvest_done"]:
        return True
    return conn.execute("SELECT 1 FROM observations WHERE planting_id = ? LIMIT 1", (p["id"],)).fetchone() is not None


def compute(conn, g: dict, fd) -> dict:
    """Sätze mit Terminen, Größe und – mit Beet – ihrer Lage im Block."""
    # die Kultur mit Dauer und Abständen der Anbauart, in der die Folge angebaut wird
    crop = methods.for_method(dict(conn.execute("SELECT * FROM crops WHERE id = ?", (g["crop_id"],)).fetchone()), g.get("method") or None)
    width = db.uniform_width(conn)
    bed = _bed(conn, g.get("bed_id"))
    items = successions(g, crop, fd, width, bed)
    out = {"crop": crop, "bed": bed, "items": items, "block_start": None, "block_len": None, "unplaced": []}
    if bed:
        r = place(conn, g, bed, items, g.get("block_start"))
        for it in items:
            it["start"] = r["pos"].get(it["seq"])
            it["unplaced"] = it["seq"] in r["unplaced"]
        out.update(block_start=r["block_start"], block_len=r["block_len"], unplaced=r["unplaced"])
    return out


def _bed(conn, bed_id: Optional[int]) -> Optional[dict]:
    if not bed_id:
        return None
    row = conn.execute("SELECT * FROM beds WHERE id = ?", (bed_id,)).fetchone()
    return dict(row) if row and row["kind"] in PLANTABLE else None


def apply(conn, goal: dict, fd) -> dict:
    """Sätze des Ziels anlegen bzw. anpassen. Begonnene Sätze (gesät, gepflanzt, bonitiert) bleiben, wie sie sind.
    Mit Beet liegen alle anderen danach im Block auf diesem Beet."""
    plan_ = compute(conn, goal, fd)
    crop, bed, wanted = plan_["crop"], plan_["bed"], plan_["items"]
    existing = _goal_plantings(conn, goal["id"])
    created, updated, kept, removed = [], [], [], []
    for s in wanted:
        p = existing.pop(s["seq"], None)
        if s["too_cold"] or s["skip"]:
            if p and not _started(conn, p):
                _drop(conn, p)
                removed.append(p["id"])
            continue
        values = {"crop_id": crop["id"], "variety": goal["variety"], "method": crop["method"],
                  "sow_date": s["sow_date"], "plant_date": s["plant_date"], "harvest_start": s["harvest_start"],
                  "harvest_end": s["harvest_end"], "rows": s["rows"], "len": s["len"], "span": s["span"],
                  "row_spacing": None, "plant_spacing": None, "varieties": ""}
        if bed and s.get("start") is not None:
            values.update(bed_id=bed["id"], start=s["start"], offset=0)
        elif bed:
            values.update(bed_id=None, start=0, offset=0)  # passt nicht ins Beet: wartet unter „Ohne Beet“
        if p is None:
            record = {"bed_id": None, "start": 0, "offset": 0, **values, "goal_id": goal["id"], "goal_seq": s["seq"],
                      "notes": ""}
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
    conn.execute("UPDATE goals SET block_start = ?, block_len = ? WHERE id = ?",
                 (plan_["block_start"], plan_["block_len"], goal["id"]))
    return {"created": created, "updated": updated, "kept": kept, "removed": removed, "unplaced": len(plan_["unplaced"])}


def _drop(conn, p: dict) -> None:
    from .bonitur import _forget
    for plant in db.rows(conn, "SELECT * FROM plants WHERE planting_id = ?", (p["id"],)):
        _forget(conn, "plants", plant)
    _forget(conn, "plantings", p)
    conn.execute("DELETE FROM plants WHERE planting_id = ?", (p["id"],))
    conn.execute("DELETE FROM plantings WHERE id = ?", (p["id"],))


def _public(g: dict) -> dict:
    return {**g, "weeks": weeks_of(g)}


def lists(conn) -> dict:
    return {"goals": [_public(g) for g in db.rows(conn, "SELECT * FROM goals ORDER BY start_date, id")]}


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
    bed_id: Optional[int] = Field(None, ge=0)                 # 0: ohne Beet
    block_start: Optional[float] = Field(None, ge=-1, le=500)  # -1: Stelle selbst suchen
    gap_days: Optional[int] = Field(None, ge=0, le=60)
    weeks: Optional[dict[str, float]] = None                  # {"Montag-ISO": Menge}, nur Abweichungen
    method: Optional[Literal["", "direct", "transplant"]] = None  # leer: übliche Anbauart der Kultur

    @field_validator("weeks")
    @classmethod
    def _weeks(cls, v):
        if v is None:
            return v
        out = {}
        for k, amount in v.items():
            try:
                d = date.fromisoformat(k)
            except ValueError as exc:
                raise ValueError("Wochen bitte als Datum ihres Montags angeben") from exc
            if amount is None:
                continue
            if not 0 <= amount <= 10000:
                raise ValueError("Die Menge je Woche liegt zwischen 0 und 10000")
            out[_monday(d).isoformat()] = amount
        return out

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
    for k in ("window_days", "interval_days", "bed_id"):
        if g.get(k) == 0:
            g[k] = None
    if g.get("block_start") is not None and g["block_start"] < 0:
        g["block_start"] = None
    if "bed_id" in body.model_fields_set and body.bed_id != base.get("bed_id") and "block_start" not in body.model_fields_set:
        g["block_start"] = None  # neues Beet: Stelle neu suchen
    if g.get("bed_id") and _bed(conn, g["bed_id"]) is None:
        _err(422, "Auf diesem Beet lässt sich nichts anbauen")
    g["weeks"] = json.dumps(weeks_of(g))
    g["gap_days"] = int(g.get("gap_days") or 0)
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
    start, end = date.fromisoformat(g["start_date"]), date.fromisoformat(g["end_date"])
    weeks = weeks_of(g)
    if all(weeks.get(_monday(start + timedelta(days=k)).isoformat(), g.get("amount", 1)) <= 0
           for k in range((end - start).days + 1)):
        _err(422, "In keiner Woche soll etwas geerntet werden")
    return g


def _plan_out(conn, g: dict, fd, basis: str, with_beds: bool = False) -> dict:
    r = compute(conn, g, fd)
    crop, items = r["crop"], r["items"]
    window = g.get("window_days") or crop["harvest_days"] or 14
    out = {"successions": items, "basis": basis, "window_days": window, "interval_days": g.get("interval_days") or window,
           "method": crop["method"], "estimated": crop["estimated"], "field_days": crop["field_days"],
           "plants": sum(s["count"] for s in items if not s["too_cold"]),
           "bed_id": r["bed"]["id"] if r["bed"] else None, "block_start": r["block_start"], "block_len": r["block_len"],
           "unplaced": len(r["unplaced"])}
    if with_beds:
        # Wie die Folge auf jedes Beet passen würde (jeweils an der günstigsten Stelle)
        year = date.fromisoformat(g["start_date"]).year
        beds = []
        for bed in db.rows(conn, f"SELECT * FROM beds WHERE kind IN ({','.join('?' for _ in PLANTABLE)}) ORDER BY sort, id", PLANTABLE):
            rb = compute(conn, {**g, "bed_id": bed["id"], "block_start": None}, fd)
            beds.append({"bed_id": bed["id"], "block_start": rb["block_start"], "block_len": rb["block_len"],
                         "unplaced": len(rb["unplaced"]), "rotation": _rotation_clash(conn, bed["id"], crop, year)})
        out["beds"] = beds
    return out


@router.get("/api/goals/suggest")
def goal_suggest(crop_id: int):
    with db.session() as conn:
        crop = conn.execute("SELECT name, harvest_days FROM crops WHERE id = ?", (crop_id,)).fetchone()
        if crop is None:
            _err(404, "Diese Kultur gibt es nicht")
        return {**suggest(crop["name"]), "window_days": crop["harvest_days"]}


@router.post("/api/goals/preview")
def goal_preview(body: GoalIn, goal_id: Optional[int] = None, beds: bool = False):
    """Was das Ziel ergäbe, ohne zu speichern. goal_id: beim Ändern die eigenen Sätze nicht als belegt zählen."""
    with db.session() as conn:
        base = {"amount": 1, "unit": "Stück", "yield_per_plant": 1, "seasonal": 1}
        if goal_id:
            row = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
            if row is None:
                _err(404, "Dieses Ernteziel gibt es nicht")
            base = dict(row)
        g = _record(conn, base, body)
    fd, basis = duration_model(bool(g["seasonal"]))
    with db.session() as conn:
        return _plan_out(conn, g, fd, basis, beds)


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
        return {"goal": _public(dict(conn.execute("SELECT * FROM goals WHERE id = ?", (g["id"],)).fetchone())), **result,
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
        return {"goal": _public(dict(conn.execute("SELECT * FROM goals WHERE id = ?", (gid,)).fetchone())), **result, "basis": basis}


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
