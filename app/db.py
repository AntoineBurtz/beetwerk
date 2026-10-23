"""SQLite-Zugriff für Beetwerk.

Eine Datei, keine ORM-Schicht: Die Datenmengen eines Gartens sind klein,
und so bleibt die Datenbank mit jedem SQLite-Werkzeug lesbar.
"""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

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

CREATE INDEX IF NOT EXISTS plantings_bed  ON plantings(bed_id);
CREATE INDEX IF NOT EXISTS plantings_crop ON plantings(crop_id);
"""

DEFAULT_SETTINGS = {
    "garden_name": "Mein Garten",
    "garden_width": "16",
    "garden_height": "11",
    "rotation_years": "3",
}


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
    from .seed import seed_crops

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not os.access(DATA_DIR, os.W_OK):
        raise SystemExit(
            f"Beetwerk kann nicht in {DATA_DIR} schreiben. Läuft der Container mit --user, "
            f"muss der Datenordner diesem Benutzer gehören. Ohne --user regeln PUID und PGID das automatisch."
        )
    with session() as conn:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.execute("PRAGMA journal_mode = WAL")
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
        if conn.execute("SELECT COUNT(*) FROM crops").fetchone()[0] == 0:
            seed_crops(conn)


# Spalten, die nach der ersten Version dazugekommen sind
MIGRATIONS = {
    "plantings": [
        ("varieties", "TEXT NOT NULL DEFAULT ''"),     # Mischsatz: JSON-Liste [{name, count, ref?}]
        ("fill", "TEXT NOT NULL DEFAULT 'snake'"),     # Pflanzschema: snake | columns
        ("fill_start", "TEXT NOT NULL DEFAULT 'tl'"),  # Startecke: tl | tr | bl | br
    ],
}


def migrate(conn: sqlite3.Connection) -> None:
    for table, columns in MIGRATIONS.items():
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def rows(conn: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]
