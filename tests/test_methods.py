"""Anbauart je Kultur: Direktsaat oder Voranzucht, mit eigener Kulturdauer und eigenen Abständen."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import baserow, methods  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SALAT = {"method": "transplant", "nursery_days": 28, "field_days": 42, "row_spacing": 25, "plant_spacing": 25,
         "alt_field_days": 0, "alt_row_spacing": 0, "alt_plant_spacing": 0}
DILL = {"method": "direct", "nursery_days": 0, "field_days": 45, "row_spacing": 30, "plant_spacing": 30,
        "alt_field_days": 0, "alt_row_spacing": 0, "alt_plant_spacing": 0}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


def _crop(client, name):
    return next(c for c in client.get("/api/data").json()["crops"] if c["name"] == name)


def test_usual_method_is_unchanged():
    assert methods.for_method(SALAT)["field_days"] == 42 and methods.for_method(SALAT, "transplant")["estimated"] is False
    assert methods.for_method({"row_spacing": 30}, "direct") == {"row_spacing": 30, "estimated": False}  # ohne Anbauart: wie sie ist


def test_other_method_is_estimated_until_entered():
    # Direktsaat statt Voranzucht: die Anzuchtzeit kommt dazu, eine Woche Pflanzschock entfällt
    direct = methods.for_method(SALAT, "direct")
    assert (direct["method"], direct["field_days"], direct["estimated"]) == ("direct", 42 + 28 - 7, True)
    # Voranzucht statt Direktsaat: ohne eingetragene Anzucht vier Wochen; die gehen ab, der Pflanzschock kommt dazu
    tp = methods.for_method(DILL, "transplant")
    assert (tp["nursery_days"], tp["field_days"], tp["estimated"]) == (28, 45 - 28 + 7, True)
    assert methods.for_method({**DILL, "field_days": 20}, "transplant")["field_days"] == 14  # nie unter zwei Wochen
    own = methods.for_method({**SALAT, "alt_field_days": 70, "alt_row_spacing": 20, "alt_plant_spacing": 5}, "direct")
    assert (own["field_days"], own["row_spacing"], own["plant_spacing"], own["estimated"]) == (70, 20, 5, False)
    assert methods.for_method(SALAT, "direct")["row_spacing"] == 25  # ohne Angabe dieselben Abstände


def test_plant_count_uses_the_spacing_of_the_plantings_method():
    crop = {**SALAT, "alt_row_spacing": 20, "alt_plant_spacing": 5}
    bed = {"kind": "bed", "length": 6, "width": 0.8}
    p = {"len": 1.0, "span": None, "offset": 0, "rows": None, "row_spacing": None, "plant_spacing": None, "varieties": None}
    assert baserow.plant_count({**p, "method": "transplant"}, crop, bed) == 3 * 4      # 25 x 25 cm
    assert baserow.plant_count({**p, "method": "direct"}, crop, bed) == 4 * 20         # 20 x 5 cm
    assert baserow.plant_count({**p, "method": "direct", "row_spacing": 40, "plant_spacing": 50}, crop, bed) == 2 * 2  # eigene Abstände des Satzes


def test_crops_know_which_have_both_methods(client):
    crops = {c["name"]: c for c in client.get("/api/data").json()["crops"]}
    for name in ("Kopfsalat", "Dill", "Koriander", "Petersilie", "Basilikum", "Kohlrabi", "Buschbohne", "Rote Bete"):
        assert crops[name]["alt"] == 1, name
    for name in ("Tomate", "Möhre", "Kartoffel", "Knoblauch", "Radieschen"):
        assert crops[name]["alt"] == 0, name
    # wer vorgezogen werden kann, hat ein Anzuchtgefäß – auch wenn er sonst direkt gesät wird
    assert crops["Dill"]["method"] == "direct" and crops["Dill"]["sow_container_id"]
    assert crops["Möhre"]["sow_container_id"] is None


def test_crop_values_for_the_other_method_can_be_set(client):
    c = _crop(client, "Dill")
    r = client.patch(f"/api/crops/{c['id']}", json={"alt": True, "alt_field_days": 30, "alt_row_spacing": 25, "alt_plant_spacing": 20, "nursery_days": 21})
    assert r.status_code == 200
    out = r.json()
    assert (out["alt"], out["alt_field_days"], out["alt_row_spacing"], out["alt_plant_spacing"], out["nursery_days"]) == (1, 30, 25, 20, 21)
    assert client.patch(f"/api/crops/{c['id']}", json={"alt_field_days": -1}).status_code == 422
    client.patch(f"/api/crops/{c['id']}", json={"alt_field_days": 0, "alt_row_spacing": 0, "alt_plant_spacing": 0, "nursery_days": 0})


def test_succession_in_the_other_method(client):
    crop = _crop(client, "Kopfsalat")
    client.patch(f"/api/crops/{crop['id']}", json={"row_spacing": 30, "plant_spacing": 30, "alt_row_spacing": 25, "alt_plant_spacing": 10})
    body = {"crop_id": crop["id"], "start_date": "2027-07-05", "end_date": "2027-07-25", "amount": 6, "unit": "Köpfe",
            "yield_per_plant": 1, "seasonal": False}
    usual = client.post("/api/goals/preview", json=body).json()
    direct = client.post("/api/goals/preview", json={**body, "method": "direct"}).json()
    assert (usual["method"], usual["estimated"]) == ("transplant", False)
    assert (direct["method"], direct["estimated"], direct["field_days"]) == ("direct", True, crop["field_days"] + crop["nursery_days"] - 7)
    a, b = usual["successions"][0], direct["successions"][0]
    assert a["plant_date"] and b["plant_date"] is None
    # Direktsaat steht länger im Beet: gesät wird früher, als sonst gepflanzt würde
    assert b["sow_date"] < a["plant_date"] and b["harvest_start"] == a["harvest_start"]
    # eigene Abstände der Direktsaat: gleiche Pflanzenzahl auf weniger Fläche
    assert b["len"] * (b["span"] or 1) < a["len"] * (a["span"] or 1)
    made = client.post("/api/goals", json={**body, "method": "direct"}).json()
    assert made["goal"]["method"] == "direct"
    mine = [p for p in client.get("/api/data").json()["plantings"] if p["goal_id"] == made["goal"]["id"]]
    assert mine and all(p["method"] == "direct" and p["plant_date"] is None for p in mine)
    # zurück auf die übliche Anbauart: die Sätze werden umgestellt
    client.patch(f"/api/goals/{made['goal']['id']}", json={"method": ""})
    mine = [p for p in client.get("/api/data").json()["plantings"] if p["goal_id"] == made["goal"]["id"]]
    assert mine and all(p["method"] == "transplant" and p["plant_date"] for p in mine)
    assert client.post("/api/goals/preview", json={**body, "method": "hydro"}).status_code == 422
    client.delete(f"/api/goals/{made['goal']['id']}")
    client.patch(f"/api/crops/{crop['id']}", json={"alt_row_spacing": 0, "alt_plant_spacing": 0})


def test_old_backup_marks_crops_by_name(client):
    backup = client.get("/api/export").json()
    for c in backup["crops"]:
        for k in ("alt", "alt_field_days", "alt_row_spacing", "alt_plant_spacing"):
            c.pop(k, None)
    assert client.post("/api/import", json=backup).status_code == 200
    assert _crop(client, "Dill")["alt"] == 1 and _crop(client, "Tomate")["alt"] == 0
    # eine neue Sicherung behält, was abgewählt wurde
    dill = _crop(client, "Dill")
    client.patch(f"/api/crops/{dill['id']}", json={"alt": False})
    assert client.post("/api/import", json=client.get("/api/export").json()).status_code == 200
    assert _crop(client, "Dill")["alt"] == 0
    client.patch(f"/api/crops/{dill['id']}", json={"alt": True})


# ---------------------------------------------------------------- Oberfläche rechnet gleich

SCRIPT = """
import { cropFor, datesFromCrop, spacing, dayNum } from './app/static/js/util.js';
const cases = JSON.parse(process.argv[1]);
const pick = (c) => ({ method: c.method, nursery_days: c.nursery_days, field_days: c.field_days,
  row_spacing: c.row_spacing, plant_spacing: c.plant_spacing, estimated: c.estimated });
const salat = cases[0].crop;
console.log(JSON.stringify({
  same: cases.map(({ crop, method }) => pick(cropFor(crop, method))),
  direct: datesFromCrop({ ...salat, harvest_days: 14 }, dayNum('2027-04-01'), 'direct'),
  transplant: datesFromCrop({ ...salat, harvest_days: 14 }, dayNum('2027-04-01'), 'transplant'),
  spacing: [spacing({ method: 'direct' }, { ...salat, alt_row_spacing: 20, alt_plant_spacing: 5 }),
    spacing({ method: 'transplant' }, { ...salat, alt_row_spacing: 20, alt_plant_spacing: 5 }),
    spacing({ method: 'direct', row_spacing: 40 }, { ...salat, alt_row_spacing: 20, alt_plant_spacing: 5 }),
    spacing({}, salat)],
}));
"""


def test_frontend_calculates_like_the_backend():
    node = shutil.which("node")
    if not node:
        pytest.skip("node ist nicht installiert")
    cases = [{"crop": crop, "method": m}
             for crop in (SALAT, DILL, {**SALAT, "alt_field_days": 70, "alt_row_spacing": 20, "alt_plant_spacing": 5},
                          {**DILL, "nursery_days": 21}, {**DILL, "field_days": 20})
             for m in ("direct", "transplant")]
    r = subprocess.run([node, "--input-type=module", "-e", SCRIPT, json.dumps(cases)], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    keys = ("method", "nursery_days", "field_days", "row_spacing", "plant_spacing", "estimated")
    assert out["same"] == [{k: methods.for_method(c["crop"], c["method"])[k] for k in keys} for c in cases]
    # der Tag, an dem das Beet belegt wird, bleibt: Direktsaat sät an ihm, Voranzucht pflanzt an ihm
    assert out["direct"] == {"sow_date": "2027-04-01", "plant_date": None, "harvest_start": "2027-06-03", "harvest_end": "2027-06-17"}
    assert out["transplant"] == {"sow_date": "2027-03-04", "plant_date": "2027-04-01", "harvest_start": "2027-05-13", "harvest_end": "2027-05-27"}
    assert out["spacing"] == [{"row": 20, "plant": 5}, {"row": 25, "plant": 25}, {"row": 40, "plant": 5}, {"row": 25, "plant": 25}]
