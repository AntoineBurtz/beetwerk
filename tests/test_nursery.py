"""Anzucht: Bedarf aus Sätzen und Abgaben, Körner, Gefäße, Termine, Belegung."""
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import nursery  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


def _data(client):
    return client.get("/api/data").json()


def test_crops_get_nursery_defaults(client):
    data = _data(client)
    cont = {c["id"]: c["name"] for c in data["containers"]}
    crops = {c["name"]: c for c in data["crops"]}
    assert [c["name"] for c in data["containers"]][:3] == ["Saatschale", "Multitopfplatte 77", "Multitopfplatte 104"]
    t = crops["Tomate"]
    assert (cont[t["sow_container_id"]], cont[t["pot_container_id"]], t["prick_days"], t["warm"]) == ("Saatschale", "Topf 9 cm", 14, 1)
    s = crops["Kopfsalat"]
    assert cont[s["sow_container_id"]] == "Multitopfplatte 104" and s["pot_container_id"] is None and s["warm"] == 0
    assert crops["Basilikum"]["seeds_per_cell"] == 4 and crops["Knollensellerie"]["pot_container_id"]
    assert crops["Möhre"]["sow_container_id"] is None  # Direktsaat
    assert all(c["reserve"] == 20 and c["harden_days"] == 7 for c in data["crops"])


@pytest.fixture(scope="module")
def setup(client):
    data = _data(client)
    cont = {c["name"]: c["id"] for c in data["containers"]}
    beds = data["beds"]
    win = client.post("/api/places", json={"name": "Fensterbank", "warm": True, "slots": 0.1}).json()
    house = client.post("/api/places", json={"name": "Gewächshaus", "slots": 10}).json()
    crop = client.post("/api/crops", json={
        "name": "Testtomate", "method": "transplant", "nursery_days": 56, "field_days": 70, "harvest_days": 60,
        "sow_container_id": cont["Saatschale"], "pot_container_id": cont["Topf 9 cm"], "prick_days": 14,
        "germination": 80, "reserve": 25, "warm": True, "harden_days": 7,
        "place_id": win["id"], "grow_place_id": house["id"]}).json()
    assert crop["warm"] == 1 and crop["place_id"] == win["id"]

    def planting(bed, varieties):
        r = client.post("/api/plantings", json={
            "crop_id": crop["id"], "bed_id": bed["id"], "method": "transplant", "sow_date": "2031-03-01",
            "plant_date": "2031-04-26", "harvest_start": "2031-07-01", "harvest_end": "2031-09-30", "len": 2,
            "varieties": varieties})
        assert r.status_code == 201, r.text
        return r.json()

    mixed = planting(beds[0], [{"name": "Ochsenherz", "count": 8}, {"name": "Green Zebra", "count": 4}])
    single = planting(beds[1], [{"name": "ochsenherz ", "count": 6}])  # gleiche Sorte, andere Schreibweise
    ho = {}
    for name, variety, count, pickup, status in [
        ("Anna", "Ochsenherz", 4, "2031-05-02", "promised"),
        ("Ben", "", 3, "2031-04-20", "wish"),            # Sorte offen: zur größten passenden Anzucht
        ("Cara", "Ochsenherz", 2, "2031-07-15", "wish"),  # viel später: eigene Anzucht
        ("Dora", "Ochsenherz", 50, "2031-05-01", "cancelled"),
    ]:
        r = client.post("/api/handovers", json={"person_name": name, "crop_id": crop["id"], "variety": variety,
                                                 "count": count, "pickup_date": pickup, "status": status})
        assert r.status_code == 201, r.text
        ho[name] = r.json()
    return {"crop": crop, "mixed": mixed, "single": single, "ho": ho, "win": win, "house": house, "cont": cont}


def _plan(client, year=2031):
    return client.get(f"/api/nursery?year={year}").json()


def test_plan_from_plantings_and_friends(client, setup):
    plan = _plan(client)
    crop = setup["crop"]
    mine = {(b["variety"].lower(), b["sow_date"]): b for b in plan["batches"] if b["crop_id"] == crop["id"]}
    assert set(mine) == {("ochsenherz", "2031-03-01"), ("green zebra", "2031-03-01"), ("ochsenherz", "2031-05-20")}

    oh = mine[("ochsenherz", "2031-03-01")]
    assert oh["own_count"] == 14 and [o["count"] for o in oh["own"]] == [8, 6]
    assert sorted((f["person"], f["count"]) for f in oh["friends"]) == [("Anna", 4), ("Ben", 3)]
    assert oh["need"] == 21 and oh["reserve"] == 25 and oh["target"] == 27  # 21 + 25 %, aufgerundet
    assert oh["seeds"] == 34  # 27 / 80 % Keimrate
    assert oh["sow"]["name"] == "Saatschale" and oh["sow"]["units"] == 0.34 and oh["sow"]["slots"] == 0.17
    assert oh["pot"]["name"] == "Topf 9 cm" and oh["pot"]["units"] == 27 and oh["pot"]["slots"] == 1.8
    assert (oh["prick_date"], oh["harden_date"], oh["ready_date"]) == ("2031-03-15", "2031-04-19", "2031-04-26")
    assert oh["place"]["name"] == "Fensterbank" and oh["grow_place"]["name"] == "Gewächshaus" and oh["warm"]

    gz = mine[("green zebra", "2031-03-01")]
    assert (gz["need"], gz["target"], gz["seeds"]) == (4, 5, 7) and gz["friends"] == []

    cara = mine[("ochsenherz", "2031-05-20")]  # 15. Juli minus 56 Tage Anzucht
    assert cara["only_friends"] and cara["need"] == 2 and cara["target"] == 3 and cara["ready_date"] == "2031-07-15"

    # Abgesagtes zählt nicht, die Wünsche wissen, wo sie mitlaufen
    hos = {h["id"]: h for h in plan["handovers"]}
    assert hos[setup["ho"]["Dora"]["id"]]["batch"] is None
    assert hos[setup["ho"]["Ben"]["id"]]["batch"] == oh["key"]

    kinds = [(t["date"], t["kind"], t.get("count")) for t in plan["tasks"] if t["key"] == oh["key"]]
    assert kinds == [("2031-03-01", "sow", 34), ("2031-03-15", "prick", 27), ("2031-04-19", "harden", 27),
                     ("2031-04-20", "handover", 3), ("2031-04-26", "plant", 8), ("2031-04-26", "plant", 6),
                     ("2031-05-02", "handover", 4)]


def test_occupancy_per_place_and_week(client, setup):
    occ = _plan(client)["occupancy"]
    rows = {r["name"]: r for r in occ["rows"]}
    weeks = [w["start"] for w in occ["weeks"]]
    win, house = rows["Fensterbank"], rows["Gewächshaus"]
    i = weeks.index("2031-02-24")  # Woche der Aussaat (Sa 1. März)
    assert win["use"][i] == pytest.approx(0.21) and win["over"][i] and win["slots"] == 0.1
    j = weeks.index("2031-03-31")
    assert house["use"][j] == pytest.approx(1.8 + 0.33) and not house["over"][j] and win["use"][j] == 0
    k = weeks.index("2031-04-21")  # nach dem Abhärten nicht mehr drinnen
    assert house["use"][k] == 0


def test_batch_state_and_sown_flags(client, setup):
    plan = _plan(client)
    oh = next(b for b in plan["batches"] if b["variety"] == "Ochsenherz" and b["sow_date"] == "2031-03-01")
    gz = next(b for b in plan["batches"] if b["variety"] == "Green Zebra")
    r = client.patch("/api/nursery", json={"key": oh["key"], "sown_done": True, "seeds_sown": 36})
    assert r.status_code == 200, r.text
    out = r.json()
    # einfacher Satz ist gesät, der Mischsatz erst, wenn auch Green Zebra gesät ist
    assert out["plantings_sown"] == {str(setup["mixed"]["id"]): False, str(setup["single"]["id"]): True}
    oh2 = next(b for b in out["batches"] if b["key"] == oh["key"])
    assert oh2["sown"] and oh2["state"]["seeds_sown"] == 36 and oh2["have"] == 28 and oh2["short"] == 0
    out = client.patch("/api/nursery", json={"key": gz["key"], "sown_done": True}).json()
    assert out["plantings_sown"] == {str(setup["mixed"]["id"]): True}
    # Weniger aufgegangen als gebraucht
    out = client.patch("/api/nursery", json={"key": oh["key"], "plants_raised": 18, "pricked_done": True,
                                             "place_id": setup["house"]["id"]}).json()
    oh3 = next(b for b in out["batches"] if b["key"] == oh["key"])
    assert oh3["have"] == 18 and oh3["short"] == 3 and oh3["pricked"] and oh3["place"]["name"] == "Gewächshaus"
    # Gesät zurücknehmen: der Mischsatz ist nicht mehr gesät, Green Zebra bleibt es
    out = client.patch("/api/nursery", json={"key": oh["key"], "sown_done": False}).json()
    assert out["plantings_sown"] == {str(setup["mixed"]["id"]): False, str(setup["single"]["id"]): False}
    st = {b["key"]: b["sown"] for b in out["batches"]}
    assert st[gz["key"]] and not st[oh["key"]]
    client.patch("/api/nursery", json={"key": oh["key"], "sown_done": True})
    # Ist der Satz im Ganzen schon gesät (z. B. auf der Karte abgehakt), gelten alle seine Sorten als gesät
    client.patch(f"/api/plantings/{setup['mixed']['id']}", json={"sown_done": False})
    client.patch(f"/api/plantings/{setup['single']['id']}", json={"sown_done": True})
    with_flag = _plan(client)
    assert {b["key"]: b["sown"] for b in with_flag["batches"]}[oh["key"]]  # Zustand der Anzucht zählt
    assert client.patch("/api/nursery", json={"key": "1|nichts|2031-01-01"}).status_code == 404
    assert client.patch("/api/nursery", json={"key": oh["key"], "place_id": 99999}).status_code == 404

    # Anzucht nur für Cara: gesät, dann sagt Cara ab -> bleibt als „nicht mehr geplant“ sichtbar
    cara = next(b for b in out["batches"] if b["only_friends"])
    client.patch("/api/nursery", json={"key": cara["key"], "sown_done": True, "seeds_sown": 4})
    client.patch(f"/api/handovers/{setup['ho']['Cara']['id']}", json={"status": "cancelled"})
    plan = _plan(client)
    assert cara["key"] not in {b["key"] for b in plan["batches"]}
    assert [o["key"] for o in plan["orphans"]] == [cara["key"]]
    client.patch(f"/api/handovers/{setup['ho']['Cara']['id']}", json={"status": "wish"})


def test_settings_validation_and_deleting(client, setup):
    crop, cont = setup["crop"], setup["cont"]
    r = client.patch(f"/api/crops/{crop['id']}", json={"pot_container_id": 0})
    assert r.status_code == 200 and r.json()["pot_container_id"] is None
    plan = _plan(client)
    oh = next(b for b in plan["batches"] if b["variety"] == "Ochsenherz" and b["sow_date"] == "2031-03-01")
    assert oh["pot"] is None and oh["prick_date"] is None  # ohne Pikieren
    client.patch(f"/api/crops/{crop['id']}", json={"pot_container_id": cont["Topf 9 cm"]})
    assert client.patch(f"/api/crops/{crop['id']}", json={"sow_container_id": 99999}).status_code == 422
    assert client.delete(f"/api/containers/{cont['Saatschale']}").status_code == 409
    extra = client.post("/api/containers", json={"name": "Topf 10 cm", "kind": "pot", "cells": 5, "per_slot": 12}).json()
    assert extra["cells"] == 1  # Topf: immer eine Pflanze
    assert client.delete(f"/api/containers/{extra['id']}").status_code == 204
    assert client.delete(f"/api/crops/{crop['id']}").status_code == 409
    # Platz löschen: Kulturen verlieren den Verweis
    tmp = client.post("/api/places", json={"name": "Keller", "slots": 2}).json()
    client.patch(f"/api/crops/{crop['id']}", json={"grow_place_id": tmp["id"]})
    assert client.delete(f"/api/places/{tmp['id']}").status_code == 204
    c = next(x for x in _data(client)["crops"] if x["id"] == crop["id"])
    assert c["grow_place_id"] is None
    client.patch(f"/api/crops/{crop['id']}", json={"grow_place_id": setup["house"]["id"]})
    # Wunsch braucht Person, Kultur und Termin
    r = client.post("/api/handovers", json={"crop_id": crop["id"], "pickup_date": "2031-05-01"})
    assert r.status_code == 422 and "Für wen" in r.json()["detail"]
    # Personen werden beim Namen wiedererkannt
    r = client.post("/api/handovers", json={"person_name": "anna", "crop_id": crop["id"], "count": 1,
                                            "pickup_date": "2031-05-02"}).json()
    assert r["person_id"] == setup["ho"]["Anna"]["person_id"]
    client.delete(f"/api/handovers/{r['id']}")


def test_backup_keeps_nursery(client, setup):
    before = _plan(client)
    exported = client.get("/api/export").json()
    assert {"containers", "places", "people", "handovers", "nursery"} <= set(exported)
    r = client.post("/api/import", json=exported)
    assert r.status_code == 200, r.text
    after = _plan(client)
    strip = lambda p: [(b["key"], b["target"], b["seeds"], b["sown"], b["state"]) for b in p["batches"]]  # noqa: E731
    assert strip(after) == strip(before) and after["orphans"] == before["orphans"]
    # Ältere Sicherung ohne Anzucht: Gefäße und Richtwerte kommen dazu
    old = {k: v for k, v in exported.items() if k not in nursery.BACKUP_TABLES}
    old["settings"] = {k: v for k, v in exported["settings"].items() if k != nursery.SEEDED_KEY}
    old["crops"] = [{k: v for k, v in c.items() if k not in dict(nursery.CROP_COLUMNS)} for c in exported["crops"]]
    client.post("/api/import", json=old)
    data = _data(client)
    tomate = next(c for c in data["crops"] if c["name"] == "Tomate")
    assert len(data["containers"]) == 6 and tomate["sow_container_id"] and tomate["prick_days"] == 14
    assert data["people"] == [] and _plan(client)["batches"]  # Sätze bleiben, Wünsche gab es dort noch nicht
