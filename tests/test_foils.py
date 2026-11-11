"""Folien-Vorlagen: Pflanzraster von Lochfolie je Beet."""
import json
import os
import shutil
import subprocess
import tempfile
from datetime import date, timedelta
from pathlib import Path

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import foils, goals  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
F20 = {"id": 1, "name": "Folie 20 × 20", "rows": 3, "row_spacing": 20, "plant_spacing": 20}
F40 = {"id": 2, "name": "Folie 40 × 40", "rows": 2, "row_spacing": 40, "plant_spacing": 40}
F50 = {"id": 3, "name": "Folie 50 × 50", "rows": 1, "row_spacing": 50, "plant_spacing": 50}
GRIDS = {f["id"]: f for f in (F20, F40, F50)}
SALAT = {"method": "transplant", "row_spacing": 30, "plant_spacing": 30, "foil": 1}
RADIES = {"method": "direct", "row_spacing": 15, "plant_spacing": 3, "foil": 0}
BED = {"length": 20.0, "width": 0.8, "foil_id": 1}
SATZ = {"len": 2.0, "start": 0, "offset": 0, "span": None, "rows": None, "row_spacing": None, "plant_spacing": None}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


@pytest.fixture(autouse=True)
def typical_climate(monkeypatch):
    monkeypatch.setattr(goals, "_normals", lambda: None)


def _data(client):
    return client.get("/api/data").json()


def _crop(client, name):
    return next(c for c in _data(client)["crops"] if c["name"] == name)


def _foil(client, name):
    return next(f for f in _data(client)["foils"] if f["name"] == name)


def _bed(client, **extra):
    r = client.post("/api/beds", json={"name": "Folienbeet", "kind": "bed", "length": 20, "width": 0.8, "x": 30, "y": 30, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _satz(client, crop, bed, **extra):
    body = {"crop_id": crop["id"], "bed_id": bed["id"], "method": "direct", "sow_date": "2031-05-01",
            "harvest_start": "2031-06-15", "harvest_end": "2031-07-01", "start": 0, "len": 2, **extra}
    r = client.post("/api/plantings", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _count(lay):
    return lay["rows"] * lay["per_row"]


def test_grid_of_the_foil_replaces_crop_spacing():
    # 0,8 m breites Beet, 2 m Satz: Kultur 30 × 30 gäbe 2 Reihen à 6; die Folie hat 3 Reihen à 10 Löcher
    assert _count(foils.layout(SATZ, SALAT, {**BED, "foil_id": None}, GRIDS)) == 12
    lay = foils.layout(SATZ, SALAT, BED, GRIDS)
    assert (lay["rows"], lay["per_row"], lay["row_spacing"], lay["plant_spacing"]) == (3, 10, 20, 20)
    assert _count(foils.layout(SATZ, SALAT, {**BED, "foil_id": 2}, GRIDS)) == 2 * 5
    assert _count(foils.layout(SATZ, SALAT, {**BED, "foil_id": 3}, GRIDS)) == 1 * 4
    # ohne Liste der Vorlagen oder mit gelöschter Vorlage: Abstände der Kultur
    assert _count(foils.layout(SATZ, SALAT, BED, None)) == 12
    assert _count(foils.layout(SATZ, SALAT, {**BED, "foil_id": 99}, GRIDS)) == 12


def test_crops_with_tight_spacing_keep_their_own():
    lay = foils.layout(SATZ, RADIES, BED, GRIDS)
    assert (lay["rows"], lay["per_row"], lay["foil"]) == (5, 66, None)
    assert foils.fits(SALAT) and not foils.fits(RADIES) and foils.fits({"plant_spacing": 15})


def test_planting_can_choose_its_own_grid():
    assert _count(foils.layout({**SATZ, "foil_id": 0}, SALAT, BED, GRIDS)) == 12        # ohne Folie
    assert _count(foils.layout({**SATZ, "foil_id": 2}, SALAT, BED, GRIDS)) == 10        # andere Vorlage
    assert _count(foils.layout({**SATZ, "foil_id": 1}, RADIES, BED, GRIDS)) == 30       # ausdrücklich gewählt: gilt auch für Radieschen
    assert _count(foils.layout({**SATZ, "foil_id": 1}, SALAT, {**BED, "foil_id": None}, GRIDS)) == 30
    # eigene Angaben des Satzes gehen vor: Reihen, Abstand in der Reihe, Reihenabstand
    assert _count(foils.layout({**SATZ, "rows": 2}, SALAT, BED, GRIDS)) == 2 * 10
    assert _count(foils.layout({**SATZ, "plant_spacing": 40}, SALAT, BED, GRIDS)) == 3 * 5
    assert _count(foils.layout({**SATZ, "row_spacing": 40}, SALAT, BED, GRIDS)) == 2 * 10


def test_part_of_the_width_gets_the_rows_in_its_strip():
    # Reihen der 20er-Folie liegen bei 20, 40 und 60 cm; die Reihe auf der Grenze zählt zum hinteren Streifen
    assert foils.rows_in(F20, 0.8, 0, 0.8) == 3
    assert foils.rows_in(F20, 0.8, 0, 0.4) == 1 and foils.rows_in(F20, 0.8, 0.4, 0.4) == 2
    assert foils.rows_in(F40, 0.8, 0, 0.4) == 1 and foils.rows_in(F40, 0.8, 0.4, 0.4) == 1
    assert foils.rows_in(F50, 0.8, 0, 0.3) == 1  # nie weniger als eine Reihe
    assert foils.rows_in({**F20, "rows": 6}, 0.8, 0, 0.8) == 4  # Folie breiter als das Beet: nur die Reihen bei 10, 30, 50 und 70 cm
    front = foils.layout({**SATZ, "span": 0.4}, SALAT, BED, GRIDS)
    back = foils.layout({**SATZ, "offset": 0.4}, SALAT, BED, GRIDS)
    assert (front["rows"], back["rows"]) == (1, 2)


def test_templates_and_crop_flags_are_seeded(client):
    data = _data(client)
    assert [(f["name"], f["rows"], f["row_spacing"], f["plant_spacing"]) for f in data["foils"]] == \
        [("Folie 20 × 20", 3, 20, 20), ("Folie 40 × 40", 2, 40, 40), ("Folie 50 × 50", 1, 50, 50)]
    flags = {c["name"]: c["foil"] for c in data["crops"]}
    assert flags["Kopfsalat"] == 1 and flags["Tomate"] == 1 and flags["Radieschen"] == 0 and flags["Möhre"] == 0
    # neue Kultur: ohne Angabe nach dem Pflanzabstand, mit Angabe wie gewünscht
    tight = client.post("/api/crops", json={"name": "Testrübe", "row_spacing": 25, "plant_spacing": 5}).json()
    wide = client.post("/api/crops", json={"name": "Testkohl", "row_spacing": 50, "plant_spacing": 50}).json()
    forced = client.post("/api/crops", json={"name": "Testlauch", "row_spacing": 30, "plant_spacing": 10, "foil": True}).json()
    assert (tight["foil"], wide["foil"], forced["foil"]) == (0, 1, 1)
    assert client.patch(f"/api/crops/{wide['id']}", json={"foil": False}).json()["foil"] == 0
    for c in (tight, wide, forced):
        client.delete(f"/api/crops/{c['id']}")


def test_bed_foil_and_template_crud(client):
    f20 = _foil(client, "Folie 20 × 20")
    bed = _bed(client, foil_id=f20["id"])
    assert bed["foil_id"] == f20["id"]
    assert client.patch(f"/api/beds/{bed['id']}", json={"foil_id": 9999}).status_code == 422
    assert client.patch(f"/api/beds/{bed['id']}", json={"foil_id": None}).json()["foil_id"] is None
    assert client.patch(f"/api/beds/{bed['id']}", json={"name": "Folienbeet A"}).json()["foil_id"] is None  # ohne Angabe bleibt sie
    # Vorlage anlegen und gleich Beeten zuweisen; die Liste nennt genau die Beete, auf denen sie liegt
    r = client.post("/api/foils", json={"name": "Folie 30 × 30", "rows": 2, "row_spacing": 30, "plant_spacing": 30, "bed_ids": [bed["id"]]})
    assert r.status_code == 201, r.text
    f30 = r.json()
    assert next(b for b in _data(client)["beds"] if b["id"] == bed["id"])["foil_id"] == f30["id"]
    assert client.patch(f"/api/foils/{f30['id']}", json={"rows": 3}).json()["rows"] == 3
    assert next(b for b in _data(client)["beds"] if b["id"] == bed["id"])["foil_id"] == f30["id"]  # ohne bed_ids bleibt die Zuweisung
    client.patch(f"/api/foils/{f30['id']}", json={"bed_ids": []})
    assert next(b for b in _data(client)["beds"] if b["id"] == bed["id"])["foil_id"] is None
    assert client.post("/api/foils", json={"name": "halb"}).status_code == 422
    assert client.delete(f"/api/foils/{f30['id']}").status_code == 204
    assert client.delete(f"/api/foils/{f30['id']}").status_code == 404
    client.delete(f"/api/beds/{bed['id']}")


def test_past_plantings_keep_their_grid(client):
    f20, f40 = _foil(client, "Folie 20 × 20"), _foil(client, "Folie 40 × 40")
    salat = _crop(client, "Kopfsalat")
    bed = _bed(client, foil_id=f20["id"])
    last = (date.today() - timedelta(days=200)).isoformat()
    old = _satz(client, salat, bed, sow_date=(date.today() - timedelta(days=300)).isoformat(),
                harvest_start=(date.today() - timedelta(days=230)).isoformat(), harvest_end=last)
    new = _satz(client, salat, bed, start=4)
    assert old["foil_id"] is None and new["foil_id"] is None
    # Das Beet bekommt eine andere Folie: der abgeerntete Satz behält die alte, der geplante folgt dem Beet
    client.patch(f"/api/beds/{bed['id']}", json={"foil_id": f40["id"]})
    ps = {p["id"]: p for p in _data(client)["plantings"]}
    assert ps[old["id"]]["foil_id"] == f20["id"] and ps[new["id"]]["foil_id"] is None
    # Die Folie kommt ganz weg: wer danach abgeerntet ist und dem Beet folgte, merkt sich „mit 40er-Folie“
    done = _satz(client, salat, bed, start=8, sow_date=(date.today() - timedelta(days=90)).isoformat(),
                 harvest_start=(date.today() - timedelta(days=30)).isoformat(), harvest_end=(date.today() - timedelta(days=5)).isoformat())
    client.patch(f"/api/beds/{bed['id']}", json={"foil_id": 0})
    ps = {p["id"]: p for p in _data(client)["plantings"]}
    assert ps[done["id"]]["foil_id"] == f40["id"] and ps[new["id"]]["foil_id"] is None
    # Vorlage löschen: abgeerntete Sätze bekommen ihr Raster als eigene Abstände
    extra = client.post("/api/foils", json={"name": "Folie 25 × 25", "rows": 3, "row_spacing": 25, "plant_spacing": 25}).json()
    client.patch(f"/api/plantings/{old['id']}", json={"foil_id": extra["id"]})
    client.patch(f"/api/plantings/{new['id']}", json={"foil_id": extra["id"]})
    assert client.delete(f"/api/foils/{extra['id']}").status_code == 204
    ps = {p["id"]: p for p in _data(client)["plantings"]}
    assert (ps[old["id"]]["rows"], ps[old["id"]]["row_spacing"], ps[old["id"]]["plant_spacing"], ps[old["id"]]["foil_id"]) == (3, 25, 25, None)
    assert (ps[new["id"]]["rows"], ps[new["id"]]["row_spacing"], ps[new["id"]]["foil_id"]) == (None, None, None)
    for p in (old, new, done):
        client.delete(f"/api/plantings/{p['id']}")
    client.delete(f"/api/beds/{bed['id']}")


def test_nursery_and_goals_count_with_the_foil(client):
    f20 = _foil(client, "Folie 20 × 20")
    salat = _crop(client, "Kopfsalat")
    client.patch(f"/api/crops/{salat['id']}", json={"row_spacing": 30, "plant_spacing": 30})
    bed = _bed(client, foil_id=f20["id"])
    p = _satz(client, salat, bed, variety="Folientest", method="transplant", sow_date="2033-04-01", plant_date="2033-05-01",
              harvest_start="2033-06-15", harvest_end="2033-07-01")
    plan = client.get("/api/nursery?year=2033").json()
    mine = next(b for b in plan["batches"] if b["variety"] == "Folientest")
    assert mine["own"][0]["count"] == 30  # 3 Reihen à 10 Löcher statt 2 Reihen à 6 Pflanzen
    client.patch(f"/api/plantings/{p['id']}", json={"foil_id": 0})
    plan = client.get("/api/nursery?year=2033").json()
    assert next(b for b in plan["batches"] if b["variety"] == "Folientest")["own"][0]["count"] == 12
    client.delete(f"/api/plantings/{p['id']}")
    # satzweiser Anbau: 6 Köpfe je Woche, alle 14 Tage ein Satz mit 12 Pflanzen – auf der Folie reichen 0,8 m (3 × 4)
    body = {"crop_id": salat["id"], "start_date": "2033-06-06", "end_date": "2033-07-03", "amount": 6, "unit": "Köpfe",
            "yield_per_plant": 1, "seasonal": False, "bed_id": bed["id"]}
    on_foil = client.post("/api/goals/preview", json=body).json()["successions"][0]
    client.patch(f"/api/beds/{bed['id']}", json={"foil_id": 0})
    plain = client.post("/api/goals/preview", json=body).json()["successions"][0]
    assert (on_foil["len"], on_foil["count"]) == (0.8, 12) and (plain["len"], plain["count"]) == (1.8, 12)
    client.delete(f"/api/beds/{bed['id']}")


def test_backup_keeps_foils_and_old_backup_gets_defaults(client):
    f40 = _foil(client, "Folie 40 × 40")
    salat = _crop(client, "Kopfsalat")
    bed = _bed(client, foil_id=f40["id"])
    p = _satz(client, salat, bed, foil_id=0)
    client.patch(f"/api/crops/{salat['id']}", json={"foil": False})
    backup = client.get("/api/export").json()
    assert len(backup["foils"]) == 3
    client.delete(f"/api/foils/{f40['id']}")
    data = client.post("/api/import", json=backup).json()
    assert len(data["foils"]) == 3
    assert next(b for b in data["beds"] if b["id"] == bed["id"])["foil_id"] == f40["id"]
    assert next(x for x in data["plantings"] if x["id"] == p["id"])["foil_id"] == 0
    assert next(c for c in data["crops"] if c["id"] == salat["id"])["foil"] == 0
    # ältere Sicherung ohne Folien: Beispiele, und je Kultur der Richtwert nach dem Pflanzabstand
    old = {k: v for k, v in backup.items() if k != "foils"}
    old["crops"] = [{k: v for k, v in c.items() if k != "foil"} for c in old["crops"]]
    old["beds"] = [{k: v for k, v in b.items() if k != "foil_id"} for b in old["beds"]]
    data = client.post("/api/import", json=old).json()
    assert [f["name"] for f in data["foils"]] == ["Folie 20 × 20", "Folie 40 × 40", "Folie 50 × 50"]
    flags = {c["name"]: c["foil"] for c in data["crops"]}
    assert flags["Kopfsalat"] == 1 and flags["Radieschen"] == 0
    assert all(b["foil_id"] is None for b in data["beds"])


SCRIPT = """
import { plantLayout, spacing, useFoils } from './app/static/js/util.js';
const { grids, cases } = JSON.parse(process.argv[1]);
useFoils(() => grids);
console.log(JSON.stringify(cases.map(({ p, crop, bed }) => {
  const l = plantLayout(p, crop, bed);
  const sp = spacing(p, crop, bed);
  return { rows: l.rows, per_row: l.perRow, row_spacing: sp.row, plant_spacing: sp.plant, foil: l.foil?.id ?? null,
    at: Array.from({ length: l.rows }, (_, i) => Math.round(l.rowAt(i) * 1000) / 1000) };
})));
"""


def test_frontend_calculates_like_the_backend():
    node = shutil.which("node")
    if not node:
        pytest.skip("node ist nicht installiert")
    wide = {"length": 0.8, "width": 6.0, "foil_id": 1}  # breiter als lang: Reihen entlang der Breite
    cases = [{"p": p, "crop": crop, "bed": bed}
             for crop in (SALAT, RADIES)
             for bed in (BED, {**BED, "foil_id": 2}, {**BED, "foil_id": 3}, {**BED, "foil_id": None}, wide, None)
             for p in (SATZ, {**SATZ, "foil_id": 0}, {**SATZ, "foil_id": 2}, {**SATZ, "span": 0.4}, {**SATZ, "offset": 0.4},
                       {**SATZ, "rows": 2}, {**SATZ, "row_spacing": 40}, {**SATZ, "plant_spacing": 40},
                       {**SATZ, "len": 0.4, "start": 0.4, "span": 3.0})]
    r = subprocess.run([node, "--input-type=module", "-e", SCRIPT, json.dumps({"grids": list(GRIDS.values()), "cases": cases})],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    for case, js in zip(cases, out):
        lay = foils.layout(case["p"], case["crop"], case["bed"], GRIDS)
        py = {"rows": lay["rows"], "per_row": lay["per_row"], "row_spacing": lay["row_spacing"],
              "plant_spacing": lay["plant_spacing"], "foil": lay["foil"]["id"] if lay["foil"] else None}
        assert {k: js[k] for k in py} == py, case
    # Lage der Reihen auf der Karte: volle Breite der 20er-Folie bei 20, 40 und 60 von 80 cm
    assert out[0]["at"] == [0.25, 0.5, 0.75]
    assert out[3]["at"] == [0.5]  # vorderer halber Streifen: die Reihe bei 20 cm liegt in seiner Mitte
