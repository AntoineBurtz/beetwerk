import base64
import json
import os
import tempfile
import time

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import research  # noqa: E402
from app.main import app  # noqa: E402
from tests.fakeclaude import Fake, _jpeg, serve  # noqa: E402


@pytest.fixture(scope="module")
def fake():
    srv = serve()
    old = (research.ANTHROPIC_URL, research.COMMONS_URL, research.ALLOW_PRIVATE)
    research.ANTHROPIC_URL, research.COMMONS_URL, research.ALLOW_PRIVATE = Fake.base, f"{Fake.base}/w/api.php", True
    yield Fake.base
    research.ANTHROPIC_URL, research.COMMONS_URL, research.ALLOW_PRIVATE = old
    srv.shutdown()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_config_and_research(client, fake):
    st = client.get("/api/research").json()
    assert st["configured"] is False and st["models"][0]["id"] == "claude-sonnet-5-5"
    r = client.post("/api/research/variety", json={"name": "Ochsenherz"})
    assert r.status_code == 502 and "API-Schlüssel" in r.json()["detail"]

    assert client.post("/api/research/test", json={"api_key": "falsch"}).status_code == 502
    assert client.post("/api/research/test", json={"api_key": "sk-test"}).json()["ok"] is True
    st = client.put("/api/research", json={"api_key": "sk-test", "model": "claude-haiku-5-5"}).json()
    assert st["configured"] and st["model"] == "claude-haiku-5-5"
    assert client.put("/api/research", json={"model": "gpt-4"}).status_code == 422
    # Der Schlüssel taucht nirgends auf
    assert "sk-test" not in json.dumps(client.get("/api/data").json())
    assert "sk-test" not in json.dumps(client.get("/api/export").json())

    tomate = next(c for c in client.get("/api/data").json()["crops"] if c["name"] == "Tomate")
    photo = "data:image/jpeg;base64," + base64.b64encode(_jpeg()).decode()
    Fake.calls.clear()
    r = client.post("/api/research/variety", json={"name": "", "image": photo, "hint": "Tütchen vom Markt"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["name"] == "Ochsenherz" and out["kind"] == "Fleischtomate" and out["crop_id"] == tomate["id"]
    # Merkmale: Klasse und Zahl getrennt, Spannen gemittelt, Unpassendes fällt weg
    # Kultur war vorher unbekannt: eine Nachfrage in derselben Unterhaltung füllt, was für Tomaten noch fehlt
    assert out["traits"] == {"plant_size": "groß", "height": 175, "tom_growth": "indeterminiert", "fruit_size": "sehr groß",
                             "tom_fruit_weight": 250, "tom_fruit_color": "rot", "maturity_class": "mittelspät",
                             "days_to_maturity": 80, "tom_fruit_shape": "herzförmig (Ochsenherz)",
                             "tom_locules": "5–6", "tom_brix": 5.5}
    meta = {m["key"]: m for m in out["trait_meta"]}
    assert meta["height"]["text"] == "175 cm" and meta["height"]["unit"] == "cm" and meta["plant_size"]["section"] == "plant"
    assert out["rounds"] == 2 and len(Fake.calls) == 3
    assert out["usage"]["web_search_requests"] == 3 and out["usage"]["input_tokens"] == 3000
    follow = Fake.calls[2]["body"]
    assert [m["role"] for m in follow["messages"]] == ["user", "assistant", "user"]
    assert follow["messages"][1]["content"][0]["type"] == "server_tool_use"  # Suchergebnisse der ersten Runde gehen mit
    nach = follow["messages"][2]["content"][0]["text"]
    assert "(Tomate)" in nach and "- tom_locules:" in nach and "- tom_brix:" in nach and "- pep_" not in nach
    assert "- tom_fruit_weight:" not in nach and "- height:" not in nach  # schon gefunden
    assert [x["url"].rsplit("/", 1)[-1] for x in out["sources"]] == ["ochsenherz", "datenblatt"]
    first = Fake.calls[0]["body"]
    asked = first["messages"][0]["content"][-1]["text"]
    assert "- plant_size: Pflanzengröße – genau eines von: sehr klein | klein | mittel | groß | sehr groß" in asked
    assert "- height: Pflanzenhöhe – Zahl in cm" in asked and "pep_scoville" in asked  # Kultur noch unbekannt
    assert first["model"] == "claude-haiku-5-5"
    assert first["messages"][0]["content"][0]["type"] == "image"
    assert {t["name"] for t in first["tools"]} == {"web_search", "web_fetch"}
    assert Fake.calls[0]["headers"]["anthropic-version"] == "2023-06-01"
    # zweite Runde nach pause_turn trägt die Antwort der ersten mit
    assert Fake.calls[1]["body"]["messages"][1]["role"] == "assistant"

    # Kultur bekannt und das Wichtige gefunden: keine Nachfrage. Schon Ausgefülltes wird nicht erfragt.
    Fake.calls.clear()
    out2 = client.post("/api/research/variety", json={"name": "Ochsenherz", "crop_id": tomate["id"],
                                                      "known": ["tom_fruit_weight", "description"]}).json()
    assert out2["rounds"] == 1 and len(Fake.calls) == 2
    asked2 = Fake.calls[0]["body"]["messages"][0]["content"][-1]["text"]
    assert "pep_scoville" not in asked2 and "- tom_fruit_weight:" not in asked2 and "- tom_brix:" in asked2
    assert "tom_fruit_weight" not in out2["traits"] and out2["traits"]["height"] == 175
    credits = {i["credit"] for i in out["images"]}
    assert any("Wikimedia Commons" in c and "CC BY-SA" in c for c in credits)
    shop = next(i for i in out["images"] if i["url"].endswith("/img/shop.jpg"))
    assert shop["free"] is False and shop["page"].endswith("/shop/ochsenherz")

    # Bild übernehmen und Sorte speichern
    r = client.post("/api/photos/from-url", json={"url": shop["url"]})
    assert r.status_code == 201, r.text
    name = r.json()["name"]
    assert client.get(f"/api/photos/{name}?thumb=1").status_code == 200
    v = client.post("/api/varieties", json={"crop_id": out["crop_id"], "name": out["name"] + " vom Markt", "kind": out["kind"],
                                            "photo": name, "photo_credit": shop["credit"],
                                            "links": out["sources"]}).json()
    assert v["links"][0]["url"].endswith("/shop/ochsenherz")
    assert client.post("/api/photos/from-url", json={"url": f"{fake}/shop/ochsenherz"}).status_code == 502


def test_private_addresses_are_refused(fake):
    research.ALLOW_PRIVATE = False
    try:
        with pytest.raises(research.ResearchError, match="eigenen Netz"):
            research.fetch(f"{fake}/img/x.jpg", 1000)
        with pytest.raises(research.ResearchError):
            research.fetch("file:///etc/passwd", 1000)
    finally:
        research.ALLOW_PRIVATE = True


def test_batch_fills_only_empty_fields(client, fake):
    from app import varieties
    tomate = next(c for c in client.get("/api/data").json()["crops"] if c["name"] == "Tomate")
    a = client.post("/api/varieties", json={"crop_id": tomate["id"], "name": "Ochsenherz Stapel", "kind": "Eigene Angabe",
                                            "profile": {"plant_size": {"value": "mittel", "source": "manual"}}}).json()
    b = client.post("/api/varieties", json={"crop_id": tomate["id"], "name": "Völlig unbekannt"}).json()
    Fake.calls.clear()
    r = client.post("/api/research/batch", json={"ids": [a["id"], b["id"], 999999]})
    assert r.status_code == 202, r.text
    for _ in range(100):
        st = client.get("/api/research/batch").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["done"] == 3 and st["total"] == 3 and st["skipped"] == ["Völlig unbekannt"] and st["failed"] == []
    assert st["usage"]["web_search_requests"] == 4  # Kultur bekannt, Wichtiges gefunden: keine Nachfrage
    # ohne Bildersuche
    assert not any("/w/api.php" in str(c) for c in Fake.calls)
    got = {v["id"]: v for v in client.get("/api/varieties").json()}
    va, vb = got[a["id"]], got[b["id"]]
    assert va["kind"] == "Eigene Angabe" and va["species"] == "Solanum lycopersicum" and va["description"]
    assert va["profile"]["plant_size"] == {"value": "mittel", "source": "manual"}
    assert va["profile"]["height"] == {"value": 175, "source": "internet"}
    assert va["links"] and va["links"][0]["url"].endswith("/shop/ochsenherz")
    assert st["filled"] == 3 + 8  # Art, Saatgut, Beschreibung und acht Merkmale
    assert vb["profile"] == {} and vb["species"] == ""

    # Ohne Schlüssel bricht der Lauf gleich ab
    old = research.settings()["api_key"]
    client.put("/api/research", json={"api_key": "falsch"})
    client.post("/api/research/batch", json={"ids": [a["id"], b["id"]]})
    for _ in range(100):
        st = client.get("/api/research/batch").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert len(st["failed"]) == 1 and "nicht angenommen" in st["stopped"] and st["done"] == 0
    client.put("/api/research", json={"api_key": old})
    assert varieties.BATCH_MAX == 100
    assert client.post("/api/research/batch", json={"ids": []}).status_code == 422


def test_one_step_fills_what_the_first_answer_missed(client, fake):
    """Neue Chili ohne gewählte Kultur: Scoville fehlt in der ersten Antwort und kommt mit der Nachfrage."""
    chili = next(c for c in client.get("/api/data").json()["crops"] if c["name"] == "Chili")
    Fake.calls.clear()
    out = client.post("/api/research/variety", json={"name": "Habanero Orange"}).json()
    assert out["crop_id"] == chili["id"] and out["rounds"] == 2 and len(Fake.calls) == 3
    assert out["traits"]["pep_scoville"] == 225000 and out["traits"]["pep_fruit_weight"] == 8
    assert out["traits"]["pep_species"] == "C. chinense" and out["traits"]["height"] == 70
    assert out["description"].startswith("Orange Habanero")  # leer in der ersten Antwort
    nach = Fake.calls[2]["body"]["messages"][2]["content"][0]["text"]
    assert "(Chili)" in nach and "- pep_scoville:" in nach and "- description:" in nach and "- tom_" not in nach
    assert "- species:" not in nach and "- pep_fruit_color:" not in nach
    assert {t["name"]: t["max_uses"] for t in Fake.calls[2]["body"]["tools"]} == {"web_search": 3, "web_fetch": 2}
    scov = next(m for m in out["trait_meta"] if m["key"] == "pep_scoville")
    assert scov["text"] == "225.000 SHU"

    # Scheitert die Nachfrage, bleibt die erste Antwort
    Fake.calls.clear()
    orig = research._turn
    n = {"calls": 0}

    def flaky(body, key, usage):
        n["calls"] += 1
        if n["calls"] == 2:
            raise research.BusyError("überlastet")
        return orig(body, key, usage)
    research._turn = flaky
    try:
        out = client.post("/api/research/variety", json={"name": "Habanero Orange"}).json()
    finally:
        research._turn = orig
    assert out["rounds"] == 1 and out["follow_up_error"] == "überlastet" and "pep_scoville" not in out["traits"]
    assert out["traits"]["height"] == 70
