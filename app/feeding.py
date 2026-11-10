"""Düngung: Stickstoffbedarf je Kultur, Düngerliste und Richtwerte mit Quelle.

Die Empfehlung folgt dem Merkblatt 2202 der Bayerischen Gartenakademie (LWG, Dezember 2020,
„Hinweise zur praktischen Handhabung der Düngung im Gemüsegarten“): drei Stufen mit Höchstmengen
für Horndünger (50/100/150 g/m² bei knapp 13 % N) und Ammonsulfatsalpeter (25/50/75 g/m² bei 26 % N),
also rund 6,5 / 13 / 19,5 g Stickstoff je m². Mengen und Termine je Satz rechnet die Oberfläche (feed.js).

Woher die Stufe einer Kultur stammt, steht in feed_src:
- „LWG 2202“:  im Merkblatt genannt
- „LWG 2166“:  Merkblatt „Kräuter zum Frischverzehr aus dem eigenen Garten“ (Februar 2016)
- „N-Bedarf“:  dort nicht genannt; abgeleitet aus dem Stickstoffbedarfswert des Erwerbsanbaus
               (IGZ, Nmin-Sollwerte für Freilandgemüse, Stand 2015; LfL, Basisdaten 2025, Tabelle 9d):
               bis 135 kg N/ha gering, darüber mittel
- „Analogie“:  keine Angabe gefunden; wie die nächste verwandte Kultur
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import db

router = APIRouter()

SEEDED_KEY = "feeding_seeded"
HERBS_KEY = "herbs_seeded"

SCHEMA = """
CREATE TABLE IF NOT EXISTS fertilizers (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL,
    n_pct REAL    NOT NULL,                 -- Stickstoffgehalt in %
    speed TEXT    NOT NULL DEFAULT 'slow',  -- slow: wirkt über Wochen (Horn, Langzeit) | fast: sofort (mineralisch)
    note  TEXT    NOT NULL DEFAULT '',
    sort  INTEGER NOT NULL DEFAULT 0
);
"""

CROP_COLUMNS = [
    ("feed", "TEXT NOT NULL DEFAULT ''"),           # Stickstoffbedarf: '' offen | none | low | medium | high
    ("feed_n", "REAL NOT NULL DEFAULT 0"),          # eigene Menge in g N/m²; 0 = Menge der Stufe
    ("feed_cut", "INTEGER NOT NULL DEFAULT 0"),     # Schnittkultur: nach dem Schnitt nachdüngen
    ("feed_start", "INTEGER NOT NULL DEFAULT 0"),   # schnell wirkender Dünger: erste Gabe so viele Tage nach Saat/Pflanzung; 0 = Regel
    ("feed_late", "INTEGER NOT NULL DEFAULT 0"),    # Sätze, die ab August beginnen, brauchen meist keine Düngung
    ("feed_src", "TEXT NOT NULL DEFAULT ''"),       # woher die Stufe stammt
]
PLANTING_COLUMNS = [
    ("no_feed", "INTEGER NOT NULL DEFAULT 0"),      # diesen Satz nicht düngen
    ("fed", "TEXT NOT NULL DEFAULT ''"),            # erledigte Gaben: JSON {"0": "2027-05-01"}
]

# g Stickstoff je m² und Kultur (LWG 2202: Höchstmengen)
LEVELS = {"none": 0.0, "low": 6.5, "medium": 13.0, "high": 19.5}

# name, N in %, Wirkung, Hinweis
FERTILIZERS = [
    ("Hornmehl", 13, "slow", "LWG: 10 bis 14 % N, meist knapp 13; nach etwa 6 Wochen umgesetzt"),
    ("Hornspäne", 13, "slow", "wirken über mehrere Monate; Gehalt bitte nach der Packung eintragen"),
    ("Ammonsulfatsalpeter", 26, "fast", "LWG: wirkt schnell, günstig bei hohem pH-Wert"),
    ("Entec 14-7-17", 14, "slow", "LWG: Stickstoff wird teils verzögert frei, etwa wie Horndünger dosieren"),
    ("Hornoska 8-3-10", 8, "slow", "organisch, enthält auch Phosphat und Kali"),
    ("Maltaflor 5-3-5", 5, "slow", "organisch, enthält auch Phosphat und Kali"),
]

SP_LWG = "LWG, Sä- und Pflanztermine auf einen Blick"
SP_AID = "aid, Gemüse, Obst & Co. (2017)"


def _ref(words, feed, src, row=None, plant=None, sp=None, cut=0, start=0, late=0):
    return {"words": words, "feed": feed, "feed_src": src, "feed_cut": cut, "feed_start": start, "feed_late": late,
            "row_spacing": row, "plant_spacing": plant, "spacing_src": sp}


# Richtwerte, am Namen erkannt – die erste passende Zeile gilt, deshalb stehen genauere Namen vorn
# (Bohnenkraut vor Bohne, Knoblauch und Schnittlauch vor Lauch, Feldsalat vor Salat, Kohlrabi vor Kohl).
REFERENCE = [
    # Kräuter
    _ref(("bohnenkraut",), "none", "LWG 2166", 25, 25, SP_AID),
    _ref(("basilikum",), "low", "N-Bedarf", 25, 25, SP_AID, cut=1),
    _ref(("petersilie",), "medium", "N-Bedarf", 20, 5, SP_AID, cut=1, start=28),
    _ref(("schnittlauch",), "medium", "N-Bedarf", 25, 20, SP_AID, cut=1),
    _ref(("koriander",), "low", "N-Bedarf", 30, 15, SP_AID),
    _ref(("dill",), "none", "LWG 2166", 30, 30, SP_AID),
    _ref(("estragon",), "none", "LWG 2166", 30, 40, SP_AID),
    _ref(("kerbel",), "none", "LWG 2166", 10, 1, SP_AID),
    _ref(("thymian",), "none", "LWG 2166", 20, 20, SP_AID),
    _ref(("oregano", "dost"), "none", "LWG 2166", 20, 15, SP_AID),
    _ref(("majoran",), "none", "LWG 2166"),
    _ref(("salbei",), "none", "LWG 2166", 30, 40, SP_AID),
    _ref(("minze",), "none", "LWG 2166", 30, 30, SP_AID),
    _ref(("liebstöckel",), "none", "LWG 2166", 50, 50, SP_AID),
    _ref(("melisse",), "none", "LWG 2166", 30, 30, SP_AID),
    _ref(("rosmarin",), "none", "LWG 2166", 50, 50, SP_AID),
    # Fruchtgemüse
    _ref(("tomate",), "medium", "LWG 2202", 80, 50, SP_LWG),
    _ref(("paprika",), "medium", "Analogie", 60, 40, SP_LWG),
    _ref(("chili", "peperon", "pfefferon"), "medium", "Analogie", 60, 40, SP_LWG + " (Paprika)"),
    _ref(("aubergine",), "medium", "Analogie", 40, 40, SP_AID),
    _ref(("gurke",), "low", "LWG 2202", 150, 40, SP_AID),
    _ref(("zucchini",), "medium", "N-Bedarf", 80, 80, SP_LWG),
    _ref(("kürbis",), "medium", "N-Bedarf", 150, 150, SP_AID),
    _ref(("zuckermais", "mais"), "medium", "N-Bedarf", 45, 45, SP_LWG),
    _ref(("artischocke",), "medium", "Analogie", 100, 100, SP_AID),
    _ref(("kartoffel",), "medium", "Analogie", 60, 30, SP_LWG),
    # Kohl
    _ref(("kohlrabi",), "medium", "LWG 2202", 25, 20, SP_LWG),
    _ref(("brokkoli",), "medium", "LWG 2202", 50, 50, SP_LWG),
    _ref(("blumenkohl",), "medium", "LWG 2202", 50, 50, SP_LWG),
    _ref(("rosenkohl",), "medium", "LWG 2202", 60, 60, SP_LWG),
    _ref(("grünkohl",), "medium", "LWG 2202", 50, 50, SP_LWG),
    _ref(("chinakohl",), "medium", "LWG 2202", 40, 35, SP_LWG),
    _ref(("weißkohl", "rotkohl", "wirsing", "spitzkohl", "kopfkohl"), "medium", "LWG 2202", 50, 50, SP_LWG),
    _ref(("radies",), "low", "LWG 2202", 15, 4, SP_LWG, late=1),
    _ref(("rettich",), "low", "LWG 2202", 20, 15, SP_LWG),
    _ref(("rucola", "rauke"), "low", "N-Bedarf", 15, 1, SP_AID),
    # Wurzeln und Knollen
    _ref(("möhre", "karotte"), "low", "LWG 2202", 25, 4, SP_AID, start=28),
    _ref(("pastinake",), "medium", "N-Bedarf", 40, 10, SP_LWG, start=28),
    _ref(("fenchel",), "medium", "N-Bedarf", 40, 25, SP_LWG),
    _ref(("sellerie",), "medium", "LWG 2202", 40, 40, SP_LWG),
    _ref(("rote bete", "rote rübe"), "low", "LWG 2202", 25, 8, SP_LWG, start=28),
    # Hülsenfrüchte
    _ref(("stangenbohne",), "low", "LWG 2202", 100, 50, SP_LWG),
    _ref(("dicke bohne", "ackerbohne", "puffbohne"), "low", "Analogie", 60, 12, SP_AID),
    _ref(("bohne",), "low", "LWG 2202", 40, 6, SP_LWG),
    _ref(("erbse",), "low", "LWG 2202", 50, 4, SP_LWG),
    # Blattgemüse
    _ref(("mangold",), "medium", "Analogie", 30, 30, SP_LWG),
    _ref(("spinat",), "low", "LWG 2202", 20, 10, SP_LWG),
    _ref(("feldsalat",), "low", "LWG 2202", 15, 2, SP_AID, late=1),
    _ref(("pflücksalat", "blattsalat", "schnittsalat"), "low", "N-Bedarf", 35, 35, SP_AID),
    _ref(("endivie",), "low", "LWG 2202", 30, 30, SP_LWG),
    _ref(("eissalat",), "low", "LWG 2202", 30, 30, SP_LWG),
    _ref(("salat",), "low", "LWG 2202", 25, 25, SP_LWG),
    # Lauchgewächse
    _ref(("knoblauch",), "low", "N-Bedarf", 20, 15, SP_AID),
    _ref(("zwiebel", "schalotte"), "low", "LWG 2202", 25, 5, SP_LWG, start=21),
    _ref(("lauch", "porree"), "medium", "LWG 2202", 30, 15, SP_LWG),
]

# Kräuter, die ein bestehender Garten einmal dazubekommt (neue Gärten haben sie aus seed.CROPS)
HERBS = ("Dill", "Koriander", "Estragon", "Schnittlauch", "Kerbel", "Bohnenkraut", "Thymian", "Oregano", "Salbei", "Minze")


def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def reference_for(name: str) -> Optional[dict]:
    low = (name or "").lower()
    return next((r for r in REFERENCE if any(w in low for w in r["words"])), None)


# ---------------------------------------------------------------- Einrichten

def init(conn) -> None:
    conn.executescript(SCHEMA)
    for table, columns in (("crops", CROP_COLUMNS), ("plantings", PLANTING_COLUMNS)):
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    seed(conn)


def seed(conn, force: bool = False) -> None:
    """Düngerliste anlegen, einmal die Kräuter ergänzen und den Kulturen einmal ihre Düngestufe geben."""
    if conn.execute("SELECT COUNT(*) FROM fertilizers").fetchone()[0] == 0:
        conn.executemany("INSERT INTO fertilizers(name, n_pct, speed, note, sort) VALUES (?, ?, ?, ?, ?)",
                         [(*f, i) for i, f in enumerate(FERTILIZERS)])
    known = {r["id"] for r in db.rows(conn, "SELECT id FROM fertilizers")}
    current = conn.execute("SELECT value FROM settings WHERE key = 'fert_id'").fetchone()
    if not current or not str(current[0]).isdigit() or int(current[0]) not in known:
        first = conn.execute("SELECT id FROM fertilizers ORDER BY sort, id LIMIT 1").fetchone()
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('fert_id', ?)", (str(first[0]),))
    seeded = {r[0] for r in conn.execute("SELECT key FROM settings WHERE key IN (?, ?)", (SEEDED_KEY, HERBS_KEY))}
    if HERBS_KEY not in seeded and not force:
        add_herbs(conn)
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (HERBS_KEY,))
    if SEEDED_KEY in seeded and not force:
        return
    for c in db.rows(conn, "SELECT id, name FROM crops WHERE feed = ''"):
        ref = reference_for(c["name"])
        if ref:
            conn.execute("UPDATE crops SET feed = ?, feed_cut = ?, feed_start = ?, feed_late = ?, feed_src = ? WHERE id = ?",
                         (ref["feed"], ref["feed_cut"], ref["feed_start"], ref["feed_late"], ref["feed_src"], c["id"]))
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, '1')", (HERBS_KEY,))


def add_herbs(conn) -> list[str]:
    """Gängige Kräuter als Kulturen ergänzen, soweit es sie unter diesem Namen noch nicht gibt."""
    from .seed import CROPS
    have = {r["name"].strip().lower() for r in db.rows(conn, "SELECT name FROM crops")}
    added = []
    for row in CROPS:
        if row[0] in HERBS and row[0].lower() not in have:
            conn.execute("""INSERT INTO crops(name, family, color, method, nursery_days, field_days,
                                              harvest_days, row_spacing, plant_spacing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", row)
            added.append(row[0])
    return added


def lists(conn) -> dict:
    return {"fertilizers": db.rows(conn, "SELECT * FROM fertilizers ORDER BY sort, id")}


def export_tables(conn) -> dict:
    return lists(conn)


def import_tables(conn, data: dict) -> None:
    items = data.get("fertilizers")
    if isinstance(items, list) and items:
        conn.execute("DELETE FROM fertilizers")
        cols = {r["name"] for r in db.rows(conn, "PRAGMA table_info(fertilizers)")}
        for item in items:
            record = {k: v for k, v in item.items() if k in cols}
            conn.execute(f"INSERT INTO fertilizers({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                         list(record.values()))
    # ältere Sicherung ohne Düngung: Stufen nach dem Namen; Kräuter kommen nicht ungefragt dazu
    seed(conn, force=True)


# ---------------------------------------------------------------- Düngerliste

class FertilizerIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    n_pct: Optional[float] = Field(None, gt=0, le=50)
    speed: Optional[Literal["slow", "fast"]] = None
    note: Optional[str] = Field(None, max_length=200)


def _get(conn, fert_id: int) -> dict:
    row = conn.execute("SELECT * FROM fertilizers WHERE id = ?", (fert_id,)).fetchone()
    if row is None:
        _err(404, "Diesen Dünger gibt es nicht")
    return dict(row)


@router.post("/api/fertilizers", status_code=201)
def create_fertilizer(body: FertilizerIn):
    record = body.model_dump(exclude_none=True)
    if "name" not in record or "n_pct" not in record:
        _err(422, "Name und Stickstoffgehalt angeben")
    record["name"] = record["name"].strip()
    with db.session() as conn:
        record["sort"] = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM fertilizers").fetchone()[0]
        cur = conn.execute(f"INSERT INTO fertilizers({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                           list(record.values()))
        return _get(conn, cur.lastrowid)


@router.patch("/api/fertilizers/{fert_id}")
def update_fertilizer(fert_id: int, body: FertilizerIn):
    changes = body.model_dump(exclude_none=True)
    with db.session() as conn:
        _get(conn, fert_id)
        if changes:
            conn.execute(f"UPDATE fertilizers SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), fert_id])
        return _get(conn, fert_id)


@router.delete("/api/fertilizers/{fert_id}", status_code=204)
def delete_fertilizer(fert_id: int):
    with db.session() as conn:
        _get(conn, fert_id)
        if conn.execute("SELECT COUNT(*) FROM fertilizers").fetchone()[0] <= 1:
            _err(409, "Ein Dünger muss in der Liste bleiben")
        conn.execute("DELETE FROM fertilizers WHERE id = ?", (fert_id,))
        chosen = conn.execute("SELECT value FROM settings WHERE key = 'fert_id'").fetchone()
        if chosen and chosen[0] == str(fert_id):
            first = conn.execute("SELECT id FROM fertilizers ORDER BY sort, id LIMIT 1").fetchone()
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('fert_id', ?)", (str(first[0]),))
    return Response(status_code=204)


# ---------------------------------------------------------------- Richtwerte abgleichen

@router.get("/api/crops/reference")
def crop_reference():
    """Je Kultur des Gartens die Richtwerte aus den Quellen neben den eigenen Werten – zum Prüfen und Übernehmen."""
    with db.session() as conn:
        out = []
        for c in db.rows(conn, "SELECT * FROM crops ORDER BY name COLLATE NOCASE"):
            ref = reference_for(c["name"])
            if not ref:
                out.append({"id": c["id"], "name": c["name"], "ref": None})
                continue
            out.append({"id": c["id"], "name": c["name"], "ref": {
                "row_spacing": ref["row_spacing"], "plant_spacing": ref["plant_spacing"], "spacing_src": ref["spacing_src"],
                "feed": ref["feed"], "feed_cut": ref["feed_cut"], "feed_start": ref["feed_start"], "feed_late": ref["feed_late"],
                "feed_src": ref["feed_src"]}})
        return {"levels": LEVELS, "crops": out}


@router.post("/api/crops/herbs")
def add_missing_herbs():
    """Die gängigen Kräuter nachträglich ergänzen (z. B. nach dem Einspielen einer älteren Sicherung)."""
    with db.session() as conn:
        added = add_herbs(conn)
        seed(conn, force=True)
        return {"added": added}
