"""Bonitur: Merkmalkatalog, Einzelpflanzen und Beobachtungen.

Die eingebauten Merkmale folgen der Liste „Bonitur-Merkmale für Beetwerk“,
angelehnt an die UPOV-Prüfrichtlinien TG/44 (Tomate) und TG/76 (Paprika).
Sie werden bei jedem Start abgeglichen; ob ein Merkmal aktiv ist, bleibt
dabei erhalten. Eigene Merkmale lassen sich in der App ergänzen.

Jeder Wert ist eine eigene Zeile (Pflanze oder Sorte · Datum · Merkmal · Wert),
damit er sich später einzeln nach Baserow übertragen lässt.
"""
import csv
import io
import json
import math
import re
import secrets
from datetime import date, datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, field_validator

from . import db

router = APIRouter()

PHOTO_DIR = db.DATA_DIR / "photos"
PHOTO_MAX_BYTES = 25 * 1024 * 1024
PHOTO_SIZE = 2000
THUMB_SIZE = 480

# ---------------------------------------------------------------- Katalog

PRESENT = ["fehlend", "vorhanden"]
YES_NO = ["ja", "nein"]
INFESTATION = {"1": "kein Befall", "5": "mittel", "9": "sehr stark"}

# Passender Zeitpunkt als BBCH-Bereich (Nachtschattengewächse)
SEEDLING = (10, 12)
YOUNG = (12, 69)
FROM_BLOOM = (61, 99)
BLOOM = (61, 69)
UNRIPE = (71, 79)
FRUIT_SET = (71, 89)
RIPE = (81, 99)
SEASON_END = (85, 99)

SECTIONS = ("regular", "plant", "flower", "fruit", "taste", "breeding")
TYPES = ("bbch", "score", "choice", "multi", "number", "text", "photo", "rated", "cross", "amount")


def _t(key, name, type_, *, grp="all", section="plant", freq="once", level="both", options=None, unit="",
       min_=None, max_=None, samples=0, bbch=None, stage="", hint="", ref=""):
    if type_ == "score" and min_ is None:
        min_, max_ = 1, 9
    return dict(key=key, name=name, type=type_, grp=grp, section=section, freq=freq, level=level,
                options=json.dumps(options, ensure_ascii=False) if options is not None else "",
                unit=unit, min=min_, max=max_, samples=samples,
                bbch_from=bbch[0] if bbch else None, bbch_to=bbch[1] if bbch else None,
                stage=stage, hint=hint, ref=ref)


def _regular(key, name, type_, **kw):
    return _t(key, name, type_, section="regular", freq=kw.pop("freq", "repeat"), level=kw.pop("level", "plant"), **kw)


TRAITS = [
    # Für alle Kulturen, regelmäßig
    _regular("bbch", "BBCH-Stadium", "bbch", stage="wöchentlich",
             hint="Blüh- und Reifebeginn rechnet Beetwerk daraus aus"),
    _regular("height", "Pflanzenhöhe", "number", unit="cm", min_=0, max_=600, stage="alle 2 Wochen",
             hint="Boden bis Triebspitze"),
    _regular("vigor", "Wuchskraft", "score", options={"1": "sehr schwach", "5": "mittel", "9": "sehr stark"},
             stage="alle 2 Wochen", hint="Gesamteindruck von Masse und Vitalität"),
    _regular("disease", "Krankheitsbefall", "rated",
             options=["Krautfäule", "Dürrfleckenkrankheit", "Echter Mehltau", "Grauschimmel"],
             stage="bei Auftreten", hint="Erreger wählen, dann Note: 1 = kein Befall, 9 = sehr stark"),
    _regular("pests", "Schädlingsbefall", "rated",
             options=["Blattläuse", "Weiße Fliege", "Spinnmilben", "Thripse"],
             stage="bei Auftreten", hint="Schädling wählen, dann Note: 1 = kein Befall, 9 = sehr stark"),
    _regular("disorders", "Physiologische Schäden", "multi",
             options=["Blütenendfäule", "Fruchtplatzen", "Sonnenbrand"], stage="bei Auftreten"),
    _regular("fruit_set", "Fruchtansatz", "number", unit="", min_=0, bbch=FRUIT_SET, stage="wöchentlich ab Blüte",
             hint="Tomate: Fruchtstände mit Ansatz; Paprika: angesetzte Früchte"),
    _regular("harvest_count", "Reife Früchte geerntet", "number", unit="Stück", min_=0, bbch=RIPE, stage="je Ernte"),
    _regular("harvest_weight", "Erntegewicht", "number", unit="g", min_=0, bbch=RIPE, stage="je Ernte",
             hint="alle reifen Früchte zusammen"),
    _regular("culls", "Aussortierte Früchte", "number", unit="Stück", min_=0, bbch=RIPE, stage="je Ernte",
             hint="geplatzt, faul, Blütenendfäule"),
    _regular("photo", "Foto", "photo", freq="event", level="both", stage="beliebig"),
    _regular("note", "Notiz", "text", freq="event", level="both", stage="beliebig"),

    # Tomate, einmalig (UPOV TG/44)
    _t("tom_hypocotyl", "Anthocyan am Hypokotyl", "choice", grp="tomato", options=PRESENT,
       bbch=SEEDLING, stage="Keimling (BBCH 10–12)", ref="UPOV 1"),
    _t("tom_growth", "Wuchstyp", "choice", grp="tomato",
       options=["determiniert", "halbdeterminiert", "indeterminiert"], bbch=FROM_BLOOM, stage="ab Blüte",
       ref="UPOV 2"),
    _t("tom_leaf_type", "Blatttyp", "choice", grp="tomato", options=["Normalblatt", "Kartoffelblatt", "anderes"],
       bbch=YOUNG, stage="Jungpflanze", ref="Gärtnerpraxis"),
    _t("tom_leaf_division", "Fiederung des Blatts", "choice", grp="tomato",
       options=["einfach gefiedert", "doppelt gefiedert"], bbch=YOUNG, stage="Jungpflanze", ref="UPOV 9"),
    _t("tom_leaf_attitude", "Haltung des Blatts", "choice", grp="tomato",
       options=["aufrecht", "waagerecht", "hängend"], bbch=FROM_BLOOM, stage="ab Blüte", ref="UPOV 6"),
    _t("tom_leaf_green", "Grünfärbung des Blatts", "score", grp="tomato",
       options={"3": "hell", "5": "mittel", "7": "dunkel"}, bbch=FROM_BLOOM, stage="ab Blüte", ref="UPOV 11"),
    _t("tom_inflorescence", "Blütenstand", "choice", grp="tomato", section="flower",
       options=["einfach", "verzweigt"], bbch=BLOOM, stage="Blüte (BBCH 61–63)", ref="UPOV 16"),
    _t("tom_fasciation", "Fasziation der Blüte", "choice", grp="tomato", section="flower", options=PRESENT,
       bbch=BLOOM, stage="Blüte", ref="UPOV 17"),
    _t("tom_green_shoulder", "Grünkragen", "choice", grp="tomato", section="fruit", options=PRESENT,
       bbch=UNRIPE, stage="unreife Frucht (BBCH 71–79)", ref="UPOV 34"),
    _t("tom_fruit_weight", "Fruchtgewicht", "number", grp="tomato", section="fruit", unit="g", min_=0,
       samples=10, bbch=RIPE, stage="Reife", hint="Mittel aus 10 Früchten", ref="statt Größe UPOV 22"),
    _t("tom_fruit_length", "Fruchtlänge", "number", grp="tomato", section="fruit", unit="mm", min_=0,
       samples=5, bbch=RIPE, stage="Reife", hint="Mittel aus 5 Früchten", ref="ersetzt UPOV 23"),
    _t("tom_fruit_diameter", "Fruchtdurchmesser", "number", grp="tomato", section="fruit", unit="mm", min_=0,
       samples=5, bbch=RIPE, stage="Reife", hint="Mittel aus 5 Früchten", ref="ersetzt UPOV 23"),
    _t("tom_fruit_shape", "Fruchtform im Längsschnitt", "choice", grp="tomato", section="fruit",
       options=["abgeflacht", "rund", "zylindrisch (Roma)", "herzförmig (Ochsenherz)", "birnenförmig",
                "eiförmig", "länglich-spitz"], bbch=RIPE, stage="Reife", ref="UPOV 24"),
    _t("tom_ribbing", "Rippung am Stielende", "score", grp="tomato", section="fruit",
       options={"1": "fehlend", "5": "mittel", "9": "sehr stark"}, bbch=RIPE, stage="Reife", ref="UPOV 25"),
    _t("tom_locules", "Anzahl Fruchtkammern", "choice", grp="tomato", section="fruit",
       options=["2", "3–4", "5–6", "mehr als 6"], bbch=RIPE, stage="Reife, quer geschnitten", ref="UPOV 33"),
    _t("tom_fruit_color", "Fruchtfarbe außen", "choice", grp="tomato", section="fruit",
       options=["gelb", "orange", "rosa", "rot", "braun-schwarz", "grün", "zweifarbig"], bbch=RIPE,
       stage="Reife (BBCH 89)", ref="Gärtnerpraxis"),
    _t("tom_flesh_color", "Fleischfarbe", "choice", grp="tomato", section="fruit",
       options=["gelb", "orange", "rosa", "rot", "braun", "grün"], bbch=RIPE, stage="Reife", ref="UPOV 39"),
    _t("tom_stripes", "Streifen oder Marmorierung", "choice", grp="tomato", section="fruit", options=PRESENT,
       bbch=RIPE, stage="Reife", ref="Gärtnerpraxis"),
    _t("tom_firmness", "Festigkeit", "score", grp="tomato", section="fruit",
       options={"1": "sehr weich", "5": "mittel", "9": "sehr fest"}, bbch=RIPE, stage="Reife", ref="UPOV 40"),
    _t("tom_cracking", "Platzneigung", "score", grp="tomato", section="fruit",
       options={"1": "keine", "5": "mittel", "9": "sehr stark"}, bbch=SEASON_END, stage="Saisonende",
       ref="Gärtnerpraxis"),
    _t("tom_brix", "Zuckergehalt", "number", grp="tomato", section="fruit", unit="°Brix", min_=0, max_=40,
       bbch=RIPE, stage="Reife", hint="mit dem Refraktometer", ref="statt Trockensubstanz UPOV 44"),
    _t("tom_sweet", "Süße", "score", grp="tomato", section="taste",
       options={"1": "gar nicht", "5": "mittel", "9": "sehr süß"}, bbch=RIPE, stage="Verkostung"),
    _t("tom_acid", "Säure", "score", grp="tomato", section="taste",
       options={"1": "gar nicht", "5": "mittel", "9": "sehr sauer"}, bbch=RIPE, stage="Verkostung"),
    _t("tom_aroma", "Aroma", "score", grp="tomato", section="taste",
       options={"1": "schwach", "5": "mittel", "9": "sehr intensiv"}, bbch=RIPE, stage="Verkostung"),
    _t("tom_texture", "Textur", "choice", grp="tomato", section="taste", options=["saftig", "fest", "mehlig"],
       bbch=RIPE, stage="Verkostung"),
    _t("tom_skin", "Schale", "choice", grp="tomato", section="taste", options=["dünn", "mittel", "zäh"],
       bbch=RIPE, stage="Verkostung"),
    _t("tom_taste", "Gesamturteil Geschmack", "score", grp="tomato", section="taste",
       options={"1": "sehr schlecht", "5": "mittel", "9": "sehr gut"}, bbch=RIPE, stage="Verkostung"),
    _t("tom_late_blight", "Krautfäule zum Saisonende", "score", grp="tomato", options=INFESTATION,
       bbch=SEASON_END, stage="Saisonende", ref="Beobachtung im Freiland"),

    # Paprika und Chili, einmalig (UPOV TG/76)
    _t("pep_species", "Art", "choice", grp="pepper", level="variety",
       options=["C. annuum", "C. chinense", "C. baccatum", "C. frutescens", "C. pubescens"],
       stage="einmal je Sorte", hint="wichtig für die Kreuzbarkeit"),
    _t("pep_habit", "Wuchsform", "choice", grp="pepper", options=["aufrecht", "halbaufrecht", "liegend"],
       bbch=FROM_BLOOM, stage="ab Blüte", ref="UPOV 2"),
    _t("pep_stem_anthocyanin", "Anthocyan an Knoten und Stängel", "choice", grp="pepper", options=PRESENT,
       bbch=YOUNG, stage="Jungpflanze", ref="Gärtnerpraxis"),
    _t("pep_leaf_shape", "Blattform", "choice", grp="pepper", options=["lanzettlich", "eiförmig", "breit elliptisch"],
       bbch=FROM_BLOOM, stage="ab Blüte", ref="UPOV 14"),
    _t("pep_leaf_green", "Grünfärbung des Blatts", "score", grp="pepper",
       options={"1": "sehr hell", "5": "mittel", "9": "sehr dunkel"}, bbch=FROM_BLOOM, stage="ab Blüte",
       ref="UPOV 13"),
    _t("pep_peduncle", "Haltung des Blütenstiels", "choice", grp="pepper", section="flower",
       options=["aufrecht", "intermediär", "hängend"], bbch=BLOOM, stage="Blüte", ref="UPOV 19"),
    _t("pep_anther", "Anthocyan im Staubbeutel", "choice", grp="pepper", section="flower", options=PRESENT,
       bbch=BLOOM, stage="Blüte", ref="UPOV 20"),
    _t("pep_corolla", "Farbe der Blütenkrone", "choice", grp="pepper", section="flower",
       options=["weiß", "grünlich-weiß", "lila", "weiß mit Flecken"], bbch=BLOOM, stage="Blüte",
       ref="Gärtnerpraxis"),
    _t("pep_flowers_node", "Blüten je Knoten", "choice", grp="pepper", section="flower",
       options=["1", "2", "3 und mehr"], bbch=BLOOM, stage="Blüte", ref="Gärtnerpraxis"),
    _t("pep_unripe_color", "Fruchtfarbe vor der Reife", "choice", grp="pepper", section="fruit",
       options=["grünlich-weiß", "gelb", "grün", "purpur"], bbch=UNRIPE, stage="unreife Frucht", ref="UPOV 21"),
    _t("pep_fruit_attitude", "Stellung der Frucht", "choice", grp="pepper", section="fruit",
       options=["aufrecht", "horizontal", "hängend"], bbch=FRUIT_SET, stage="Fruchtansatz", ref="UPOV 24"),
    _t("pep_fruit_length", "Fruchtlänge", "number", grp="pepper", section="fruit", unit="mm", min_=0, samples=5,
       bbch=RIPE, stage="Reife", hint="Mittel aus 5 Früchten", ref="statt UPOV 25"),
    _t("pep_fruit_diameter", "Fruchtdurchmesser", "number", grp="pepper", section="fruit", unit="mm", min_=0,
       samples=5, bbch=RIPE, stage="Reife", hint="Mittel aus 5 Früchten", ref="statt UPOV 26"),
    _t("pep_fruit_shape", "Form im Längsschnitt", "choice", grp="pepper", section="fruit",
       options=["breitrund", "kreisförmig", "herzförmig", "quadratisch", "rechteckig", "trapezförmig",
                "leicht dreieckig", "schmal dreieckig", "hornförmig"], bbch=RIPE, stage="Reife", ref="UPOV 28"),
    _t("pep_apex", "Form der Spitze", "choice", grp="pepper", section="fruit",
       options=["sehr spitz", "spitz", "abgerundet", "leicht eingesenkt", "stark eingesenkt"], bbch=RIPE,
       stage="Reife", ref="UPOV 38"),
    _t("pep_surface", "Oberfläche", "choice", grp="pepper", section="fruit",
       options=["glatt", "leicht gerieft", "stark gerieft"], bbch=RIPE, stage="Reife", ref="UPOV 32"),
    _t("pep_fruit_color", "Fruchtfarbe bei Reife", "choice", grp="pepper", section="fruit",
       options=["gelb", "orange", "rot", "braun", "grün", "andere"], bbch=RIPE, stage="Reife (BBCH 89)",
       ref="UPOV 33"),
    _t("pep_gloss", "Glanz", "score", grp="pepper", section="fruit",
       options={"1": "matt", "5": "mittel", "9": "sehr stark"}, bbch=RIPE, stage="Reife", ref="UPOV 35"),
    _t("pep_locules", "Anzahl Fächer", "choice", grp="pepper", section="fruit",
       options=["überwiegend 2", "2 und 3", "überwiegend 3", "3 und 4", "überwiegend 4 und mehr"], bbch=RIPE,
       stage="Reife, quer geschnitten", ref="UPOV 40"),
    _t("pep_wall", "Wanddicke", "number", grp="pepper", section="fruit", unit="mm", min_=0, bbch=RIPE,
       stage="Reife", ref="statt UPOV 41"),
    _t("pep_fruit_weight", "Fruchtgewicht", "number", grp="pepper", section="fruit", unit="g", min_=0, samples=10,
       bbch=RIPE, stage="Reife", hint="Mittel aus 10 Früchten"),
    _t("pep_pungency", "Schärfe vorhanden", "choice", grp="pepper", section="taste", options=PRESENT, bbch=RIPE,
       stage="Reife", ref="UPOV 45"),
    _t("pep_heat", "Schärfegrad", "score", grp="pepper", section="taste",
       options={"0": "nicht scharf", "5": "scharf", "10": "extrem scharf"}, min_=0, max_=10, bbch=RIPE,
       stage="Verkostung", hint="Probe an der Plazenta, 2–3 Früchte"),
    _t("pep_aroma", "Aroma", "multi", grp="pepper", section="taste",
       options=["fruchtig", "zitronig", "rauchig", "grasig", "anderes"], bbch=RIPE, stage="Verkostung"),
    _t("pep_sweet", "Süße", "score", grp="pepper", section="taste",
       options={"1": "gar nicht", "5": "mittel", "9": "sehr süß"}, bbch=RIPE, stage="Verkostung"),
    _t("pep_taste", "Gesamturteil Geschmack", "score", grp="pepper", section="taste",
       options={"1": "sehr schlecht", "5": "mittel", "9": "sehr gut"}, bbch=RIPE, stage="Verkostung"),

    # Kreuzung und Saatgut, alle Kulturen
    _t("generation", "Generation", "choice", section="breeding", level="variety",
       options=["samenfeste Sorte", "F1 gekauft", "F1 eigen", "F2", "F3", "F4 und später"],
       stage="einmal je Sorte"),
    _t("parents", "Eltern", "text", section="breeding", level="variety", stage="einmal je Sorte",
       hint="Mutter × Vater"),
    _t("uniformity", "Einheitlichkeit", "choice", section="breeding", level="variety",
       options=["einheitlich", "einzelne Abweichler", "spaltet auf"], bbch=RIPE, stage="einmal zur Reife"),
    _t("off_type", "Abweichler", "choice", section="breeding", level="plant", options=YES_NO,
       stage="beliebig", hint="Pflanze passt nicht zur Sorte; was abweicht, in die Notiz"),
    _t("pollination", "Bestäubung", "choice", section="breeding", level="plant",
       options=["offen", "isoliert (Beutel, Netz)"], bbch=BLOOM, stage="vor der Blüte",
       hint="wichtig für sortenreines Saatgut, vor allem bei Chili"),
    _t("cross", "Kreuzung durchgeführt", "cross", section="breeding", freq="event", level="plant",
       bbch=BLOOM, stage="Blüte", hint="Pollenspender und markierter Blüten- oder Fruchtstand"),
    _t("seed_select", "Ausgewählt für Saatgut", "choice", section="breeding", level="plant", options=YES_NO,
       stage="beliebig"),
    _t("parent_select", "Ausgewählt als Elter", "choice", section="breeding", level="plant",
       options=["Mutter", "Vater", "nein"], stage="beliebig"),
    _t("seed_harvest", "Saatguternte", "amount", section="breeding", freq="event", level="plant",
       options=["Samen", "g"], bbch=RIPE, stage="je Ernte"),
]

SETS = [
    ("Rundgang", ["bbch", "height", "vigor", "disease"]),
    ("Ernte", ["harvest_count", "harvest_weight", "culls"]),
    ("Fruchtmerkmale", ["tom_fruit_weight", "tom_fruit_length", "tom_fruit_diameter", "tom_fruit_shape",
                        "tom_locules", "tom_fruit_color", "tom_flesh_color", "tom_brix",
                        "pep_fruit_weight", "pep_fruit_length", "pep_fruit_diameter", "pep_fruit_shape",
                        "pep_apex", "pep_fruit_color", "pep_locules", "pep_wall"]),
    ("Verkostung", ["tom_sweet", "tom_acid", "tom_aroma", "tom_texture", "tom_skin", "tom_taste",
                    "pep_pungency", "pep_heat", "pep_aroma", "pep_sweet", "pep_taste"]),
    ("Saatgut", ["pollination", "cross", "seed_select", "parent_select", "seed_harvest"]),
]

TRAIT_COLS = ("key", "name", "grp", "section", "freq", "level", "type", "options", "unit", "min", "max",
              "samples", "bbch_from", "bbch_to", "stage", "hint", "ref")
SEEDED_KEY = "bonitur_seeded"


def seed_traits(conn) -> None:
    """Eingebaute Merkmale anlegen oder auf den Stand des Programms bringen; Vorlagen einmalig anlegen."""
    cols = TRAIT_COLS + ("sort", "builtin")
    updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "key")
    for i, t in enumerate(TRAITS):
        record = {**t, "sort": i * 10, "builtin": 1}
        conn.execute(
            f"INSERT INTO traits({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
            f"ON CONFLICT(key) DO UPDATE SET {updates}",
            [record[c] for c in cols],
        )
    if conn.execute("SELECT 1 FROM settings WHERE key = ?", (SEEDED_KEY,)).fetchone() is None:
        if conn.execute("SELECT COUNT(*) FROM trait_sets").fetchone()[0] == 0:
            for i, (name, keys) in enumerate(SETS):
                conn.execute("INSERT INTO trait_sets(name, keys, sort) VALUES (?, ?, ?)",
                             (name, json.dumps(keys), i))
        conn.execute("INSERT INTO settings(key, value) VALUES (?, '1')", (SEEDED_KEY,))


# ---------------------------------------------------------------- Hilfen

def _err(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _loads(raw, default=None):
    if raw in (None, ""):
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


def _dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def trait_out(row: dict) -> dict:
    row["options"] = _loads(row.get("options"), None)
    row["active"] = bool(row["active"])
    row["builtin"] = bool(row["builtin"])
    return row


def obs_out(row: dict) -> dict:
    row["value"] = _loads(row.get("value"), None)
    row["parts"] = _loads(row.get("parts"), []) or []
    return row


def set_out(row: dict) -> dict:
    row["keys"] = _loads(row.get("keys"), []) or []
    return row


def _get(conn, table: str, item_id: int) -> dict:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        _err(404, "Eintrag nicht gefunden")
    return dict(row)


def _year_plantings(conn, year: Optional[int]) -> list[int]:
    if year is None:
        return [r[0] for r in conn.execute("SELECT id FROM plantings")]
    y = str(year)
    return [r[0] for r in conn.execute(
        "SELECT id FROM plantings WHERE substr(sow_date, 1, 4) <= ? AND substr(harvest_end, 1, 4) >= ?", (y, y))]


def _in(ids: list[int]) -> str:
    return ",".join(str(int(i)) for i in ids) or "NULL"


# ---------------------------------------------------------------- Lesen

@router.get("/api/bonitur")
def bonitur_data(year: Optional[int] = None):
    """Katalog, Vorlagen sowie Pflanzen und Werte der Sätze eines Jahres."""
    with db.session() as conn:
        ids = _in(_year_plantings(conn, year))
        return {
            "traits": [trait_out(t) for t in db.rows(conn, "SELECT * FROM traits ORDER BY sort, id")],
            "sets": [set_out(s) for s in db.rows(conn, "SELECT * FROM trait_sets ORDER BY sort, id")],
            "plants": db.rows(conn, f"SELECT * FROM plants WHERE planting_id IN ({ids}) ORDER BY planting_id, num"),
            "observations": [obs_out(o) for o in db.rows(
                conn, f"SELECT * FROM observations WHERE planting_id IN ({ids}) ORDER BY date, id")],
        }


# ---------------------------------------------------------------- Merkmale und Vorlagen

class TraitIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    grp: Optional[Literal["all", "tomato", "pepper"]] = None
    section: Optional[Literal[SECTIONS]] = None
    freq: Optional[Literal["repeat", "once", "event"]] = None
    level: Optional[Literal["plant", "variety", "both"]] = None
    type: Optional[Literal[TYPES]] = None
    options: Optional[Any] = None
    unit: Optional[str] = Field(None, max_length=20)
    min: Optional[float] = None
    max: Optional[float] = None
    samples: Optional[int] = Field(None, ge=0, le=50)
    bbch_from: Optional[int] = Field(None, ge=0, le=99)
    bbch_to: Optional[int] = Field(None, ge=0, le=99)
    stage: Optional[str] = Field(None, max_length=80)
    hint: Optional[str] = Field(None, max_length=300)
    active: Optional[bool] = None


def _clean_trait(t: dict) -> dict:
    """Prüft einen vollständigen Merkmalsdatensatz und bringt die Auswahlwerte in Form."""
    typ = t["type"]
    opts = t.get("options")
    if isinstance(opts, str):
        opts = _loads(opts, opts)
    if typ in ("choice", "multi", "rated", "amount"):
        if isinstance(opts, str):
            opts = [x for x in re.split(r"[\n;]", opts)]
        values = [str(x).strip() for x in (opts or []) if str(x).strip()]
        values = list(dict.fromkeys(values))
        if typ != "rated" and not values:
            _err(422, "Bitte mindestens einen Auswahlwert angeben")
        t["options"] = _dumps(values)
    elif typ == "score":
        labels = opts if isinstance(opts, dict) else {}
        t["options"] = _dumps({str(int(float(k))): str(v).strip() for k, v in labels.items() if str(v).strip()})
        lo = 1 if t.get("min") is None else t["min"]
        hi = 9 if t.get("max") is None else t["max"]
        if not (0 <= lo < hi <= 100) or lo != int(lo) or hi != int(hi):
            _err(422, "Notenskala: ganze Zahlen von 0 bis 100, „von“ kleiner als „bis“")
        t["min"], t["max"] = int(lo), int(hi)
    else:
        t["options"] = ""
    if t.get("min") is not None and t.get("max") is not None and t["min"] > t["max"]:
        _err(422, "Der kleinste Wert ist größer als der größte")
    if (t.get("bbch_from") is None) != (t.get("bbch_to") is None):
        _err(422, "Für den Zeitpunkt beide BBCH-Werte angeben oder keinen")
    if t.get("bbch_from") is not None and t["bbch_from"] > t["bbch_to"]:
        _err(422, "BBCH „von“ muss kleiner sein als „bis“")
    if t["type"] in ("photo", "text", "cross", "amount") and t["freq"] == "repeat":
        t["freq"] = "event"
    return t


@router.post("/api/traits", status_code=201)
def create_trait(body: TraitIn):
    given = body.model_dump(exclude_unset=True)
    if not given.get("name") or not given.get("type"):
        _err(422, "Name und Werttyp angeben")
    record = {"grp": "all", "section": "plant", "freq": "once", "level": "both", "options": None, "unit": "",
              "min": None, "max": None, "samples": 0, "bbch_from": None, "bbch_to": None, "stage": "", "hint": "",
              "ref": "eigenes Merkmal", **given}
    record["active"] = int(record.get("active", True))
    _clean_trait(record)
    with db.session() as conn:
        record["key"] = f"custom_{secrets.token_hex(4)}"
        record["sort"] = 100000 + conn.execute("SELECT COUNT(*) FROM traits WHERE builtin = 0").fetchone()[0]
        record["builtin"] = 0
        cols = list(record)
        cur = conn.execute(f"INSERT INTO traits({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                           [record[c] for c in cols])
        return trait_out(_get(conn, "traits", cur.lastrowid))


@router.patch("/api/traits/{trait_id}")
def update_trait(trait_id: int, body: TraitIn):
    changes = body.model_dump(exclude_unset=True)
    with db.session() as conn:
        current = _get(conn, "traits", trait_id)
        if current["builtin"] and set(changes) - {"active"}:
            _err(409, "Eingebaute Merkmale lassen sich nur ein- und ausschalten")
        if "active" in changes:
            changes["active"] = int(bool(changes["active"]))
        if not current["builtin"]:
            if "type" in changes and changes["type"] != current["type"]:
                used = conn.execute("SELECT COUNT(*) FROM observations WHERE trait_id = ?", (trait_id,)).fetchone()[0]
                if used:
                    _err(409, "Für dieses Merkmal gibt es schon Werte; der Werttyp bleibt deshalb gleich")
            merged = _clean_trait({**current, **changes})
            changes = {k: merged[k] for k in changes}
        if changes:
            conn.execute(f"UPDATE traits SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), trait_id])
        return trait_out(_get(conn, "traits", trait_id))


@router.delete("/api/traits/{trait_id}", status_code=204)
def delete_trait(trait_id: int):
    with db.session() as conn:
        t = _get(conn, "traits", trait_id)
        if t["builtin"]:
            _err(409, "Eingebaute Merkmale lassen sich nur ausschalten")
        used = conn.execute("SELECT COUNT(*) FROM observations WHERE trait_id = ?", (trait_id,)).fetchone()[0]
        if used:
            _err(409, f"Für dieses Merkmal gibt es {used} {'Wert' if used == 1 else 'Werte'}; schalte es stattdessen aus")
        conn.execute("DELETE FROM traits WHERE id = ?", (trait_id,))
    return Response(status_code=204)


class SetIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    keys: Optional[list[str]] = Field(None, max_length=200)


@router.post("/api/trait-sets", status_code=201)
def create_set(body: SetIn):
    if not body.name or not body.keys:
        _err(422, "Name und mindestens ein Merkmal angeben")
    with db.session() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM trait_sets").fetchone()[0]
        cur = conn.execute("INSERT INTO trait_sets(name, keys, sort) VALUES (?, ?, ?)",
                           (body.name.strip(), _dumps(body.keys), sort))
        return set_out(_get(conn, "trait_sets", cur.lastrowid))


@router.patch("/api/trait-sets/{set_id}")
def update_set(set_id: int, body: SetIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "keys" in changes:
        changes["keys"] = _dumps(changes["keys"])
    with db.session() as conn:
        _get(conn, "trait_sets", set_id)
        if changes:
            conn.execute(f"UPDATE trait_sets SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), set_id])
        return set_out(_get(conn, "trait_sets", set_id))


@router.delete("/api/trait-sets/{set_id}", status_code=204)
def delete_set(set_id: int):
    with db.session() as conn:
        _get(conn, "trait_sets", set_id)
        conn.execute("DELETE FROM trait_sets WHERE id = ?", (set_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Einzelpflanzen

class PlantSpot(BaseModel):
    variety: str = Field("", max_length=80)
    variety_ref: Optional[str] = Field(None, max_length=200)
    row: Optional[int] = Field(None, ge=1, le=1000)
    place: Optional[int] = Field(None, ge=1, le=10000)


class PlantsIn(BaseModel):
    plants: list[PlantSpot] = Field(min_length=1, max_length=5000)
    replace: bool = False


class PlantIn(BaseModel):
    planting_id: Optional[int] = None
    variety: Optional[str] = Field(None, max_length=80)
    variety_ref: Optional[str] = Field(None, max_length=200)
    row: Optional[int] = Field(None, ge=1, le=1000)
    place: Optional[int] = Field(None, ge=1, le=10000)
    label: Optional[str] = Field(None, max_length=80)
    status: Optional[Literal["ok", "gone"]] = None
    note: Optional[str] = Field(None, max_length=2000)

    @field_validator("label", "variety")
    @classmethod
    def _strip(cls, v):
        return v.strip() if isinstance(v, str) else v


class LabelsIn(BaseModel):
    labels: dict[int, str]


def _planting_name(conn, planting_id: int) -> str:
    row = conn.execute(
        "SELECT c.name AS crop, b.name AS bed FROM plantings p JOIN crops c ON c.id = p.crop_id "
        "LEFT JOIN beds b ON b.id = p.bed_id WHERE p.id = ?", (planting_id,)).fetchone()
    if row is None:
        return "einem anderen Satz"
    return f"{row['crop']} ({row['bed']})" if row["bed"] else row["crop"]


def _check_label(conn, label: str, plant_id: Optional[int]) -> None:
    if not label:
        return
    hit = conn.execute("SELECT id, num, planting_id FROM plants WHERE lower(label) = lower(?) AND id IS NOT ?",
                       (label, plant_id)).fetchone()
    if hit:
        _err(409, f"Das Etikett „{label}“ hat schon Pflanze {hit['num']} in {_planting_name(conn, hit['planting_id'])}")


def _plants_of(conn, planting_id: int) -> list[dict]:
    return db.rows(conn, "SELECT * FROM plants WHERE planting_id = ? ORDER BY num", (planting_id,))


@router.post("/api/plantings/{planting_id}/plants", status_code=201)
def fix_plants(planting_id: int, body: PlantsIn):
    """Pflanzen eines Satzes festlegen (aus dem Pflanzplan der Oberfläche)."""
    with db.session() as conn:
        _get(conn, "plantings", planting_id)
        existing = conn.execute("SELECT COUNT(*) FROM plants WHERE planting_id = ?", (planting_id,)).fetchone()[0]
        if existing and not body.replace:
            _err(409, "Für diesen Satz sind die Pflanzen schon festgelegt")
        if existing:
            used = conn.execute("SELECT COUNT(*) FROM observations WHERE planting_id = ? AND plant_id IS NOT NULL",
                                (planting_id,)).fetchone()[0]
            if used:
                _err(409, "Es gibt schon Boniturwerte für einzelne Pflanzen; füge Pflanzen lieber einzeln hinzu")
            if conn.execute("SELECT 1 FROM plants WHERE planting_id = ? AND label <> ''", (planting_id,)).fetchone():
                _err(409, "Einige Pflanzen haben schon ein Etikett; füge Pflanzen lieber einzeln hinzu")
            conn.execute("DELETE FROM plants WHERE planting_id = ?", (planting_id,))
        now = _now()
        for i, spot in enumerate(body.plants, start=1):
            conn.execute(
                "INSERT INTO plants(planting_id, num, variety, variety_ref, row, place, created_at) VALUES (?,?,?,?,?,?,?)",
                (planting_id, i, spot.variety.strip(), spot.variety_ref or "", spot.row, spot.place, now))
        return {"plants": _plants_of(conn, planting_id)}


@router.post("/api/plants", status_code=201)
def add_plant(body: PlantIn):
    if body.planting_id is None:
        _err(422, "Satz fehlt")
    with db.session() as conn:
        _get(conn, "plantings", body.planting_id)
        _check_label(conn, body.label or "", None)
        num = conn.execute("SELECT COALESCE(MAX(num), 0) + 1 FROM plants WHERE planting_id = ?",
                           (body.planting_id,)).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO plants(planting_id, num, variety, variety_ref, row, place, label, status, note, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (body.planting_id, num, body.variety or "", body.variety_ref or "", body.row, body.place,
             body.label or "", body.status or "ok", body.note or "", _now()))
        return _get(conn, "plants", cur.lastrowid)


@router.patch("/api/plants/{plant_id}")
def update_plant(plant_id: int, body: PlantIn):
    changes = body.model_dump(exclude_unset=True)
    changes.pop("planting_id", None)
    for k in ("variety", "variety_ref", "label", "note"):
        if k in changes and changes[k] is None:
            changes[k] = ""
    if changes.get("status") is None:
        changes.pop("status", None)
    with db.session() as conn:
        _get(conn, "plants", plant_id)
        if "label" in changes:
            _check_label(conn, changes["label"], plant_id)
        if changes:
            conn.execute(f"UPDATE plants SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                         [*changes.values(), plant_id])
        if "variety" in changes:
            conn.execute("UPDATE observations SET variety = ? WHERE plant_id = ?", (changes["variety"], plant_id))
        return _get(conn, "plants", plant_id)


@router.delete("/api/plants/{plant_id}", status_code=204)
def delete_plant(plant_id: int):
    with db.session() as conn:
        _get(conn, "plants", plant_id)
        used = conn.execute("SELECT COUNT(*) FROM observations WHERE plant_id = ?", (plant_id,)).fetchone()[0]
        if used:
            _err(409, f"Die Pflanze hat {used} {'Wert' if used == 1 else 'Werte'}; markiere sie stattdessen als ausgefallen")
        conn.execute("DELETE FROM plants WHERE id = ?", (plant_id,))
    return Response(status_code=204)


@router.put("/api/plantings/{planting_id}/labels")
def set_labels(planting_id: int, body: LabelsIn):
    """Etiketten mehrerer Pflanzen auf einmal setzen (z. B. eingefügte Liste)."""
    labels = {pid: (lab or "").strip() for pid, lab in body.labels.items()}
    seen = {}
    for pid, lab in labels.items():
        if lab and lab.lower() in seen:
            _err(409, f"Das Etikett „{lab}“ steht zweimal in der Liste")
        seen[lab.lower()] = pid
    with db.session() as conn:
        own = {p["id"] for p in _plants_of(conn, planting_id)}
        if not set(labels) <= own:
            _err(422, "Eine Pflanze gehört nicht zu diesem Satz")
        for pid in labels:
            conn.execute("UPDATE plants SET label = '' WHERE id = ?", (pid,))
        for pid, lab in labels.items():
            _check_label(conn, lab, pid)
            conn.execute("UPDATE plants SET label = ? WHERE id = ?", (lab, pid))
        return {"plants": _plants_of(conn, planting_id)}


# ---------------------------------------------------------------- Beobachtungen

def _iso_date(v):
    if v is None:
        return v
    try:
        date.fromisoformat(v)
    except (TypeError, ValueError) as exc:
        raise ValueError("Datum im Format JJJJ-MM-TT angeben") from exc
    return v


class EntryIn(BaseModel):
    trait_id: int
    planting_id: int
    plant_id: Optional[int] = None
    variety: Optional[str] = Field(None, max_length=80)
    date: str
    value: Any = None
    parts: Optional[list[float]] = Field(None, max_length=200)
    note: str = Field("", max_length=4000)
    photo: str = Field("", max_length=40)

    _iso = field_validator("date")(classmethod(lambda cls, v: _iso_date(v)))


class EntriesIn(BaseModel):
    entries: list[EntryIn] = Field(min_length=1, max_length=5000)


class ObsPatch(BaseModel):
    date: Optional[str] = None
    value: Any = None
    parts: Optional[list[float]] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=4000)
    photo: Optional[str] = Field(None, max_length=40)

    _iso = field_validator("date")(classmethod(lambda cls, v: _iso_date(v)))


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, str):
        v = v.strip().replace(",", ".")
        if not v:
            return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int_in(v, lo, hi, what: str) -> int:
    f = _num(v)
    if f is None or f != int(f) or not lo <= f <= hi:
        raise ValueError(f"{what} muss eine ganze Zahl von {lo:g} bis {hi:g} sein")
    return int(f)


def _text(v, limit: int, what: str) -> str:
    if not isinstance(v, str) or not v.strip():
        raise ValueError(f"{what} fehlt")
    return v.strip()[:limit]


def check_value(trait: dict, value, photo: str):
    """Wert passend zum Werttyp prüfen und vereinheitlichen; ValueError bei Unsinn."""
    typ = trait["type"]
    lo = trait["min"] if trait["min"] is not None else 1
    hi = trait["max"] if trait["max"] is not None else 9
    if typ == "bbch":
        return _int_in(value, 0, 99, "Das BBCH-Stadium")
    if typ == "score":
        return _int_in(value, lo, hi, "Die Note")
    if typ == "number":
        f = _num(value)
        if f is None:
            raise ValueError("Bitte eine Zahl eingeben")
        if trait["min"] is not None and f < trait["min"]:
            raise ValueError(f"Der Wert muss mindestens {trait['min']:g} sein")
        if trait["max"] is not None and f > trait["max"]:
            raise ValueError(f"Der Wert darf höchstens {trait['max']:g} sein")
        return round(f, 3)
    if typ == "choice":
        return _text(value, 200, "Die Auswahl")
    if typ == "multi":
        if not isinstance(value, list):
            raise ValueError("Bitte mindestens einen Wert wählen")
        items = list(dict.fromkeys(x.strip()[:200] for x in value if isinstance(x, str) and x.strip()))
        if not items:
            raise ValueError("Bitte mindestens einen Wert wählen")
        return items
    if typ == "text":
        return _text(value, 4000, "Der Text")
    if typ == "photo":
        if not photo:
            raise ValueError("Das Foto fehlt")
        return None
    if typ == "rated":
        if not isinstance(value, dict):
            raise ValueError("Erreger oder Schädling und Note angeben")
        return {"opt": _text(value.get("opt"), 120, "Erreger oder Schädling"),
                "score": _int_in(value.get("score"), lo, hi, "Die Note")}
    if typ == "cross":
        if not isinstance(value, dict):
            raise ValueError("Pollenspender angeben")
        donor = str(value.get("donor") or "").strip()[:80]
        mark = str(value.get("mark") or "").strip()[:200]
        if not donor:
            raise ValueError("Pollenspender angeben")
        return {"donor": donor, "mark": mark}
    if typ == "amount":
        if not isinstance(value, dict):
            raise ValueError("Menge angeben")
        f = _num(value.get("v"))
        if f is None or f < 0:
            raise ValueError("Menge als Zahl ab 0 angeben")
        unit = str(value.get("unit") or "").strip()[:20]
        return {"v": round(f, 3), "unit": unit}
    raise ValueError("Unbekannter Werttyp")


def _photo_ok(name: str) -> str:
    if name and not re.fullmatch(r"[0-9a-f]{20}", name):
        _err(422, "Ungültiger Fotoname")
    return name


@router.post("/api/observations")
def save_observations(body: EntriesIn):
    """Werte speichern. Einmalige Merkmale und Werte vom selben Tag werden ersetzt statt verdoppelt.

    Antwort: je Eintrag die gespeicherte Beobachtung und der Stand davor (None = neu angelegt).
    """
    out = []
    with db.session() as conn:
        traits = {t["id"]: t for t in db.rows(conn, "SELECT * FROM traits")}
        plantings = {}
        plants = {}
        now = _now()
        for e in body.entries:
            t = traits.get(e.trait_id)
            if t is None:
                _err(422, "Dieses Merkmal gibt es nicht")
            if e.planting_id not in plantings:
                plantings[e.planting_id] = _get(conn, "plantings", e.planting_id)
            if e.plant_id is not None:
                if e.plant_id not in plants:
                    plants[e.plant_id] = _get(conn, "plants", e.plant_id)
                plant = plants[e.plant_id]
                if plant["planting_id"] != e.planting_id:
                    _err(422, "Die Pflanze gehört nicht zu diesem Satz")
                if t["level"] == "variety":
                    _err(422, f"{t['name']} wird je Sorte erfasst, nicht je Pflanze")
                variety = plant["variety"]
            else:
                if t["level"] == "plant":
                    _err(422, f"{t['name']} wird je Pflanze erfasst")
                variety = (e.variety or "").strip()
            photo = _photo_ok(e.photo)
            try:
                value = check_value(t, e.value, photo)
            except ValueError as exc:
                _err(422, f"{t['name']}: {exc}")
            parts = [round(p, 3) for p in (e.parts or []) if math.isfinite(p)] if t["type"] == "number" else []

            where = ["trait_id = ?", "planting_id = ?"]
            params: list = [t["id"], e.planting_id]
            if e.plant_id is not None:
                where.append("plant_id = ?")
                params.append(e.plant_id)
            else:
                where += ["plant_id IS NULL", "variety = ?"]
                params.append(variety)
            existing = None
            if t["freq"] == "once":
                existing = conn.execute(f"SELECT * FROM observations WHERE {' AND '.join(where)} ORDER BY id LIMIT 1",
                                        params).fetchone()
            elif t["freq"] == "repeat":
                where.append("date = ?")
                params.append(e.date)
                if t["type"] == "rated":
                    where.append("json_extract(value, '$.opt') = ?")
                    params.append(value["opt"])
                existing = conn.execute(f"SELECT * FROM observations WHERE {' AND '.join(where)} ORDER BY id LIMIT 1",
                                        params).fetchone()
            record = {"date": e.date, "value": _dumps(value), "parts": _dumps(parts) if parts else "",
                      "note": e.note.strip(), "photo": photo, "variety": variety, "updated_at": now}
            if existing is not None:
                before = obs_out(dict(existing))
                if not record["note"] and t["type"] != "text":
                    record["note"] = existing["note"]
                conn.execute(f"UPDATE observations SET {', '.join(f'{k} = ?' for k in record)} WHERE id = ?",
                             [*record.values(), existing["id"]])
                oid = existing["id"]
            else:
                before = None
                record.update(trait_id=t["id"], planting_id=e.planting_id, plant_id=e.plant_id, created_at=now)
                cols = list(record)
                oid = conn.execute(
                    f"INSERT INTO observations({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [record[c] for c in cols]).lastrowid
            out.append({"obs": obs_out(_get(conn, "observations", oid)), "before": before})
    return {"saved": out}


@router.patch("/api/observations/{obs_id}")
def update_observation(obs_id: int, body: ObsPatch):
    changes = body.model_dump(exclude_unset=True)
    with db.session() as conn:
        current = _get(conn, "observations", obs_id)
        t = _get(conn, "traits", current["trait_id"])
        record = {}
        if "value" in changes or "photo" in changes:
            photo = _photo_ok(changes.get("photo", current["photo"]) or "")
            value = changes["value"] if "value" in changes else _loads(current["value"])
            try:
                record["value"] = _dumps(check_value(t, value, photo))
            except ValueError as exc:
                _err(422, f"{t['name']}: {exc}")
            record["photo"] = photo
        if changes.get("date"):
            record["date"] = changes["date"]
        if "note" in changes:
            record["note"] = (changes["note"] or "").strip()
        if "parts" in changes:
            parts = [round(p, 3) for p in (changes["parts"] or []) if math.isfinite(p)]
            record["parts"] = _dumps(parts) if parts else ""
        if record:
            record["updated_at"] = _now()
            conn.execute(f"UPDATE observations SET {', '.join(f'{k} = ?' for k in record)} WHERE id = ?",
                         [*record.values(), obs_id])
        return obs_out(_get(conn, "observations", obs_id))


@router.delete("/api/observations/{obs_id}", status_code=204)
def delete_observation(obs_id: int):
    with db.session() as conn:
        _get(conn, "observations", obs_id)
        conn.execute("DELETE FROM observations WHERE id = ?", (obs_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- Fotos

@router.post("/api/photos", status_code=201)
async def upload_photo(request: Request):
    """Foto als Rohdaten (image/jpeg, png, webp, heic soweit Pillow es kann). Gespeichert wird ein JPEG."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    raw = await request.body()
    if not raw:
        _err(422, "Kein Foto empfangen")
    if len(raw) > PHOTO_MAX_BYTES:
        _err(413, "Das Foto ist zu groß (höchstens 25 MB)")
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
    except (UnidentifiedImageError, OSError):
        _err(422, "Das ist kein lesbares Bild")
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(10)
    full = img.copy()
    full.thumbnail((PHOTO_SIZE, PHOTO_SIZE), Image.LANCZOS)
    full.save(PHOTO_DIR / f"{name}.jpg", "JPEG", quality=85, optimize=True)
    img.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
    img.save(PHOTO_DIR / f"{name}_t.jpg", "JPEG", quality=78, optimize=True)
    return {"name": name}


@router.get("/api/photos/{name}")
def get_photo(name: str, thumb: bool = False):
    if not re.fullmatch(r"[0-9a-f]{20}", name):
        _err(404, "Foto nicht gefunden")
    path = PHOTO_DIR / f"{name}{'_t' if thumb else ''}.jpg"
    if not path.exists():
        _err(404, "Foto nicht gefunden")
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------------------------------------------------------------- Ausgabe als Tabelle

def value_text(trait: dict, value) -> tuple[str, Optional[float]]:
    """Wert als lesbarer Text und, wo sinnvoll, als Zahl."""
    typ = trait["type"]
    if value is None:
        return ("Foto" if typ == "photo" else ""), None
    if typ in ("bbch", "score", "number"):
        n = _num(value)
        return (f"{n:g}".replace(".", ",") if n is not None else str(value)), n
    if typ == "multi":
        return ", ".join(value), None
    if typ == "rated":
        return f"{value.get('opt')}: {value.get('score')}", _num(value.get("score"))
    if typ == "cross":
        mark = f" ({value['mark']})" if value.get("mark") else ""
        return f"× {value.get('donor')}{mark}", None
    if typ == "amount":
        n = _num(value.get("v"))
        return f"{n:g} {value.get('unit', '')}".replace(".", ",").strip(), n
    return str(value), None


@router.get("/api/bonitur.csv")
def bonitur_csv(year: Optional[int] = None):
    with db.session() as conn:
        ids = _in(_year_plantings(conn, year))
        rows = db.rows(conn, f"""
            SELECT o.*, t.key AS t_key, t.name AS t_name, t.type AS t_type, t.unit AS t_unit, t.min AS t_min,
                   t.max AS t_max, c.name AS crop, b.name AS bed, pl.num AS plant_num, pl.label AS plant_label,
                   pl.row AS plant_row, pl.place AS plant_place, pl.variety_ref AS plant_ref
            FROM observations o
            JOIN traits t ON t.id = o.trait_id
            JOIN plantings p ON p.id = o.planting_id
            JOIN crops c ON c.id = p.crop_id
            LEFT JOIN beds b ON b.id = p.bed_id
            LEFT JOIN plants pl ON pl.id = o.plant_id
            WHERE o.planting_id IN ({ids})
            ORDER BY o.date, c.name, o.planting_id, pl.num, t.sort, o.id""")
        refs = {}
        for p in db.rows(conn, f"SELECT id, varieties FROM plantings WHERE id IN ({ids})"):
            for v in _loads(p["varieties"], []) or []:
                if v.get("ref"):
                    refs[(p["id"], v.get("name"))] = v["ref"]
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(["Nr", "Datum", "Kultur", "Beet", "Satz", "Sorte", "Sorten-Ref", "Pflanze", "Etikett", "Reihe",
                "Platz", "Ebene", "Merkmal", "Schlüssel", "Wert", "Zahl", "Einheit", "Einzelwerte", "Notiz", "Foto"])
    for r in rows:
        t = {"type": r["t_type"], "min": r["t_min"], "max": r["t_max"]}
        text, number = value_text(t, _loads(r["value"]))
        unit = r["t_unit"]
        if r["t_type"] == "amount":
            unit = (_loads(r["value"]) or {}).get("unit", "")
        parts = _loads(r["parts"], []) or []
        ref = r["plant_ref"] or refs.get((r["planting_id"], r["variety"]), "")
        w.writerow([
            r["id"], r["date"], r["crop"], r["bed"] or "", r["planting_id"], r["variety"], ref,
            r["plant_num"] if r["plant_id"] else "", r["plant_label"] or "",
            r["plant_row"] or "", r["plant_place"] or "", "Pflanze" if r["plant_id"] else "Sorte",
            r["t_name"], r["t_key"], text,
            f"{number:g}".replace(".", ",") if number is not None else "", unit,
            " ".join(f"{p:g}".replace(".", ",") for p in parts), r["note"],
            f"/api/photos/{r['photo']}" if r["photo"] else "",
        ])
    name = f"bonitur-{year}.csv" if year else "bonitur.csv"
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- Sicherung

BACKUP_TABLES = ("traits", "trait_sets", "plants", "observations")


def export_tables(conn) -> dict:
    return {t: db.rows(conn, f"SELECT * FROM {t} ORDER BY id") for t in BACKUP_TABLES}


def clear_tables(conn) -> None:
    conn.execute("DELETE FROM observations")
    conn.execute("DELETE FROM plants")


def import_tables(conn, data: dict) -> None:
    """Nach clear_tables und dem Einspielen der Sätze aufrufen."""
    conn.execute("DELETE FROM trait_sets")
    if data.get("traits"):
        conn.execute("DELETE FROM traits")
    for table in BACKUP_TABLES:
        cols = {r["name"] for r in db.rows(conn, f"PRAGMA table_info({table})")}
        for item in data.get(table) or []:
            record = {k: v for k, v in item.items() if k in cols}
            for k in ("options", "keys", "value", "parts"):
                if k in record and not isinstance(record[k], str) and record[k] is not None:
                    record[k] = _dumps(record[k])
            conn.execute(f"INSERT INTO {table}({', '.join(record)}) VALUES ({', '.join('?' for _ in record)})",
                         list(record.values()))
    seed_traits(conn)
