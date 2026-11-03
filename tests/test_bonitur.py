import io
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


def _setup(client):
    data = client.get("/api/data").json()
    mixed = next(p for p in data["plantings"] if p["varieties"] and p["sow_date"] == "2026-03-10")
    bon = client.get("/api/bonitur?year=2026").json()
    traits = {t["key"]: t for t in bon["traits"]}
    return data, mixed, traits


def test_catalog_and_trait_groups(client):
    data, _, traits = _setup(client)
    groups = {c["name"]: c["trait_group"] for c in data["crops"]}
    assert groups["Tomate"] == "tomato" and groups["Chili"] == "pepper" and groups["Paprika"] == "pepper"
    assert groups["Möhre"] == ""
    assert traits["bbch"]["type"] == "bbch" and traits["bbch"]["level"] == "plant"
    assert traits["tom_fruit_shape"]["grp"] == "tomato" and "rund" in traits["tom_fruit_shape"]["options"]
    assert traits["pep_heat"]["min"] == 0 and traits["pep_heat"]["max"] == 10
    assert traits["pep_species"]["level"] == "variety"
    sets = client.get("/api/bonitur").json()["sets"]
    assert [s["name"] for s in sets][:2] == ["Rundgang", "Ernte"]
    assert all(k in traits for s in sets for k in s["keys"])


def test_plants_and_observations(client):
    _, mixed, traits = _setup(client)
    pid = mixed["id"]
    spots = [{"variety": v["name"], "row": 1 + i // 6, "place": 1 + i % 6}
             for i, v in enumerate(x for x in mixed["varieties"] for _ in range(x["count"]))]
    r = client.post(f"/api/plantings/{pid}/plants", json={"plants": spots})
    assert r.status_code == 201, r.text
    plants = r.json()["plants"]
    assert len(plants) == 15 and plants[0]["num"] == 1 and plants[0]["variety"] == "Ochsenherz"
    assert client.post(f"/api/plantings/{pid}/plants", json={"plants": spots}).status_code == 409

    # Etiketten sind eindeutig, auch ohne Rücksicht auf Groß- und Kleinschreibung
    assert client.patch(f"/api/plants/{plants[0]['id']}", json={"label": " T26-001 "}).json()["label"] == "T26-001"
    clash = client.patch(f"/api/plants/{plants[1]['id']}", json={"label": "t26-001"})
    assert clash.status_code == 409 and "Pflanze 1" in clash.json()["detail"]
    r = client.put(f"/api/plantings/{pid}/labels", json={"labels": {plants[0]["id"]: "T26-002", plants[1]["id"]: "T26-001"}})
    assert r.status_code == 200, r.text
    assert {p["id"]: p["label"] for p in r.json()["plants"]}[plants[1]["id"]] == "T26-001"

    bbch, height = traits["bbch"]["id"], traits["height"]["id"]
    entries = [{"trait_id": bbch, "planting_id": pid, "plant_id": p["id"], "date": "2026-06-10", "value": 61}
               for p in plants[:4]]
    entries.append({"trait_id": height, "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-06-10",
                    "value": "85,5"})
    saved = client.post("/api/observations", json={"entries": entries}).json()["saved"]
    assert len(saved) == 5 and all(s["before"] is None for s in saved)
    assert saved[-1]["obs"]["value"] == 85.5

    # Gleicher Tag, gleiches Merkmal: ersetzt statt verdoppelt
    again = client.post("/api/observations", json={"entries": [
        {"trait_id": bbch, "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-06-10", "value": 63}]}).json()
    assert again["saved"][0]["before"]["value"] == 61
    assert again["saved"][0]["obs"]["id"] == saved[0]["obs"]["id"]
    # anderer Tag: neuer Eintrag
    later = client.post("/api/observations", json={"entries": [
        {"trait_id": bbch, "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-06-17", "value": 65}]}).json()
    assert later["saved"][0]["before"] is None

    # Einmalige Merkmale: je Pflanze oder je Sorte, bleiben änderbar
    shape = traits["tom_fruit_shape"]["id"]
    one = {"trait_id": shape, "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-08-01", "value": "herzförmig (Ochsenherz)"}
    first = client.post("/api/observations", json={"entries": [one]}).json()["saved"][0]
    second = client.post("/api/observations", json={"entries": [{**one, "date": "2026-08-20", "value": "rund"}]}).json()["saved"][0]
    assert second["obs"]["id"] == first["obs"]["id"] and second["obs"]["date"] == "2026-08-20"
    per_variety = client.post("/api/observations", json={"entries": [
        {"trait_id": shape, "planting_id": pid, "variety": "Green Zebra", "date": "2026-08-01", "value": "rund"}]})
    assert per_variety.status_code == 200, per_variety.text
    assert per_variety.json()["saved"][0]["obs"]["plant_id"] is None

    # Ebenen und Werte werden geprüft
    def bad(entry):
        r = client.post("/api/observations", json={"entries": [entry]})
        assert r.status_code == 422, r.text
        return r.json()["detail"]

    assert "je Pflanze" in bad({"trait_id": bbch, "planting_id": pid, "variety": "Sungold", "date": "2026-06-10", "value": 61})
    assert "je Sorte" in bad({"trait_id": traits["pep_species"]["id"], "planting_id": pid, "plant_id": plants[0]["id"],
                              "date": "2026-06-10", "value": "C. annuum"})
    assert "Note" in bad({"trait_id": traits["vigor"]["id"], "planting_id": pid, "plant_id": plants[0]["id"],
                          "date": "2026-06-10", "value": 12})
    assert "BBCH" in bad({"trait_id": bbch, "planting_id": pid, "plant_id": plants[0]["id"], "date": "2026-06-10", "value": "x"})

    # Befall: je Erreger ein Wert am Tag
    dis = traits["disease"]["id"]
    for opt, score in (("Krautfäule", 3), ("Grauschimmel", 2), ("Krautfäule", 5)):
        client.post("/api/observations", json={"entries": [
            {"trait_id": dis, "planting_id": pid, "plant_id": plants[2]["id"], "date": "2026-07-01",
             "value": {"opt": opt, "score": score}}]})
    bon = client.get("/api/bonitur?year=2026").json()
    rated = sorted((o["value"]["opt"], o["value"]["score"]) for o in bon["observations"] if o["trait_id"] == dis)
    assert rated == [("Grauschimmel", 2), ("Krautfäule", 5)]

    # Pflanze mit Werten lässt sich nicht löschen, Satz auch nicht
    assert client.delete(f"/api/plants/{plants[0]['id']}").status_code == 409
    r = client.delete(f"/api/plantings/{pid}")
    assert r.status_code == 409 and "Boniturwerte" in r.json()["detail"]
    assert client.patch(f"/api/plants/{plants[0]['id']}", json={"status": "gone"}).json()["status"] == "gone"

    # Sortenwechsel einer Pflanze zieht die Werte mit
    client.patch(f"/api/plants/{plants[3]['id']}", json={"variety": "Sungold"})
    bon = client.get("/api/bonitur?year=2026").json()
    assert all(o["variety"] == "Sungold" for o in bon["observations"] if o["plant_id"] == plants[3]["id"])

    # CSV mit Semikolon und Dezimalkomma
    csv = client.get("/api/bonitur.csv?year=2026")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    lines = csv.text.lstrip("﻿").splitlines()
    assert lines[0].startswith("Nr;Datum;Kultur")
    assert any(";Pflanzenhöhe;height;85,5;85,5;cm;" in line for line in lines)
    assert any("T26-002" in line for line in lines)


def test_observation_patch_delete_and_photo(client):
    _, mixed, traits = _setup(client)
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (3000, 1500), "#c0392b").save(buf, "JPEG")
    r = client.post("/api/photos", content=buf.getvalue(), headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 201, r.text
    name = r.json()["name"]
    full = client.get(f"/api/photos/{name}")
    thumb = client.get(f"/api/photos/{name}?thumb=1")
    assert full.status_code == 200 and thumb.status_code == 200
    assert Image.open(io.BytesIO(full.content)).size == (2000, 1000)
    assert max(Image.open(io.BytesIO(thumb.content)).size) == 480
    assert client.post("/api/photos", content=b"kein bild").status_code == 422
    assert client.get("/api/photos/../../etc/passwd").status_code == 404

    plants = client.get("/api/bonitur?year=2026").json()["plants"]
    plant = next(p for p in plants if p["planting_id"] == mixed["id"])
    photo = traits["photo"]["id"]
    entry = {"trait_id": photo, "planting_id": mixed["id"], "plant_id": plant["id"], "date": "2026-07-02",
             "photo": name, "note": "Frucht im Längsschnitt"}
    a = client.post("/api/observations", json={"entries": [entry]}).json()["saved"][0]["obs"]
    b = client.post("/api/observations", json={"entries": [entry]}).json()["saved"][0]["obs"]
    assert a["id"] != b["id"]  # Fotos sammeln sich
    assert client.post("/api/observations", json={"entries": [{**entry, "photo": ""}]}).status_code == 422

    r = client.patch(f"/api/observations/{a['id']}", json={"note": "anders", "date": "2026-07-03"})
    assert r.json()["note"] == "anders" and r.json()["date"] == "2026-07-03"
    assert client.delete(f"/api/observations/{b['id']}").status_code == 204

    # Mittelwert aus Einzelwerten
    w = traits["tom_fruit_weight"]["id"]
    s = client.post("/api/observations", json={"entries": [{"trait_id": w, "planting_id": mixed["id"], "plant_id": plant["id"],
                                                            "date": "2026-08-10", "value": 151.4, "parts": [140, 162.8]}]}).json()
    assert s["saved"][0]["obs"]["parts"] == [140, 162.8]


def test_custom_traits_and_sets(client):
    r = client.post("/api/traits", json={"name": "Stängeldicke", "type": "number", "unit": "mm", "freq": "repeat",
                                         "level": "plant", "section": "regular"})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["key"].startswith("custom_") and not t["builtin"] and t["active"]
    r = client.post("/api/traits", json={"name": "Farbe Kelch", "type": "choice", "options": "grün\nviolett\n\ngrün"})
    assert r.json()["options"] == ["grün", "violett"]
    assert client.post("/api/traits", json={"name": "Leer", "type": "choice"}).status_code == 422
    score = client.post("/api/traits", json={"name": "Duft", "type": "score", "min": 0, "max": 5,
                                             "options": {"0": "keiner", "5": "stark"}}).json()
    assert (score["min"], score["max"], score["options"]["5"]) == (0, 5, "stark")

    bbch = next(x for x in client.get("/api/bonitur").json()["traits"] if x["key"] == "bbch")
    assert client.patch(f"/api/traits/{bbch['id']}", json={"name": "X"}).status_code == 409
    assert client.patch(f"/api/traits/{bbch['id']}", json={"active": False}).json()["active"] is False
    client.patch(f"/api/traits/{bbch['id']}", json={"active": True})
    assert client.delete(f"/api/traits/{bbch['id']}").status_code == 409
    assert client.patch(f"/api/traits/{t['id']}", json={"name": "Stängel-Ø"}).json()["name"] == "Stängel-Ø"
    assert client.delete(f"/api/traits/{t['id']}").status_code == 204

    s = client.post("/api/trait-sets", json={"name": "Morgens", "keys": ["bbch", "vigor"]}).json()
    assert s["keys"] == ["bbch", "vigor"]
    assert client.patch(f"/api/trait-sets/{s['id']}", json={"name": "Früh"}).json()["name"] == "Früh"
    assert client.delete(f"/api/trait-sets/{s['id']}").status_code == 204


def test_backup_keeps_bonitur(client):
    before = client.get("/api/bonitur").json()
    assert before["observations"]
    exported = client.get("/api/export").json()
    assert {"traits", "trait_sets", "plants", "observations"} <= set(exported)
    client.post("/api/demo?replace=true")
    assert client.get("/api/bonitur").json()["observations"] == []
    r = client.post("/api/import", json=exported)
    assert r.status_code == 200, r.text
    after = client.get("/api/bonitur").json()
    assert after["observations"] == before["observations"]
    assert after["plants"] == before["plants"]
    assert [s["name"] for s in after["sets"]] == [s["name"] for s in before["sets"]]
    # Ältere Sicherung ohne Bonitur und ohne Zuordnung der Kulturen
    old = {k: v for k, v in exported.items() if k not in ("traits", "trait_sets", "plants", "observations")}
    old["crops"] = [{k: v for k, v in c.items() if k != "trait_group"} for c in old["crops"]]
    old["settings"] = {k: v for k, v in old["settings"].items() if k != "bonitur_seeded"}
    assert client.post("/api/import", json=old).status_code == 200
    data = client.get("/api/data").json()
    assert next(c for c in data["crops"] if c["name"] == "Tomate")["trait_group"] == "tomato"
    bon = client.get("/api/bonitur").json()
    assert bon["observations"] == [] and len(bon["sets"]) == 5 and any(t["key"] == "bbch" for t in bon["traits"])
