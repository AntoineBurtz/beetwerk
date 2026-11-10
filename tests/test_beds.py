"""Gleich breite Beete: Breite fest, quer liegende Beete gedreht, Reihen entlang der langen Seite."""
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import baserow, goals  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c
        c.patch("/api/settings", json={"bed_mode": "individual"})


def _data(c):
    return c.get("/api/data").json()


def test_switch_to_uniform_fits_beds_and_plantings(client):
    crop = next(x for x in _data(client)["crops"] if x["name"] == "Kopfsalat")
    quer = client.post("/api/beds", json={"name": "Quer", "kind": "bed", "x": 2, "y": 3, "length": 1.2, "width": 4}).json()
    narrow = client.post("/api/beds", json={"name": "Schmal", "kind": "bed", "x": 2, "y": 9, "length": 5, "width": 1.0}).json()
    hoch = client.post("/api/beds", json={"name": "HB", "kind": "raised", "x": 9, "y": 9, "length": 2, "width": 1.0}).json()
    base = {"crop_id": crop["id"], "method": "direct", "sow_date": "2031-04-01", "harvest_start": "2031-05-15", "harvest_end": "2031-05-30"}
    p1 = client.post("/api/plantings", json={**base, "bed_id": quer["id"], "start": 0.1, "len": 0.8, "offset": 0.2, "span": 0.6}).json()
    p2 = client.post("/api/plantings", json={**base, "bed_id": narrow["id"], "start": 1, "len": 2, "offset": 0, "span": None}).json()
    p3 = client.post("/api/plantings", json={**base, "bed_id": narrow["id"], "start": 3, "len": 1, "offset": 0.5, "span": 0.5}).json()

    r = client.patch("/api/settings", json={"bed_mode": "uniform", "bed_width": 1.2})
    assert r.status_code == 200 and r.json()["bed_mode"] == "uniform"
    d = _data(client)
    beds = {b["id"]: b for b in d["beds"]}
    ps = {p["id"]: p for p in d["plantings"]}
    # quer: lange Seite wird Länge, um 90° gedreht, Mitte bleibt (2,6 / 5)
    q = beds[quer["id"]]
    assert (q["length"], q["width"], q["rotation"]) == (4, 1.2, 90)
    assert (q["x"] + q["length"] / 2, q["y"] + q["width"] / 2) == pytest.approx((2.6, 5.0))
    assert (ps[p1["id"]]["start"], ps[p1["id"]]["len"], ps[p1["id"]]["offset"], ps[p1["id"]]["span"]) == (0.2, 0.6, 0.3, 0.8)
    # schmal: breiter, Sätze über die ganze Breite bleiben das
    n = beds[narrow["id"]]
    assert (n["length"], n["width"]) == (5, 1.2) and n["y"] == pytest.approx(8.9)
    assert ps[p2["id"]]["span"] is None and ps[p2["id"]]["offset"] == 0
    assert (ps[p3["id"]]["offset"], ps[p3["id"]]["span"]) == (0.5, 0.5)
    # Hochbeet bleibt, wie es ist; alle Beete haben jetzt die Breite
    assert beds[hoch["id"]]["width"] == 1.0
    assert all(b["width"] == 1.2 for b in d["beds"] if b["kind"] == "bed")

    # neue und geänderte Beete bekommen die Breite
    nb = client.post("/api/beds", json={"name": "Neu", "kind": "bed", "x": 0, "y": 0, "length": 3, "width": 0.8}).json()
    assert nb["width"] == 1.2 and nb["y"] == pytest.approx(-0.2)
    assert client.patch(f"/api/beds/{nb['id']}", json={"width": 2}).json()["width"] == 1.2
    assert client.patch(f"/api/beds/{nb['id']}", json={"length": 6}).json()["length"] == 6


def test_beds_can_be_locked(client):
    # die Sperre ist eine Einstellung des Gartens: sie gilt auf jedem Gerät
    assert client.get("/api/data").json()["settings"].get("beds_locked", "0") == "0"
    assert client.patch("/api/settings", json={"beds_locked": "1"}).json()["beds_locked"] == "1"
    assert client.get("/api/data").json()["settings"]["beds_locked"] == "1"
    assert client.patch("/api/settings", json={"beds_locked": "ja"}).status_code == 422
    assert client.patch("/api/settings", json={"beds_locked": "0"}).json()["beds_locked"] == "0"


def test_rows_always_run_along_the_bed():
    crop = {"row_spacing": 25, "plant_spacing": 10}
    bed = {"kind": "bed", "length": 6, "width": 1.2}
    p = {"len": 0.5, "span": None, "offset": 0, "rows": None, "row_spacing": None, "plant_spacing": None, "varieties": None}
    # ein kurzer Satz über die Beetbreite: Reihen trotzdem längs im Beet – 4 Reihen à 5, nicht 2 quer à 12
    assert baserow.plant_count(p, crop, bed) == 20
    assert baserow.plant_count(p, crop, {**bed, "kind": "greenhouse"}) == 20
    assert baserow.plant_count(p, crop, {**bed, "kind": "raised"}) == 20
    # Beet breiter als lang: die lange Seite ist die Breite, dort entlang laufen die Reihen – 2 Reihen à 60
    assert baserow.plant_count(p, crop, {"kind": "bed", "length": 1.2, "width": 6}) == 2 * 60
    # ohne Beet entlang der Länge des Satzes (Breite 1 m): 4 Reihen à 5
    assert baserow.plant_count(p, crop, None) == 20


def test_goal_successions_are_full_width_strips():
    crop = {"row_spacing": 30, "plant_spacing": 30}
    assert goals._layout(12, crop) == {"rows": 3, "len": 1.2, "span": 0.9, "count": 12}
    assert goals._layout(12, crop, 1.2) == {"rows": 4, "len": 0.9, "span": 1.2, "count": 12}
    assert goals._layout(13, crop, 1.2) == {"rows": 4, "len": 1.2, "span": 1.2, "count": 16}
