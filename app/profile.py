"""Sortenprofil: die Merkmale einer Sorte.

Liegen Boniturwerte vor, gelten sie (zusammengefasst je Saison, die jüngste
Saison zählt). Bis dahin gelten die Angaben aus der Recherche im Netz oder
eigene Angaben, die in `varieties.profile` stehen. Klassen und Zahlen sind
getrennte Merkmale, z. B. Pflanzengröße „groß“ und Pflanzenhöhe 180 cm.
"""
import json
import re
from collections import Counter, defaultdict
from datetime import date
from statistics import mean, median
from typing import Any, Optional

from . import bonitur, db

PROFILE_REPEAT = {"height", "vigor"}           # regelmäßige Merkmale, deren letzter Wert die Sorte beschreibt
SKIP_TYPES = {"photo", "cross", "amount", "rated", "bbch"}
SECTION_ORDER = {s: i for i, s in enumerate(bonitur.SECTIONS)}
FRUIT_WEIGHT = {"tomato": "tom_fruit_weight", "pepper": "pep_fruit_weight"}
SOURCE_TEXT = {"bonitur": "Bonitur", "internet": "Internet", "manual": "eigene Angabe"}
MIGRATED_KEY = "profile_migrated"
# Merkmale, die Händler meist angeben: fehlen sie nach der ersten Antwort, fragt die Recherche gezielt nach
CORE = {"plant_size", "height", "fruit_size", "maturity_class", "days_to_maturity",
        "tom_growth", "tom_fruit_weight", "tom_fruit_shape", "tom_fruit_color",
        "pep_species", "pep_habit", "pep_fruit_weight", "pep_fruit_shape", "pep_fruit_color", "pep_pungency", "pep_scoville"}


def in_profile(t: dict) -> bool:
    if t["type"] in SKIP_TYPES or t["freq"] == "event":
        return False
    if t["freq"] == "repeat" and t["key"] not in PROFILE_REPEAT:
        return False
    if t["section"] == "breeding" and t["level"] == "plant":
        return False
    if t["type"] == "text" and t["level"] != "variety":
        return False
    return True


def researchable(t: dict) -> bool:
    return in_profile(t) and t["type"] in ("choice", "multi", "number") and t["section"] != "breeding"


def _sorted(traits: list[dict]) -> list[dict]:
    return sorted(traits, key=lambda t: (SECTION_ORDER.get(t["section"], 99), t["sort"], t["id"]))


def profile_traits(conn, group: str) -> list[dict]:
    rows = [bonitur.trait_out(t) for t in db.rows(conn, "SELECT * FROM traits WHERE active = 1")]
    return _sorted([t for t in rows if in_profile(t) and t["grp"] in ("all", group or "all")])


# ---------------------------------------------------------------- Werte vereinheitlichen

def _num(v) -> Optional[float]:
    """Zahl aus Text wie „180 cm“, „60–80“, „1.200“ (Mittel bei Bereichen)."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    text = str(v).replace(" ", "").replace(" ", " ")
    text = re.sub(r"(?<=\d)\.(?=\d{3}\b)", "", text)  # Tausenderpunkt
    nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", text)]
    if not nums:
        return None
    if len(nums) >= 2 and re.search(r"\d\s*(?:-|–|bis)\s*\d", text):
        return (nums[0] + nums[1]) / 2
    return nums[0]


def _match_option(options: list, value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip().lower()
    if not s:
        return None
    for o in options:
        if o.lower() == s:
            return o
    hits = [o for o in sorted(options, key=len, reverse=True) if o.lower() in s]
    if hits:
        return hits[0]
    hits = [o for o in options if s in o.lower()]
    return hits[0] if len(hits) == 1 else None


def normalize(t: dict, value: Any) -> Any:
    """Wert passend zum Merkmal oder None, wenn er nicht passt."""
    opts = t.get("options")
    if isinstance(opts, str):
        opts = bonitur._loads(opts, None)
    typ = t["type"]
    if typ == "choice":
        return _match_option(opts or [], value)
    if typ == "multi":
        items = value if isinstance(value, list) else re.split(r"[,;/]| und ", str(value or ""))
        found = [m for m in (_match_option(opts or [], x) for x in items) if m]
        return list(dict.fromkeys(found)) or None
    if typ == "number":
        n = _num(value)
        if n is None or (t.get("min") is not None and n < t["min"]) or (t.get("max") is not None and n > t["max"]):
            return None
        return round(n, 2)
    if typ == "score":
        n = _num(value)
        lo = t["min"] if t.get("min") is not None else 1
        hi = t["max"] if t.get("max") is not None else 9
        return int(round(n)) if n is not None and lo <= n <= hi else None
    if typ == "text":
        s = str(value or "").strip()
        return s[:500] or None
    return None


def clean_profile(conn, data: Any) -> str:
    """Profil aus der Oberfläche prüfen: {key: {value, source}} → JSON-Text."""
    if not isinstance(data, dict):
        return ""
    traits = {t["key"]: bonitur.trait_out(t) for t in db.rows(conn, "SELECT * FROM traits")}
    out = {}
    for key, entry in data.items():
        t = traits.get(key)
        if not t or not in_profile(t):
            continue
        raw = entry.get("value") if isinstance(entry, dict) else entry
        source = entry.get("source") if isinstance(entry, dict) else "manual"
        value = normalize(t, raw)
        if value is not None:
            out[key] = {"value": value, "source": source if source in ("internet", "manual") else "manual"}
    return json.dumps(out, ensure_ascii=False) if out else ""


def fmt(t: dict, value: Any) -> str:
    if value is None or value == "" or value == []:
        return ""
    if t["type"] == "multi" and isinstance(value, list):
        return ", ".join(map(str, value))
    if t["type"] in ("number", "score"):
        n = float(value)
        text = (f"{n:.1f}" if abs(n - round(n)) > 0.05 else f"{round(n):d}").replace(".", ",")
        if n >= 10000:
            text = f"{round(n):,}".replace(",", ".")
        if t["type"] == "number":
            return f"{text} {t['unit']}".strip()
        labels = t.get("options") if isinstance(t.get("options"), dict) else {}
        label = labels.get(text) if abs(n - round(n)) < 0.05 else None
        return f"{text} – {label}" if label else text
    return str(value)


# ---------------------------------------------------------------- Bonitur zusammenfassen

def _aggregate(t: dict, per_plant: list, own: list) -> Optional[dict]:
    """per_plant: Werte je Pflanze, own: Werte für die ganze Sorte (der letzte zählt)."""
    if own:
        return {"value": own[-1], "n": 1, "detail": "für die Sorte erfasst"}
    if not per_plant:
        return None
    n = len(per_plant)
    if t["type"] in ("number", "score"):
        nums = [float(v) for v in per_plant if _num(v) is not None]
        if not nums:
            return None
        avg = mean(nums)
        detail = f"Mittel aus {n} Pflanzen" if n > 1 else "eine Pflanze"
        if n > 1 and max(nums) != min(nums):
            detail += f", {fmt(t, min(nums))} bis {fmt(t, max(nums))}"
        return {"value": round(avg, 2), "n": n, "detail": detail}
    if t["type"] == "choice":
        counts = Counter(per_plant).most_common()
        detail = " · ".join(f"{v} ({c})" for v, c in counts) if len(counts) > 1 else f"{n} {'Pflanze' if n == 1 else 'Pflanzen'}"
        return {"value": counts[0][0], "n": n, "detail": detail}
    if t["type"] == "multi":
        counts = Counter(x for v in per_plant for x in (v if isinstance(v, list) else [v]))
        return {"value": [v for v, _ in counts.most_common()], "n": n,
                "detail": " · ".join(f"{v} ({c})" for v, c in counts.most_common())}
    if t["type"] == "text":
        return {"value": per_plant[-1], "n": n, "detail": ""}
    return None


def bonitur_profiles(conn) -> dict[int, dict[str, dict]]:
    """Für jede Sorte der Sortenliste: Merkmal → zusammengefasster Boniturwert der jüngsten Saison."""
    traits = {t["id"]: bonitur.trait_out(t) for t in db.rows(conn, "SELECT * FROM traits")}
    by_key = {t["key"]: t for t in traits.values()}
    groups = {c["id"]: c["trait_group"] or "" for c in db.rows(conn, "SELECT id, trait_group FROM crops")}
    varieties = {(v["crop_id"], v["name"].strip().lower()): v["id"] for v in db.rows(conn, "SELECT id, crop_id, name FROM varieties")}
    plantings = {}
    for p in db.rows(conn, "SELECT id, crop_id, sow_date, plant_date FROM plantings"):
        start = p["plant_date"] or p["sow_date"]
        plantings[p["id"]] = {"crop_id": p["crop_id"], "year": int(start[:4]), "start": date.fromisoformat(start)}
    plants = {pl["id"]: pl for pl in db.rows(conn, "SELECT id, planting_id, variety FROM plants")}

    # vid → key → year → {"plants": {plant_id: [(date, value)]}, "own": [(date, value)]}
    data: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {"plants": defaultdict(list), "own": []})))
    bbch: dict = defaultdict(lambda: defaultdict(dict))  # vid → year → plant_id → erster Tag mit BBCH ≥ 81
    harvest: dict = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))  # vid → year → [Gewicht, Anzahl]
    for o in db.rows(conn, "SELECT trait_id, planting_id, plant_id, variety, date, value FROM observations ORDER BY date, id"):
        pt = plantings.get(o["planting_id"])
        t = traits.get(o["trait_id"])
        if not pt or not t:
            continue
        name = plants[o["plant_id"]]["variety"] if o["plant_id"] in plants else o["variety"]
        vid = varieties.get((pt["crop_id"], (name or "").strip().lower()))
        if vid is None:
            continue
        value = bonitur._loads(o["value"])
        year = pt["year"]
        if t["key"] == "bbch" and o["plant_id"] and isinstance(value, (int, float)) and value >= 81:
            first = bbch[vid][year].setdefault(o["plant_id"], (o["date"], pt["start"]))
            if o["date"] < first[0]:
                bbch[vid][year][o["plant_id"]] = (o["date"], pt["start"])
        if t["key"] in ("harvest_weight", "harvest_count") and isinstance(value, (int, float)):
            harvest[vid][year][0 if t["key"] == "harvest_weight" else 1] += float(value)
        if not in_profile(t) or value is None:
            continue
        slot = data[vid][t["key"]][year]
        if o["plant_id"]:
            slot["plants"][o["plant_id"]].append((o["date"], value))
        else:
            slot["own"].append((o["date"], value))

    out: dict[int, dict[str, dict]] = defaultdict(dict)
    crop_of = {vid: crop for (crop, _), vid in varieties.items()}
    for vid, per_key in data.items():
        for key, years in per_key.items():
            t = by_key[key]
            for year in sorted(years, reverse=True):
                slot = years[year]
                # einmalige: erster Wert je Pflanze; Höhe und Wuchskraft: letzter Wert der Saison
                pick = (lambda vals: vals[-1][1]) if t["freq"] == "repeat" else (lambda vals: vals[0][1])
                agg = _aggregate(t, [pick(v) for v in slot["plants"].values() if v], [v for _, v in slot["own"]])
                if agg:
                    out[vid][key] = {**agg, "year": year, "years": sorted(years, reverse=True), "source": "bonitur"}
                    break
    # Abgeleitet: Tage bis Reife aus dem ersten BBCH 81, Fruchtgewicht aus der Ernte
    for vid, years in bbch.items():
        if "days_to_maturity" in out[vid] or "days_to_maturity" not in by_key:
            continue
        year = max(years)
        days = [(date.fromisoformat(d) - start).days for d, start in years[year].values()]
        if days:
            out[vid]["days_to_maturity"] = {"value": round(median(days)), "n": len(days), "year": year,
                                            "years": sorted(years, reverse=True), "source": "bonitur",
                                            "detail": f"erster Tag mit BBCH 81, Median aus {len(days)} Pflanzen"}
    for vid, years in harvest.items():
        key = FRUIT_WEIGHT.get(groups.get(crop_of.get(vid), ""))
        if not key or key in out[vid] or key not in by_key:
            continue
        for year in sorted(years, reverse=True):
            weight, count = years[year]
            if weight > 0 and count > 0:
                out[vid][key] = {"value": round(weight / count, 1), "n": int(count), "year": year,
                                 "years": sorted(years, reverse=True), "source": "bonitur",
                                 "detail": f"aus der Ernte: {fmt(by_key['harvest_weight'], weight)} aus {int(count)} {'Frucht' if int(count) == 1 else 'Früchten'}"}
                break
    return out


# ---------------------------------------------------------------- Profil zusammensetzen

def rows_for(conn, variety: dict, bon: Optional[dict] = None, traits: Optional[list] = None) -> list[dict]:
    """Alle Merkmale des Profils mit Wert und Herkunft (Bonitur vor Recherche und eigener Angabe)."""
    group = ""
    if variety.get("crop_id"):
        r = conn.execute("SELECT trait_group FROM crops WHERE id = ?", (variety["crop_id"],)).fetchone()
        group = (r["trait_group"] if r else "") or ""
    stored = bonitur._loads(variety.get("profile"), {}) if isinstance(variety.get("profile"), str) else (variety.get("profile") or {})
    bon = bon if bon is not None else bonitur_profiles(conn).get(variety.get("id"), {})
    out = []
    for t in traits if traits is not None else profile_traits(conn, group):
        b = bon.get(t["key"])
        s = stored.get(t["key"])
        eff = b or (s and {"value": s["value"], "source": s.get("source", "manual")})
        out.append({
            "key": t["key"], "name": t["name"], "section": t["section"], "type": t["type"], "unit": t["unit"],
            "options": t["options"], "min": t["min"], "max": t["max"], "hint": t["hint"],
            "researchable": researchable(t),
            "bonitur": {**b, "text": fmt(t, b["value"])} if b else None,
            "stored": {**s, "text": fmt(t, s["value"])} if s else None,
            "value": eff["value"] if eff else None,
            "source": eff["source"] if eff else None,
            "text": fmt(t, eff["value"]) if eff else "",
        })
    return out


def summaries(conn) -> dict[int, list[dict]]:
    """Kurzfassung je Sorte: nur Merkmale mit Wert."""
    bon = bonitur_profiles(conn)
    groups = {c["id"]: c["trait_group"] or "" for c in db.rows(conn, "SELECT id, trait_group FROM crops")}
    cache: dict[str, list] = {}
    out = {}
    for v in db.rows(conn, "SELECT * FROM varieties"):
        g = groups.get(v["crop_id"], "")
        if g not in cache:
            cache[g] = profile_traits(conn, g)
        out[v["id"]] = [{"key": r["key"], "name": r["name"], "text": r["text"], "source": r["source"],
                         "year": (r["bonitur"] or {}).get("year")}
                        for r in rows_for(conn, v, bon.get(v["id"], {}), cache[g]) if r["text"]]
    return out


# ---------------------------------------------------------------- Ältere Freitextfelder übernehmen

def migrate_legacy(conn) -> None:
    """Wuchs, Fruchtfarbe und Reife standen bis Version 3 als Freitext in der Sortenliste.

    Was sich einem Merkmal zuordnen lässt, wandert ins Profil (Klasse und Zahl getrennt),
    der Rest in die Notizen. Läuft einmal.
    """
    if conn.execute("SELECT 1 FROM settings WHERE key = ?", (MIGRATED_KEY,)).fetchone():
        return
    traits = {t["key"]: bonitur.trait_out(t) for t in db.rows(conn, "SELECT * FROM traits")}
    groups = {c["id"]: c["trait_group"] or "" for c in db.rows(conn, "SELECT id, trait_group FROM crops")}
    for v in db.rows(conn, "SELECT * FROM varieties WHERE growth <> '' OR color <> '' OR maturity <> ''"):
        group = groups.get(v["crop_id"], "")
        profile = bonitur._loads(v["profile"], {}) or {}
        notes = []

        def put(key, raw):
            t = traits.get(key)
            if not t or key in profile:
                return False
            value = normalize(t, raw)
            if value is None:
                return False
            profile[key] = {"value": value, "source": "internet"}
            return True

        def exact(key, raw):
            return key in profile and str(profile[key]["value"]).lower() == raw.strip().lower()

        # Was sich nicht genau zuordnen lässt, bleibt zusätzlich in den Notizen stehen
        for raw, label, keys in ((v["growth"], "Wuchs", {"tomato": "tom_growth", "pepper": "pep_habit"}),
                                 (v["color"], "Fruchtfarbe", {"tomato": "tom_fruit_color", "pepper": "pep_fruit_color"})):
            key = keys.get(group, "")
            if raw and not (put(key, raw) and exact(key, raw)):
                notes.append(f"{label}: {raw}")
        if v["maturity"]:
            cls = put("maturity_class", v["maturity"])
            m = re.search(r"(\d+)(?:\s*(?:-|–|bis)\s*(\d+))?\s*Tage", v["maturity"])
            days = put("days_to_maturity", m.group(0)) if m else False
            if not (cls and days) and not exact("maturity_class", v["maturity"]):
                notes.append(f"Reife: {v['maturity']}")
        new_notes = "\n".join(filter(None, [v["notes"], *notes]))
        conn.execute("UPDATE varieties SET profile = ?, notes = ?, growth = '', color = '', maturity = '' WHERE id = ?",
                     (json.dumps(profile, ensure_ascii=False) if profile else "", new_notes, v["id"]))
    conn.execute("INSERT INTO settings(key, value) VALUES (?, '1')", (MIGRATED_KEY,))
