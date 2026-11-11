"""SQLite-Zugriff für Beetwerk.

Eine Datei, keine ORM-Schicht: Die Datenmengen eines Gartens sind klein,
und so bleibt die Datenbank mit jedem SQLite-Werkzeug lesbar.
"""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

DATA_DIR = Path(os.environ.get("BEETWERK_DATA", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "beetwerk.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS beds (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    kind     TEXT    NOT NULL DEFAULT 'bed',
    x        REAL    NOT NULL DEFAULT 0,
    y        REAL    NOT NULL DEFAULT 0,
    length   REAL    NOT NULL DEFAULT 4,
    width    REAL    NOT NULL DEFAULT 1.2,
    rotation REAL    NOT NULL DEFAULT 0,
    sort     INTEGER NOT NULL DEFAULT 0,
    notes    TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS crops (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    family        TEXT    NOT NULL DEFAULT '',
    color         TEXT    NOT NULL DEFAULT '#6a9b3c',
    method        TEXT    NOT NULL DEFAULT 'direct',
    nursery_days  INTEGER NOT NULL DEFAULT 0,
    field_days    INTEGER NOT NULL DEFAULT 60,
    harvest_days  INTEGER NOT NULL DEFAULT 21,
    row_spacing   INTEGER NOT NULL DEFAULT 30,
    plant_spacing INTEGER NOT NULL DEFAULT 30,
    notes         TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS plantings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    crop_id       INTEGER NOT NULL REFERENCES crops(id),
    variety       TEXT    NOT NULL DEFAULT '',
    bed_id        INTEGER REFERENCES beds(id) ON DELETE SET NULL,
    method        TEXT    NOT NULL DEFAULT 'direct',
    sow_date      TEXT    NOT NULL,
    plant_date    TEXT,
    harvest_start TEXT    NOT NULL,
    harvest_end   TEXT    NOT NULL,
    start         REAL    NOT NULL DEFAULT 0,
    len           REAL    NOT NULL DEFAULT 1,
    offset        REAL    NOT NULL DEFAULT 0,
    span          REAL,
    rows          INTEGER,
    row_spacing   INTEGER,
    plant_spacing INTEGER,
    sown_done     INTEGER NOT NULL DEFAULT 0,
    planted_done  INTEGER NOT NULL DEFAULT 0,
    harvest_done  INTEGER NOT NULL DEFAULT 0,
    notes         TEXT    NOT NULL DEFAULT ''
);

-- Tageswerte von Open-Meteo als Zwischenspeicher, jederzeit neu abrufbar
CREATE TABLE IF NOT EXISTS weather_days (
    day        TEXT PRIMARY KEY,
    precip     REAL,
    tmin       REAL,
    tmax       REAL,
    et0        REAL,
    forecast   INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
);

-- Tiefstwerte vergangener Jahre für die Froststatistik (Open-Meteo-Archiv)
CREATE TABLE IF NOT EXISTS climate_days (
    day  TEXT PRIMARY KEY,
    tmin REAL
);

-- Bonitur: Merkmalkatalog, Vorlagen, Einzelpflanzen und Beobachtungen
CREATE TABLE IF NOT EXISTS traits (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT    NOT NULL UNIQUE,
    name      TEXT    NOT NULL,
    grp       TEXT    NOT NULL DEFAULT 'all',     -- all | tomato | pepper
    section   TEXT    NOT NULL DEFAULT 'plant',   -- regular | plant | flower | fruit | taste | breeding
    freq      TEXT    NOT NULL DEFAULT 'once',    -- repeat | once | event
    level     TEXT    NOT NULL DEFAULT 'plant',   -- plant | variety | both
    type      TEXT    NOT NULL,                   -- bbch | score | choice | multi | number | text | photo | rated | cross | amount
    options   TEXT    NOT NULL DEFAULT '',        -- JSON: Auswahlwerte oder Beschriftung der Noten
    unit      TEXT    NOT NULL DEFAULT '',
    min       REAL,
    max       REAL,
    samples   INTEGER NOT NULL DEFAULT 0,         -- Mittel aus so vielen Einzelwerten
    bbch_from INTEGER,                            -- passender Zeitpunkt als BBCH-Bereich
    bbch_to   INTEGER,
    stage     TEXT    NOT NULL DEFAULT '',        -- Zeitpunkt in Worten
    hint      TEXT    NOT NULL DEFAULT '',
    ref       TEXT    NOT NULL DEFAULT '',        -- Vorlage, z. B. UPOV-Merkmal
    sort      INTEGER NOT NULL DEFAULT 0,
    active    INTEGER NOT NULL DEFAULT 1,
    builtin   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trait_sets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL,
    keys    TEXT    NOT NULL DEFAULT '[]',        -- JSON-Liste von Merkmal-Schlüsseln
    sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    planting_id INTEGER NOT NULL REFERENCES plantings(id),
    num         INTEGER NOT NULL,                 -- laufende Nummer im Satz
    variety     TEXT    NOT NULL DEFAULT '',
    variety_ref TEXT    NOT NULL DEFAULT '',
    row         INTEGER,
    place       INTEGER,
    label       TEXT    NOT NULL DEFAULT '',      -- eigene ID vom Pflanzenetikett, später als QR-Code
    status      TEXT    NOT NULL DEFAULT 'ok',    -- ok | gone
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trait_id    INTEGER NOT NULL REFERENCES traits(id),
    planting_id INTEGER NOT NULL REFERENCES plantings(id),
    plant_id    INTEGER REFERENCES plants(id),    -- leer = Wert gilt für die ganze Sorte im Satz
    variety     TEXT    NOT NULL DEFAULT '',
    date        TEXT    NOT NULL,
    value       TEXT    NOT NULL DEFAULT 'null',  -- JSON
    parts       TEXT    NOT NULL DEFAULT '',      -- JSON: Einzelwerte, aus denen das Mittel stammt
    note        TEXT    NOT NULL DEFAULT '',
    photo       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    synced_at   TEXT                              -- für den späteren Abgleich mit Baserow
);

-- Sortenliste: Saatgut und Sorten mit Einordnung, Foto und Quellen
CREATE TABLE IF NOT EXISTS varieties (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    crop_id      INTEGER REFERENCES crops(id),
    name         TEXT    NOT NULL,
    species      TEXT    NOT NULL DEFAULT '',   -- botanische Art
    kind         TEXT    NOT NULL DEFAULT '',   -- Typ, z. B. Fleischtomate
    seed         TEXT    NOT NULL DEFAULT '',   -- samenfest, F1, …
    growth       TEXT    NOT NULL DEFAULT '',   -- Wuchs
    color        TEXT    NOT NULL DEFAULT '',   -- Fruchtfarbe
    maturity     TEXT    NOT NULL DEFAULT '',   -- Reife
    supplier     TEXT    NOT NULL DEFAULT '',   -- Bezugsquelle
    bought       TEXT    NOT NULL DEFAULT '',   -- gekauft (Jahr)
    description  TEXT    NOT NULL DEFAULT '',
    photo        TEXT    NOT NULL DEFAULT '',
    photo_credit TEXT    NOT NULL DEFAULT '',   -- Bildquelle und Lizenz
    links        TEXT    NOT NULL DEFAULT '',   -- JSON: [{url, title}]
    notes        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);

-- In Beetwerk gelöschte Zeilen, die beim nächsten Abgleich auch in Baserow verschwinden
CREATE TABLE IF NOT EXISTS baserow_deleted (
    kind   TEXT    NOT NULL,                      -- traits | plants | observations
    row_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plantings_bed  ON plantings(bed_id);
CREATE INDEX IF NOT EXISTS plantings_crop ON plantings(crop_id);
CREATE INDEX IF NOT EXISTS plants_planting ON plants(planting_id);
CREATE INDEX IF NOT EXISTS varieties_crop ON varieties(crop_id);
CREATE UNIQUE INDEX IF NOT EXISTS plants_label ON plants(label) WHERE label <> '';
CREATE INDEX IF NOT EXISTS obs_planting ON observations(planting_id);
CREATE INDEX IF NOT EXISTS obs_plant ON observations(plant_id);
"""

DEFAULT_SETTINGS = {
    "garden_name": "Mein Garten",
    "garden_width": "16",
    "garden_height": "11",
    "rotation_years": "3",
    "bed_mode": "individual",  # "uniform": alle Beete gleich breit, Reihen entlang der langen Seite
    "bed_width": "1.2",
    "beds_locked": "0",  # "1": Beete lassen sich auf der Karte nicht verschieben, Ziehen bewegt den Ausschnitt
    "feed_factor": "100",  # Düngung in % der Empfehlung (humusreicher Boden braucht weniger)
}


def uniform_width(conn) -> Optional[float]:
    """Einheitliche Beetbreite in Metern, wenn alle Beete gleich breit sind, sonst None."""
    s = {r[0]: r[1] for r in conn.execute("SELECT key, value FROM settings WHERE key IN ('bed_mode', 'bed_width')")}
    if s.get("bed_mode") != "uniform":
        return None
    try:
        w = float(s.get("bed_width") or 1.2)
    except ValueError:
        return None
    return w if w > 0 else None


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    from . import feeding, goals, methods, nursery
    from .bonitur import seed_traits
    from .profile import migrate_legacy
    from .seed import guess_trait_groups, seed_crops

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not os.access(DATA_DIR, os.W_OK):
        raise SystemExit(
            f"Beetwerk kann nicht in {DATA_DIR} schreiben. Läuft der Container mit --user, "
            f"muss der Datenordner diesem Benutzer gehören. Ohne --user regeln PUID und PGID das automatisch."
        )
    with session() as conn:
        conn.executescript(SCHEMA)
        added = migrate(conn)
        conn.execute("PRAGMA journal_mode = WAL")
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
        if conn.execute("SELECT COUNT(*) FROM crops").fetchone()[0] == 0:
            seed_crops(conn)
            guess_trait_groups(conn)
        elif ("crops", "trait_group") in added:
            guess_trait_groups(conn)
        seed_traits(conn)
        migrate_legacy(conn)
        fresh = methods.init(conn)  # vor der Anzucht: wer vorgezogen werden kann, bekommt dort Gefäße
        nursery.init(conn)
        nursery.assign_defaults(conn, fresh)
        goals.init(conn)
        feeding.init(conn)


# Spalten, die nach der ersten Version dazugekommen sind
MIGRATIONS = {
    "climate_days": [
        ("tmax", "REAL"),
        ("precip", "REAL"),
        ("et0", "REAL"),
    ],
    # Abgleich mit Baserow: Zeilen-ID dort und Prüfsumme des zuletzt übertragenen Inhalts
    "traits": [
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
    ],
    "plants": [
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
    ],
    "observations": [
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
        ("baserow_file", "TEXT NOT NULL DEFAULT ''"),   # Dateiname des Fotos in Baserow
        ("baserow_photo", "TEXT NOT NULL DEFAULT ''"),  # welches eigene Foto dort liegt
    ],
    "crops": [
        ("trait_group", "TEXT NOT NULL DEFAULT ''"),   # Bonitur-Merkmale: '' | tomato | pepper
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
    ],
    "varieties": [
        ("profile", "TEXT NOT NULL DEFAULT ''"),        # Merkmale aus Recherche oder eigener Angabe (JSON)
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
        ("baserow_file", "TEXT NOT NULL DEFAULT ''"),
        ("baserow_photo", "TEXT NOT NULL DEFAULT ''"),
    ],
    "plantings": [
        ("baserow_id", "INTEGER"),
        ("bw_hash", "TEXT NOT NULL DEFAULT ''"),
        ("varieties", "TEXT NOT NULL DEFAULT ''"),     # Mischsatz: JSON-Liste [{name, count, ref?}]
        ("fill", "TEXT NOT NULL DEFAULT 'snake'"),     # Pflanzschema: snake | columns
        ("fill_start", "TEXT NOT NULL DEFAULT 'tl'"),  # Startecke: tl | tr | bl | br
    ],
}


def migrate(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    added = set()
    for table, columns in MIGRATIONS.items():
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                added.add((table, name))
    return added


def rows(conn: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]
