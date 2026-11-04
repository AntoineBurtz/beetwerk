import io
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from tests import fakebaserow  # noqa: E402

LOGIN = {"email": fakebaserow.EMAIL, "password": fakebaserow.PASSWORD}


@pytest.fixture(scope="module")
def fake():
    server, store = fakebaserow.serve()
    yield f"http://127.0.0.1:{server.server_address[1]}", store
    server.shutdown()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.delete("/api/baserow")
        c.post("/api/demo?replace=true")
        yield c


def _table(store, name):
    return next(t for t in store.tables.values() if t["name"] == name)


def _bonitur(client):
    """Pflanzen festlegen und ein paar Werte samt Foto speichern."""
    data = client.get("/api/data").json()
    mixed = next(p for p in data["plantings"] if p["varieties"] and p["sow_date"] == "2026-03-10")
    spots = [{"variety": v["name"], "row": 1, "place": i + 1}
             for i, v in enumerate(x for x in mixed["varieties"] for _ in range(x["count"]))]
    plants = client.post(f"/api/plantings/{mixed['id']}/plants", json={"plants": spots}).json()["plants"]
    client.patch(f"/api/plants/{plants[0]['id']}", json={"label": "T26-001"})
    traits = {t["key"]: t for t in client.get("/api/bonitur?year=2026").json()["traits"]}
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "#2d6a4f").save(buf, "JPEG")
    photo = client.post("/api/photos", content=buf.getvalue(), headers={"Content-Type": "image/jpeg"}).json()["name"]
    entries = [
        {"trait_id": traits["bbch"]["id"], "planting_id": mixed["id"], "plant_id": p["id"], "date": "2026-06-10", "value": 61}
        for p in plants[:3]
    ] + [
        {"trait_id": traits["tom_fruit_weight"]["id"], "planting_id": mixed["id"], "plant_id": plants[0]["id"],
         "date": "2026-08-01", "value": 151.5, "parts": [140, 163]},
        {"trait_id": traits["photo"]["id"], "planting_id": mixed["id"], "plant_id": plants[0]["id"],
         "date": "2026-08-01", "photo": photo, "note": "Längsschnitt"},
        {"trait_id": traits["generation"]["id"], "planting_id": mixed["id"], "variety": "Green Zebra",
         "date": "2026-08-01", "value": "F2"},
    ]
    saved = client.post("/api/observations", json={"entries": entries}).json()["saved"]
    return mixed, plants, traits, [s["obs"] for s in saved]


def test_setup_and_sync(client, fake):
    url, store = fake
    bad = client.post("/api/baserow/databases", json={"url": url, "email": fakebaserow.EMAIL, "password": "falsch"})
    assert bad.status_code == 502 and "Passwort nicht" in bad.json()["detail"]
    nowhere = client.post("/api/baserow/databases", json={"url": "http://127.0.0.1:9", **LOGIN})
    assert nowhere.status_code == 502 and "nicht erreichbar" in nowhere.json()["detail"]

    dbs = client.post("/api/baserow/databases", json={"url": url + "/api/", **LOGIN}).json()["databases"]
    garten = dbs[0]
    assert garten["name"] == "Garten" and {t["name"] for t in garten["tables"]} == {"Sorten", "Etiketten", "Notizen"}
    sorten = next(t["id"] for t in garten["tables"] if t["name"] == "Sorten")
    etiketten = next(t["id"] for t in garten["tables"] if t["name"] == "Etiketten")

    r = client.post("/api/baserow/setup", json={"url": url, **LOGIN, "database_id": garten["id"],
                                                "variety_table_id": sorten, "label_table_id": etiketten})
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["connected"] and st["database"] == "Garten" and st["url"] == url
    assert "token" not in st and "baserow_token" not in client.get("/api/data").json()["settings"]
    values = _table(store, "Boniturwerte")
    names = {f["name"]: f for f in values["fields"]}
    assert names["Eintrag"]["primary"] and names["Datum"]["type"] == "date" and names["Foto"]["type"] == "file"
    assert names["Pflanze"]["link_row_table_id"] == _table(store, "Bonitur-Pflanzen")["id"]
    assert names["Sorte verknüpft"]["link_row_table_id"] == sorten
    # Vorhandene Tabellen bleiben unverändert, die eigenen bekommen Rückverweise
    assert [f["name"] for f in store.tables[sorten]["fields"]] == ["Name"]
    assert "Boniturwerte" in {f["name"] for f in _table(store, "Bonitur-Pflanzen")["fields"]}

    mixed, plants, traits, obs = _bonitur(client)
    assert client.get("/api/baserow").json()["pending"] == len(obs)
    res = client.post("/api/baserow/sync").json()
    data = client.get("/api/data").json()
    assert res["result"]["created"] == len(traits) + len(plants) + len(obs) + len(data["crops"]) + len(data["plantings"])
    assert res["result"]["photos"] == 1 and res["pending"] == 0 and res["last_error"] is None

    prows = {r["Beetwerk-ID"]: r for r in _table(store, "Bonitur-Pflanzen")["rows"].values()}
    first = prows[plants[0]["id"]]
    assert first["Pflanze"] == "T26-001" and first["Jahr"] == 2026 and first["Status"] == "aktiv"
    sorte_rows = {r["Name"]: r["id"] for r in store.tables[sorten]["rows"].values()}
    assert first["Sorte verknüpft"] == [sorte_rows["Ochsenherz"]]
    assert first["Etikett verknüpft"] == [next(iter(store.tables[etiketten]["rows"]))]
    assert prows[plants[13]["id"]]["Sorte verknüpft"] == []  # Sungold steht nicht in der Sortentabelle

    vrows = {r["Beetwerk-ID"]: r for r in _table(store, "Boniturwerte")["rows"].values()}
    weight = vrows[obs[3]["id"]]
    assert weight["Pflanze"] == [first["id"]] and weight["Zahl"] == 151.5 and weight["Einheit"] == "g"
    assert weight["Wert"] == "151,5" and weight["Einzelwerte"] == "140; 163" and weight["Datum"] == "2026-08-01"
    trait_rows = {r["Beetwerk-ID"]: r["id"] for r in _table(store, "Bonitur-Merkmale")["rows"].values()}
    assert weight["Merkmal"] == [trait_rows[traits["tom_fruit_weight"]["id"]]]
    assert vrows[obs[4]["id"]]["Foto"][0]["name"] in store.files
    gen = vrows[obs[5]["id"]]
    assert gen["Pflanze"] == [] and gen["Ebene"] == "Sorte" and gen["Sorte verknüpft"] == [sorte_rows["Green Zebra"]]
    assert _table(store, "Bonitur-Merkmale")["rows"][trait_rows[traits["tom_fruit_weight"]["id"]]]["Merkmal"] \
        == "Fruchtgewicht (Tomate)"

    # Nichts geändert: nichts zu tun
    again = client.post("/api/baserow/sync").json()["result"]
    assert again == {"created": 0, "updated": 0, "deleted": 0, "photos": 0}

    # Ändern, Löschen, in Baserow gelöschte Zeile wieder anlegen
    client.patch(f"/api/observations/{obs[0]['id']}", json={"value": 63})
    client.delete(f"/api/observations/{obs[1]['id']}")
    gone_row = vrows[obs[2]["id"]]["id"]
    del _table(store, "Boniturwerte")["rows"][gone_row]
    client.patch(f"/api/observations/{obs[2]['id']}", json={"note": "nachgetragen"})
    client.patch(f"/api/plants/{plants[1]['id']}", json={"status": "gone"})
    res = client.post("/api/baserow/sync").json()["result"]
    assert res == {"created": 1, "updated": 2, "deleted": 1, "photos": 0}
    vrows = {r["Beetwerk-ID"]: r for r in _table(store, "Boniturwerte")["rows"].values()}
    assert vrows[obs[0]["id"]]["Wert"] == "63" and obs[1]["id"] not in vrows
    assert vrows[obs[2]["id"]]["Notiz"] == "nachgetragen"
    assert prows[plants[1]["id"]]["Status"] == "ausgefallen"

    # Sicherung enthält keine Zugangsdaten, Einspielen trennt die Verbindung nicht
    exported = client.get("/api/export").json()
    assert not any(k.startswith("baserow") for k in exported["settings"])
    assert client.post("/api/import", json=exported).status_code == 200
    assert client.get("/api/baserow").json()["connected"]
    assert client.post("/api/baserow/sync").json()["result"]["created"] == 0


def test_connect_existing_tables(client, fake):
    url, store = fake
    token = next(iter(store.tokens))
    ids = {k: _table(store, n)["id"] for k, n in
           (("traits", "Bonitur-Merkmale"), ("plants", "Bonitur-Pflanzen"), ("observations", "Boniturwerte"))}
    before = {n: len(_table(store, n)["rows"]) for n in ("Bonitur-Merkmale", "Bonitur-Pflanzen", "Boniturwerte")}
    body = {"url": url, "token": token, "traits_table_id": ids["traits"], "plants_table_id": ids["plants"],
            "observations_table_id": ids["observations"]}
    client.delete("/api/baserow")  # Verbindung vergessen und dieselben Tabellen von Hand neu verbinden
    r = client.post("/api/baserow/connect", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["links"]["variety"] == _table(store, "Sorten")["id"]
    assert r.json()["missing"] == ["Kulturen", "Beetwerk-Sorten", "Sätze"]
    res = client.post("/api/baserow/sync").json()["result"]
    assert res["created"] == 0  # vorhandene Zeilen werden über die Beetwerk-ID übernommen
    assert {n: len(_table(store, n)["rows"]) for n in before} == before

    assert client.post("/api/baserow/connect", json={**body, "token": "falsch"}).status_code == 502
    values = _table(store, "Boniturwerte")
    values["fields"] = [f for f in values["fields"] if f["name"] not in ("Foto", "Zahl")]
    r = client.post("/api/baserow/connect", json=body)
    detail = r.json()["detail"]
    assert r.status_code == 502 and "Boniturwerte" in detail and "Foto" in detail and "Zahl" in detail

    assert client.delete("/api/baserow").json()["connected"] is False
    st = client.get("/api/baserow").json()
    assert st["pending"] == 0 and st["tables"] == {}
    r = client.post("/api/baserow/sync")
    assert r.status_code == 502 and "nicht mit Baserow verbunden" in r.json()["detail"]


def test_wrong_host_is_explained():
    """Django in Baserow lehnt fremde Hostnamen mit einer HTML-Seite ab; das soll verständlich gemeldet werden."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from app import baserow

    class Strict(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = b"<h1>Bad Request (400)</h1>"
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Strict)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with pytest.raises(baserow.AddressError, match="BASEROW_EXTRA_ALLOWED_HOSTS"):
            baserow.login(f"http://127.0.0.1:{srv.server_address[1]}", "a@b.c", "x")
    finally:
        srv.shutdown()



def test_varieties_crops_and_plantings(client, fake):
    url, store = fake
    tokens = len(store.tokens)
    dbs = client.post("/api/baserow/databases", json={"url": url, **LOGIN}).json()["databases"]
    sorten = next(t["id"] for t in dbs[0]["tables"] if t["name"] == "Sorten")
    r = client.post("/api/baserow/setup", json={"url": url, **LOGIN, "database_id": dbs[0]["id"], "variety_table_id": sorten})
    assert r.status_code == 200, r.text
    assert r.json()["missing"] == [] and len(store.tokens) == tokens + 1
    # erneutes Einrichten: Tabellen und Token bleiben, nichts doppelt
    again = client.post("/api/baserow/setup", json={"url": url, **LOGIN, "database_id": dbs[0]["id"], "variety_table_id": sorten})
    assert again.status_code == 200 and len(store.tokens) == tokens + 1
    assert sum(1 for t in store.tables.values() if t["name"] == "Kulturen") == 1

    data = client.get("/api/data").json()
    tomate = next(c for c in data["crops"] if c["name"] == "Tomate")
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (60, 40), "#c0392b").save(buf, "JPEG")
    photo = client.post("/api/photos", content=buf.getvalue(), headers={"Content-Type": "image/jpeg"}).json()["name"]
    v = client.post("/api/varieties", json={"crop_id": tomate["id"], "name": "Ochsenherz", "species": "Solanum lycopersicum",
                                            "kind": "Fleischtomate", "seed": "samenfest", "photo": photo,
                                            "photo_credit": "eigenes Foto",
                                            "links": [{"url": "https://example.org/ochsenherz", "title": "Shop"}]})
    assert v.status_code == 201, v.text
    dup = client.post("/api/varieties", json={"crop_id": tomate["id"], "name": "ochsenherz"})
    assert dup.status_code == 409
    collected = client.post("/api/varieties/collect").json()["created"]
    assert "Green Zebra" in {x["name"] for x in collected} and "Ochsenherz" not in {x["name"] for x in collected}
    assert client.delete(f"/api/crops/{tomate['id']}").status_code == 409

    res = client.post("/api/baserow/sync").json()
    assert res["last_error"] is None, res
    crops_t, sorts_t, sets_t = (_table(store, n) for n in ("Kulturen", "Beetwerk-Sorten", "Sätze"))
    crop_rows = {r["Beetwerk-ID"]: r for r in crops_t["rows"].values()}
    assert len(crop_rows) == len(data["crops"]) and crop_rows[tomate["id"]]["Bonitur-Merkmale"] == "Tomate"
    sort_rows = {r["Sorte"]: r for r in sorts_t["rows"].values() if r["Kultur"] == [crop_rows[tomate["id"]]["id"]]}
    oh = sort_rows["Ochsenherz"]
    assert oh["Typ"] == "Fleischtomate" and oh["Foto"][0]["name"] in store.files and "example.org" in oh["Quellen"]
    mixed = next(p for p in data["plantings"] if p["varieties"] and p["sow_date"] == "2026-03-10")
    set_row = next(r for r in sets_t["rows"].values() if r["Beetwerk-ID"] == mixed["id"])
    assert set_row["Pflanzen"] == 15 and set_row["Aussaat"] == "2026-03-10" and set_row["Kultur"] == [crop_rows[tomate["id"]]["id"]]
    assert oh["id"] in set_row["Sorten"] and len(set_row["Sorten"]) == 5
    plant_rows = [r for r in _table(store, "Bonitur-Pflanzen")["rows"].values() if r["Sorte"] == "Ochsenherz"]
    assert plant_rows and all(r["Beetwerk-Sorte"] == [oh["id"]] for r in plant_rows)

    # Löschen einer Sorte löscht die Zeile in Baserow
    gz = next(x for x in collected if x["name"] == "Green Zebra")
    assert client.delete(f"/api/varieties/{gz['id']}").status_code == 204
    res = client.post("/api/baserow/sync").json()["result"]
    assert res["deleted"] == 1 and "Green Zebra" not in {r["Sorte"] for r in sorts_t["rows"].values()}

    # Sicherung enthält die Sortenliste
    exported = client.get("/api/export").json()
    assert any(x["name"] == "Ochsenherz" for x in exported["varieties"])
    assert client.post("/api/import", json=exported).status_code == 200
    assert any(x["name"] == "Ochsenherz" for x in client.get("/api/varieties").json())
