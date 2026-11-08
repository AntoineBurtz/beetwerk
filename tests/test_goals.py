"""Ernteziele: Folgesätze rückwärts aus der Erntemenge je Woche."""
import os
import tempfile
from datetime import date

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import goals  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


@pytest.fixture(autouse=True)
def typical_climate(monkeypatch):
    monkeypatch.setattr(goals, "_normals", lambda: None)  # ohne Wetterdaten: typische Monatsmittel


def _crop(client, name):
    return next(c for c in client.get("/api/data").json()["crops"] if c["name"] == name)


def _goal_plantings(client, gid):
    return sorted((p for p in client.get("/api/data").json()["plantings"] if p.get("goal_id") == gid),
                  key=lambda p: p["goal_seq"])


def test_preview_fixed_duration(client):
    salat = _crop(client, "Kopfsalat")
    assert (salat["nursery_days"], salat["field_days"], salat["harvest_days"]) == (28, 42, 14)
    r = client.post("/api/goals/preview", json={"crop_id": salat["id"], "start_date": "2031-05-05", "end_date": "2031-09-28",
                                                "amount": 6, "unit": "Köpfe", "yield_per_plant": 1, "seasonal": False})
    assert r.status_code == 200, r.text
    out = r.json()
    s = out["successions"]
    assert len(s) == 11 and out["interval_days"] == 14 and out["basis"] == "fest" and out["plants"] == 132
    assert all((x["count"], x["rows"], x["len"], x["span"]) == (12, 3, 1.2, 0.9) for x in s)
    assert (s[0]["sow_date"], s[0]["plant_date"], s[0]["harvest_start"], s[0]["harvest_end"]) == \
        ("2031-02-24", "2031-03-24", "2031-05-05", "2031-05-18")
    assert s[1]["harvest_start"] == "2031-05-19" and s[-1]["harvest_start"] == "2031-09-22"


def test_season_makes_spring_and_autumn_longer(client):
    salat = _crop(client, "Kopfsalat")
    body = {"crop_id": salat["id"], "start_date": "2031-05-19", "end_date": "2031-10-26", "amount": 6, "unit": "Köpfe",
            "yield_per_plant": 1}
    out = client.post("/api/goals/preview", json=body).json()
    s = out["successions"]
    assert out["basis"] == "typisch"
    first = s[0]
    assert first["field_days"] > 55 and first["plant_date"] < "2031-03-20"  # Mitte März gepflanzt, Mitte Mai geerntet
    summer = next(x for x in s if x["harvest_start"] == "2031-07-28")
    assert summer["field_days"] == 42
    autumn = s[-1]
    assert autumn["harvest_start"] == "2031-10-20" and autumn["field_days"] > 42
    # Anfang Mai schafft Kopfsalat im Freiland nicht: dieser Satz entfällt
    may = client.post("/api/goals/preview", json={**body, "start_date": "2031-05-05", "end_date": "2031-05-18"}).json()
    assert may["successions"][0]["too_cold"] and may["plants"] == 0
    # Ernte im März ginge nur mit Pflanzung mitten im Winter: dieser Satz entfällt
    early = client.post("/api/goals/preview", json={**body, "start_date": "2031-03-10", "end_date": "2031-04-06"}).json()
    assert early["successions"][0]["too_cold"] and early["successions"][0]["plant_date"] is None
    assert early["plants"] == sum(x["count"] for x in early["successions"] if not x["too_cold"])


def test_overlapping_harvest_and_small_counts(client):
    pf = _crop(client, "Pflücksalat")
    assert goals.suggest("Pflücksalat") == {"unit": "Portionen", "yield_per_plant": 4}
    r = client.get(f"/api/goals/suggest?crop_id={pf['id']}").json()
    assert r["unit"] == "Portionen" and r["window_days"] == pf["harvest_days"]
    out = client.post("/api/goals/preview", json={"crop_id": pf["id"], "start_date": "2031-06-02", "end_date": "2031-08-31",
                                                  "amount": 3, "unit": "Portionen", "yield_per_plant": 4,
                                                  "window_days": 50, "interval_days": 21, "seasonal": False}).json()
    s = out["successions"]
    # alle 3 Wochen ein Satz, der 50 Tage liefert: 9 Portionen je Abstand / 4 je Pflanze = 3 Pflanzen in einer Reihe
    assert len(s) == 5 and s[0]["harvest_end"] == "2031-07-21" and (s[0]["count"], s[0]["rows"], s[0]["len"]) == (3, 1, 0.75)
    bad = client.post("/api/goals/preview", json={"crop_id": pf["id"], "start_date": "2031-06-02", "end_date": "2031-08-31",
                                                  "window_days": 14, "interval_days": 21})
    assert bad.status_code == 422 and "Lücken" in bad.json()["detail"]
    assert client.post("/api/goals/preview", json={"crop_id": pf["id"], "start_date": "2031-06-02",
                                                   "end_date": "2031-05-01"}).status_code == 422


def test_goal_creates_and_updates_plantings(client):
    salat = _crop(client, "Kopfsalat")
    body = {"crop_id": salat["id"], "variety": "Maikönig", "start_date": "2031-05-05", "end_date": "2031-07-13",
            "amount": 6, "unit": "Köpfe", "yield_per_plant": 1, "seasonal": False}
    r = client.post("/api/goals", json=body)
    assert r.status_code == 201, r.text
    goal = r.json()["goal"]
    assert len(r.json()["created"]) == 5
    ps = _goal_plantings(client, goal["id"])
    assert [p["harvest_start"] for p in ps] == ["2031-05-05", "2031-05-19", "2031-06-02", "2031-06-16", "2031-06-30"]
    assert all(p["bed_id"] is None and p["variety"] == "Maikönig" and p["method"] == "transplant" for p in ps)
    ids = [p["id"] for p in ps]

    # In der Anzucht: Sätze ohne Beet
    plan = client.get("/api/nursery?year=2031").json()
    mine = [b for b in plan["batches"] if b["crop_id"] == salat["id"] and b["variety"] == "Maikönig"]
    assert len(mine) == 5 and mine[0]["own"][0]["bed"] is None and mine[0]["need"] == 12

    # Einen Satz aufs Beet legen, einen säen
    bed = client.get("/api/data").json()["beds"][0]
    client.patch(f"/api/plantings/{ids[1]}", json={"bed_id": bed["id"], "start": 2.0})
    client.patch(f"/api/plantings/{ids[0]}", json={"sown_done": True})
    # Mehr Salat und früher Schluss
    r = client.patch(f"/api/goals/{goal['id']}", json={"amount": 9, "end_date": "2031-06-08"}).json()
    assert r["kept"] == [ids[0]] and sorted(r["updated"]) == sorted(ids[1:3]) and sorted(r["removed"]) == sorted(ids[3:])
    ps = {p["id"]: p for p in _goal_plantings(client, goal["id"])}
    assert set(ps) == set(ids[:3])
    assert ps[ids[0]]["len"] == 1.2  # gesät: bleibt, wie er war
    assert ps[ids[1]]["len"] == 1.8 and ps[ids[1]]["bed_id"] == bed["id"] and ps[ids[1]]["start"] == 2.0  # 18 Pflanzen, Beet bleibt

    # Kultur mit Ziel lässt sich nicht löschen
    assert client.delete(f"/api/crops/{salat['id']}").status_code == 409

    # Sicherung
    exported = client.get("/api/export").json()
    assert any(g["id"] == goal["id"] for g in exported["goals"])
    client.post("/api/import", json=exported)
    assert {p["id"] for p in _goal_plantings(client, goal["id"])} == set(ids[:3])

    # Löschen: nicht begonnene Sätze gehen mit, der gesäte bleibt als normaler Satz
    assert client.delete(f"/api/goals/{goal['id']}").status_code == 204
    left = {p["id"]: p for p in client.get("/api/data").json()["plantings"]}
    assert ids[0] in left and left[ids[0]]["goal_id"] is None and ids[1] not in left and ids[2] not in left


def test_delete_goal_keeping_plantings(client):
    salat = _crop(client, "Kopfsalat")
    r = client.post("/api/goals", json={"crop_id": salat["id"], "start_date": "2032-06-07", "end_date": "2032-06-20",
                                        "amount": 4, "seasonal": False}).json()
    ids = r["created"]
    assert client.delete(f"/api/goals/{r['goal']['id']}?keep=true").status_code == 204
    left = {p["id"]: p for p in client.get("/api/data").json()["plantings"]}
    assert all(i in left and left[i]["goal_id"] is None for i in ids)


def test_typical_temperatures_are_smooth():
    t = goals._typical()
    assert len(t) == 365 and min(t) < 0 < max(t) < 20
    assert abs(t[goals.weather._norm(date(2001, 7, 15))] - 18.6) < 0.01
    assert all(abs(a - b) < 0.5 for a, b in zip(t, t[1:]))
