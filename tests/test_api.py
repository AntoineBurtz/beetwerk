import os
import tempfile

import pytest

os.environ["BEETWERK_DATA"] = tempfile.mkdtemp(prefix="beetwerk-test-")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_seed_and_demo(client):
    data = client.get("/api/data").json()
    assert len(data["crops"]) > 30
    assert data["beds"] == []
    r = client.post("/api/demo")
    assert r.status_code == 200
    assert len(r.json()["beds"]) == 10
    assert client.post("/api/demo").status_code == 409


def test_planting_rules(client):
    data = client.get("/api/data").json()
    tomate = next(c for c in data["crops"] if c["name"] == "Tomate")
    bed = data["beds"][0]
    base = dict(crop_id=tomate["id"], bed_id=bed["id"], method="transplant",
                sow_date="2026-03-01", plant_date="2026-05-01",
                harvest_start="2026-07-01", harvest_end="2026-09-01", len=2)
    r = client.post("/api/plantings", json=base)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    bad = client.patch(f"/api/plantings/{pid}", json={"harvest_end": "2026-06-01"})
    assert bad.status_code == 422
    assert "Reihenfolge" in bad.json()["detail"]

    # Direktsaat entfernt das Pflanzdatum
    r = client.patch(f"/api/plantings/{pid}", json={"method": "direct"})
    assert r.json()["plant_date"] is None

    # Beet entfernen per null
    r = client.patch(f"/api/plantings/{pid}", json={"bed_id": None, "harvest_done": True})
    assert r.json()["bed_id"] is None and r.json()["harvest_done"] == 1

    assert client.delete(f"/api/plantings/{pid}").status_code == 204


def test_crop_in_use_cannot_be_deleted(client):
    data = client.get("/api/data").json()
    used = data["plantings"][0]["crop_id"]
    r = client.delete(f"/api/crops/{used}")
    assert r.status_code == 409


def test_delete_bed_keeps_plantings(client):
    data = client.get("/api/data").json()
    bed = data["beds"][0]
    count = sum(1 for p in data["plantings"] if p["bed_id"] == bed["id"])
    assert client.delete(f"/api/beds/{bed['id']}").status_code == 204
    after = client.get("/api/data").json()
    assert sum(1 for p in after["plantings"] if p["bed_id"] is None) >= count


def test_export_import_roundtrip(client):
    exported = client.get("/api/export").json()
    client.post("/api/demo?replace=true")
    r = client.post("/api/import", json=exported)
    assert r.status_code == 200
    again = client.get("/api/data").json()
    assert len(again["plantings"]) == len(exported["plantings"])
    assert client.post("/api/import", json={"foo": 1}).status_code == 400


def test_static_index(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Beetwerk" in r.text


def test_ui_is_revalidated(client):
    for path in ("/", "/js/main.js", "/css/app.css"):
        r = client.get(path)
        assert r.headers["cache-control"] == "no-cache"
        assert "etag" in r.headers
        again = client.get(path, headers={"If-None-Match": r.headers["etag"]})
        assert again.status_code == 304
