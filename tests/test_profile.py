"""Sortenprofil: Bonitur der jüngsten Saison vor Recherche und eigener Angabe."""
import json
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import db, profile  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


def _planting(client, crop, bed, year, variety):
    body = dict(crop_id=crop["id"], bed_id=bed["id"], method="transplant", sow_date=f"{year}-03-01",
                plant_date=f"{year}-05-01", harvest_start=f"{year}-07-01", harvest_end=f"{year}-09-30", len=1,
                variety=variety)
    r = client.post("/api/plantings", json=body)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    spots = [{"variety": variety, "row": 1, "place": i + 1} for i in range(3)]
    plants = client.post(f"/api/plantings/{pid}/plants", json={"plants": spots}).json()["plants"]
    return pid, plants


def _rows(client, vid):
    return {r["key"]: r for r in client.get(f"/api/varieties/{vid}/profile").json()["rows"]}


def test_profile_prefers_latest_bonitur(client):
    data = client.get("/api/data").json()
    tomate = next(c for c in data["crops"] if c["name"] == "Tomate")
    bed = data["beds"][0]
    traits = {t["key"]: t["id"] for t in client.get("/api/bonitur?year=2026").json()["traits"]}
    v = client.post("/api/varieties", json={
        "crop_id": tomate["id"], "name": "Profiltest",
        "profile": {"plant_size": {"value": "mittel", "source": "internet"},
                    "height": {"value": "150–200 cm", "source": "internet"},
                    "fruit_size": {"value": "groß", "source": "internet"},
                    "tom_fruit_weight": {"value": "300", "source": "manual"},
                    "pep_scoville": {"value": 5000, "source": "internet"},   # passt nicht zu Tomaten: bleibt außen vor
                    "tom_fruit_color": {"value": "lila", "source": "internet"},  # keine erlaubte Farbe
                    "erfunden": {"value": 1}}}).json()
    assert v["profile"]["height"] == {"value": 175, "source": "internet"}
    assert "tom_fruit_color" not in v["profile"] and "erfunden" not in v["profile"]

    rows = _rows(client, v["id"])
    assert "pep_scoville" not in rows and "plant_size" in rows and "days_to_maturity" in rows
    assert rows["plant_size"]["text"] == "mittel" and rows["plant_size"]["source"] == "internet"
    assert rows["height"]["text"] == "175 cm" and rows["tom_fruit_weight"]["source"] == "manual"

    # Vorjahr: wird von der jüngeren Saison abgelöst
    old_pid, old = _planting(client, tomate, bed, 2025, "Profiltest")
    client.post("/api/observations", json={"entries": [
        {"trait_id": traits["plant_size"], "planting_id": old_pid, "plant_id": p["id"], "date": "2025-07-01",
         "value": "sehr groß"} for p in old]})

    pid, plants = _planting(client, tomate, bed, 2026, "Profiltest")
    entries = [
        # einmalig: der erste Wert je Pflanze zählt
        {"trait_id": traits["plant_size"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-07-01", "value": "groß"},
        {"trait_id": traits["plant_size"], "planting_id": pid, "plant_id": plants[1]["id"], "date": "2026-07-01", "value": "groß"},
        {"trait_id": traits["plant_size"], "planting_id": pid, "plant_id": plants[2]["id"], "date": "2026-07-01", "value": "mittel"},
        # regelmäßig: der letzte Wert der Saison zählt
        {"trait_id": traits["height"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-06-01", "value": 60},
        {"trait_id": traits["height"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-08-01", "value": 120},
        {"trait_id": traits["height"], "planting_id": pid, "plant_id": plants[1]["id"], "date": "2026-08-01", "value": 140},
        # für die ganze Sorte
        {"trait_id": traits["maturity_class"], "planting_id": pid, "variety": "Profiltest", "date": "2026-09-01",
         "value": "früh"},
        # abgeleitet: Tage bis zur ersten reifen Frucht und Fruchtgewicht aus der Ernte
        {"trait_id": traits["bbch"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-07-10", "value": 81},
        {"trait_id": traits["bbch"], "planting_id": pid, "plant_id": plants[1]["id"], "date": "2026-07-20", "value": 85},
        {"trait_id": traits["harvest_weight"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-08-01", "value": 900},
        {"trait_id": traits["harvest_count"], "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-08-01", "value": 4},
        {"trait_id": traits["harvest_weight"], "planting_id": pid, "plant_id": plants[1]["id"], "date": "2026-08-15", "value": 600},
        {"trait_id": traits["harvest_count"], "planting_id": pid, "plant_id": plants[1]["id"], "date": "2026-08-15", "value": 2},
    ]
    r = client.post("/api/observations", json={"entries": entries})
    assert r.status_code == 200, r.text

    rows = _rows(client, v["id"])
    ps = rows["plant_size"]
    assert ps["source"] == "bonitur" and ps["text"] == "groß" and ps["bonitur"]["year"] == 2026
    assert ps["bonitur"]["n"] == 3 and "groß (2)" in ps["bonitur"]["detail"] and ps["stored"]["value"] == "mittel"
    assert ps["bonitur"]["years"] == [2026, 2025]
    assert rows["height"]["value"] == 130 and rows["height"]["source"] == "bonitur"
    assert "120 cm bis 140 cm" in rows["height"]["bonitur"]["detail"]
    assert rows["maturity_class"]["text"] == "früh" and rows["maturity_class"]["bonitur"]["detail"] == "für die Sorte erfasst"
    # 1. Mai bis 10. und 20. Juli: Median 75 Tage
    assert rows["days_to_maturity"]["value"] == 75 and rows["days_to_maturity"]["source"] == "bonitur"
    assert rows["tom_fruit_weight"]["value"] == 250 and rows["tom_fruit_weight"]["source"] == "bonitur"
    assert rows["tom_fruit_weight"]["stored"]["source"] == "manual"
    # ohne Bonitur bleibt die Recherche stehen
    assert rows["fruit_size"]["source"] == "internet" and rows["fruit_size"]["text"] == "groß"

    summary = {s["key"]: s for s in client.get("/api/varieties/profiles").json()[str(v["id"])]}
    assert summary["plant_size"]["year"] == 2026 and summary["fruit_size"]["source"] == "internet"

    # Für neue Sorten: Merkmale der Kultur ohne Werte
    empty = client.get(f"/api/profile-traits?crop_id={tomate['id']}").json()["rows"]
    assert any(r["key"] == "tom_growth" for r in empty) and all(r["value"] is None for r in empty)
    keys = [r["key"] for r in client.get("/api/profile-traits").json()["rows"]]
    assert "plant_size" in keys and "tom_growth" not in keys


def test_normalize_separates_class_and_number():
    t_num = {"type": "number", "min": 0, "max": 400, "unit": "cm", "options": None}
    assert profile.normalize(t_num, "60–80 cm") == 70
    assert profile.normalize(t_num, "1,5") == 1.5
    assert profile.normalize(t_num, "ca. 1.200") is None  # über dem Höchstwert
    assert profile.normalize({**t_num, "max": None}, "50.000 SHU") == 50000
    t_cls = {"type": "choice", "options": ["sehr klein", "klein", "mittel", "groß", "sehr groß"]}
    assert profile.normalize(t_cls, "Groß") == "groß"
    assert profile.normalize(t_cls, "sehr groß (bis 2 m)") == "sehr groß"
    assert profile.normalize(t_cls, "riesig") is None
    t_multi = {"type": "multi", "options": ["fruchtig", "rauchig", "zitronig"]}
    assert profile.normalize(t_multi, "fruchtig, leicht rauchig") == ["fruchtig", "rauchig"]
    score = {"type": "score", "min": 0, "max": 10, "unit": "", "options": {"0": "nicht scharf", "5": "scharf"}}
    assert profile.fmt(score, 5) == "5 – scharf" and profile.fmt(score, 4.5) == "4,5"


def test_legacy_fields_move_into_profile(client):
    data = client.get("/api/data").json()
    tomate = next(c for c in data["crops"] if c["name"] == "Tomate")
    with db.session() as conn:
        conn.execute("INSERT INTO varieties(crop_id, name, growth, color, maturity, notes, created_at, updated_at) "
                     "VALUES (?, 'Altbestand', 'indeterminiert (Stabtomate)', 'gelb mit roten Streifen', "
                     "'früh, etwa 65 Tage', 'Von Oma', '2026-01-01', '2026-01-01')", (tomate["id"],))
        conn.execute("DELETE FROM settings WHERE key = ?", (profile.MIGRATED_KEY,))
        profile.migrate_legacy(conn)
        row = dict(conn.execute("SELECT * FROM varieties WHERE name = 'Altbestand'").fetchone())
    assert (row["growth"], row["color"], row["maturity"]) == ("", "", "")
    stored = json.loads(row["profile"])
    assert stored["tom_growth"]["value"] == "indeterminiert" and stored["maturity_class"]["value"] == "früh"
    assert stored["days_to_maturity"]["value"] == 65 and stored["tom_fruit_color"]["value"] == "gelb"
    # nicht genau Zuordenbares bleibt zusätzlich in den Notizen
    assert row["notes"].splitlines() == ["Von Oma", "Wuchs: indeterminiert (Stabtomate)", "Fruchtfarbe: gelb mit roten Streifen"]
