"""Düngung: Stufen und Quellen je Kultur, Düngerliste, erledigte Gaben – und die Rechnung der Oberfläche (feed.js)."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import feeding  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        c.post("/api/demo?replace=true")
        yield c


def _crop(client, name):
    return next(c for c in client.get("/api/data").json()["crops"] if c["name"] == name)


def test_reference_matches_the_more_specific_name_first():
    ref = feeding.reference_for
    assert ref("Bohnenkraut")["feed"] == "none" and ref("Buschbohne")["feed"] == "low"
    assert ref("Knoblauch")["feed"] == "low" and ref("Schnittlauch")["feed_cut"] == 1 and ref("Lauch")["feed"] == "medium"
    assert ref("Feldsalat")["feed_late"] == 1 and ref("Kopfsalat")["feed_late"] == 0
    assert ref("Kohlrabi")["row_spacing"] == 25 and ref("Weißkohl")["row_spacing"] == 50
    assert ref("Chili Lemon Drop")["feed_src"] == "Analogie"
    assert ref("Physalis") is None


def test_crops_get_level_source_and_herbs(client):
    crops = {c["name"]: c for c in client.get("/api/data").json()["crops"]}
    assert (crops["Tomate"]["feed"], crops["Tomate"]["feed_src"]) == ("medium", "LWG 2202")
    assert (crops["Kopfsalat"]["feed"], crops["Radieschen"]["feed_late"]) == ("low", 1)
    assert (crops["Möhre"]["feed"], crops["Möhre"]["feed_start"]) == ("low", 28)
    # Abstände neuer Gärten aus den Quellen
    assert (crops["Kohlrabi"]["row_spacing"], crops["Kohlrabi"]["plant_spacing"]) == (25, 20)
    assert (crops["Tomate"]["row_spacing"], crops["Tomate"]["plant_spacing"]) == (80, 50)
    for herb in ("Dill", "Koriander", "Estragon", "Basilikum", "Petersilie", "Schnittlauch"):
        assert herb in crops, herb
    assert crops["Dill"]["feed"] == "none" and crops["Basilikum"]["feed_cut"] == 1 and crops["Koriander"]["feed"] == "low"


def test_herbs_are_added_once_to_an_existing_garden(client):
    from app import db
    with db.session() as conn:
        conn.execute("DELETE FROM crops WHERE name IN ('Dill', 'Estragon')")
        assert feeding.add_herbs(conn) == ["Dill", "Estragon"]
        assert feeding.add_herbs(conn) == []
        feeding.seed(conn, force=True)
    assert _crop(client, "Estragon")["feed"] == "none"


def test_crop_feeding_can_be_changed(client):
    c = _crop(client, "Zucchini")
    r = client.patch(f"/api/crops/{c['id']}", json={"feed": "high", "feed_n": 16, "feed_cut": True, "feed_late": False, "feed_start": 10})
    assert r.status_code == 200
    assert (r.json()["feed"], r.json()["feed_n"], r.json()["feed_cut"], r.json()["feed_start"]) == ("high", 16, 1, 10)
    assert client.patch(f"/api/crops/{c['id']}", json={"feed": "viel"}).status_code == 422
    client.patch(f"/api/crops/{c['id']}", json={"feed": "medium", "feed_n": 0, "feed_cut": False, "feed_start": 0})


def test_fertilizer_list(client):
    data = client.get("/api/data").json()
    names = [f["name"] for f in data["fertilizers"]]
    assert names[0] == "Hornmehl" and "Ammonsulfatsalpeter" in names
    assert data["settings"]["fert_id"] == str(data["fertilizers"][0]["id"]) and data["settings"]["feed_factor"] == "100"
    new = client.post("/api/fertilizers", json={"name": "Schafwollpellets", "n_pct": 10, "speed": "slow"}).json()
    assert new["id"] and new["n_pct"] == 10
    assert client.post("/api/fertilizers", json={"name": "Ohne Gehalt"}).status_code == 422
    assert client.patch(f"/api/fertilizers/{new['id']}", json={"n_pct": 11.5}).json()["n_pct"] == 11.5
    assert client.patch("/api/settings", json={"fert_id": new["id"], "feed_factor": "50"}).json()["fert_id"] == str(new["id"])
    # der gewählte Dünger wird gelöscht: die Wahl fällt auf den ersten der Liste zurück
    assert client.delete(f"/api/fertilizers/{new['id']}").status_code == 204
    s = client.get("/api/data").json()["settings"]
    assert s["fert_id"] == str(data["fertilizers"][0]["id"])
    client.patch("/api/settings", json={"feed_factor": "100"})


def test_done_feedings_and_no_feed_survive_backup(client):
    p = client.get("/api/data").json()["plantings"][0]
    r = client.patch(f"/api/plantings/{p['id']}", json={"fed": {"0": "2026-05-01"}, "no_feed": True}).json()
    assert r["fed"] == {"0": "2026-05-01"} and r["no_feed"] == 1
    backup = client.get("/api/export").json()
    assert backup["fertilizers"] and next(x for x in backup["plantings"] if x["id"] == p["id"])["fed"] == {"0": "2026-05-01"}
    assert client.post("/api/import", json=backup).status_code == 200
    again = next(x for x in client.get("/api/data").json()["plantings"] if x["id"] == p["id"])
    assert again["fed"] == {"0": "2026-05-01"} and again["no_feed"] == 1
    assert client.patch(f"/api/plantings/{p['id']}", json={"fed": {}, "no_feed": False}).json()["fed"] == {}


def test_old_backup_without_feeding_gets_levels(client):
    backup = client.get("/api/export").json()
    backup.pop("fertilizers")
    for c in backup["crops"]:
        for k in ("feed", "feed_n", "feed_cut", "feed_start", "feed_late", "feed_src"):
            c.pop(k, None)
    backup["crops"] = [c for c in backup["crops"] if c["name"] != "Koriander"]
    assert client.post("/api/import", json=backup).status_code == 200
    data = client.get("/api/data").json()
    crops = {c["name"]: c for c in data["crops"]}
    assert crops["Tomate"]["feed"] == "medium" and data["fertilizers"]
    assert "Koriander" not in crops  # eine Sicherung bekommt keine Kulturen dazu
    assert client.post("/api/crops/herbs").json()["added"] == ["Koriander"]


def test_reference_endpoint(client):
    c = _crop(client, "Kohlrabi")
    client.patch(f"/api/crops/{c['id']}", json={"row_spacing": 30, "plant_spacing": 30})
    out = client.get("/api/crops/reference").json()
    assert out["levels"] == {"none": 0.0, "low": 6.5, "medium": 13.0, "high": 19.5}
    row = next(x for x in out["crops"] if x["id"] == c["id"])
    assert (row["ref"]["row_spacing"], row["ref"]["plant_spacing"]) == (25, 20) and "LWG" in row["ref"]["spacing_src"]
    client.patch(f"/api/crops/{c['id']}", json={"row_spacing": 25, "plant_spacing": 20})


# ---------------------------------------------------------------- Rechnung der Oberfläche

NODE = shutil.which("node")

SCRIPT = """
import { feedPlan, feedNeed, feedWhen, gramsText } from './app/static/js/feed.js';
import { dayNum, isoOf } from './app/static/js/util.js';
const horn = { id: 1, name: 'Hornmehl', n_pct: 13, speed: 'slow' };
const ass = { id: 2, name: 'ASS', n_pct: 26, speed: 'fast' };
const bed = { id: 1, kind: 'bed', length: 6, width: 0.8 };
const satz = (o = {}) => ({ id: 1, bed_id: 1, method: 'transplant', sow_date: '2027-04-01', plant_date: '2027-05-01',
  harvest_start: '2027-07-01', harvest_end: '2027-09-30', start: 0, len: 2.5, offset: 0, span: null, fed: {}, ...o });
const crop = (o = {}) => ({ id: 1, name: 'X', feed: 'medium', feed_n: 0, feed_cut: 0, feed_start: 0, feed_late: 0, ...o });
const show = (pl) => ({ need: pl.need, area: +pl.area.toFixed(2), total: +pl.total.toFixed(2), reason: pl.reason,
  items: pl.items.map((x) => [isoOf(x.day), +x.n.toFixed(2), x.grams == null ? null : Math.round(x.grams), x.cut, x.done]) });
const out = {
  mediumHorn: show(feedPlan(satz(), crop(), bed, { fert_id: 1 }, [horn, ass])),
  highHorn: show(feedPlan(satz(), crop({ feed: 'high' }), bed, { fert_id: 1 }, [horn, ass])),
  mediumAss: show(feedPlan(satz(), crop(), bed, { fert_id: 2 }, [horn, ass])),
  highAss: show(feedPlan(satz(), crop({ feed: 'high' }), bed, { fert_id: 2 }, [horn, ass])),
  lowAssPlanted: show(feedPlan(satz(), crop({ feed: 'low' }), bed, { fert_id: 2 }, [horn, ass])),
  lowAssSown: show(feedPlan(satz({ method: 'direct', plant_date: null }), crop({ feed: 'low' }), bed, { fert_id: 2 }, [horn, ass])),
  lowAssCarrot: show(feedPlan(satz({ method: 'direct', plant_date: null }), crop({ feed: 'low', feed_start: 28 }), bed, { fert_id: 2 }, [horn, ass])),
  half: show(feedPlan(satz(), crop(), bed, { fert_id: 1, feed_factor: '50' }, [horn, ass])),
  own: show(feedPlan(satz(), crop({ feed_n: 18 }), bed, { fert_id: 1 }, [horn, ass])),
  cut: show(feedPlan(satz(), crop({ feed_cut: 1 }), bed, { fert_id: 1 }, [horn, ass])),
  cutShort: show(feedPlan(satz({ harvest_end: '2027-07-20' }), crop({ feed_cut: 1 }), bed, { fert_id: 1 }, [horn, ass])),
  late: show(feedPlan(satz({ method: 'direct', plant_date: null, sow_date: '2027-08-10', harvest_start: '2027-10-01', harvest_end: '2027-11-30' }),
    crop({ feed: 'low', feed_late: 1 }), bed, { fert_id: 1 }, [horn, ass])),
  spring: show(feedPlan(satz({ method: 'direct', plant_date: null }), crop({ feed: 'low', feed_late: 1 }), bed, { fert_id: 1 }, [horn, ass])),
  off: show(feedPlan(satz({ no_feed: 1 }), crop(), bed, { fert_id: 1 }, [horn, ass])),
  none: show(feedPlan(satz(), crop({ feed: 'none' }), bed, { fert_id: 1 }, [horn, ass])),
  unset: show(feedPlan(satz(), crop({ feed: '' }), bed, { fert_id: 1 }, [horn, ass])),
  done: show(feedPlan(satz({ fed: { 1: '2027-05-26' } }), crop({ feed: 'high' }), bed, { fert_id: 1 }, [horn, ass])),
  noFert: show(feedPlan(satz(), crop(), bed, {}, [])),
  when: [feedWhen({ after: 0 }, satz()), feedWhen({ after: 21 }, satz()), feedWhen({ after: 7 }, satz({ method: 'direct' })),
    feedWhen({ after: 24 }, satz()), feedWhen({ cut: true, after: 70 }, satz())],
  grams: [gramsText(203.4), gramsText(12.4), gramsText(1250), gramsText(0.3)],
  need: [feedNeed(crop()), feedNeed(crop({ feed: 'none', feed_n: 5 })), feedNeed(crop({ feed_n: 9 })), feedNeed(null)],
};
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def js():
    if not NODE:
        pytest.skip("node ist nicht installiert")
    r = subprocess.run([NODE, "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_amounts_follow_the_lwg_levels(js):
    # 2,5 m x 0,8 m = 2 m²; mittel = 13 g N/m² = 26 g N = 200 g Hornmehl (13 % N), also 100 g/m² wie im Merkblatt
    assert js["mediumHorn"] == {"need": 13, "area": 2.0, "total": 26.0, "reason": None,
                                "items": [["2027-05-01", 26.0, 200, False, None]]}
    # hoch mit Horn: die Hälfte zur Pflanzung, die Hälfte 3 bis 4 Wochen später
    assert js["highHorn"]["items"] == [["2027-05-01", 19.5, 150, False, None], ["2027-05-25", 19.5, 150, False, None]]
    # Ammonsulfatsalpeter (26 % N): mittel in zwei Gaben mit 3 Wochen Abstand, je 25 g/m²
    assert js["mediumAss"]["items"] == [["2027-05-01", 13.0, 50, False, None], ["2027-05-22", 13.0, 50, False, None]]
    assert [x[0] for x in js["highAss"]["items"]] == ["2027-05-01", "2027-05-22", "2027-06-05"]
    assert round(sum(x[1] for x in js["highAss"]["items"]), 2) == 39.0


def test_fast_fertilizer_waits_after_sowing_or_planting(js):
    assert js["lowAssPlanted"]["items"] == [["2027-05-08", 13.0, 50, False, None]]   # 1 Woche nach der Pflanzung
    assert js["lowAssSown"]["items"][0][0] == "2027-04-15"                           # 2 Wochen nach der Saat
    assert js["lowAssCarrot"]["items"][0][0] == "2027-04-29"                         # langsam auflaufend: 4. Woche


def test_adjustments(js):
    assert js["half"]["need"] == 6.5 and js["half"]["items"][0][2] == 100
    # eigene Menge 18 g N/m² zählt zur Stufe hoch: zwei Gaben
    assert js["own"]["need"] == 18 and len(js["own"]["items"]) == 2
    assert js["late"]["reason"] == "late" and js["late"]["items"] == [] and js["spring"]["reason"] is None
    assert js["off"]["reason"] == "off" and js["none"]["reason"] == "none" and js["unset"]["reason"] == "unset"
    assert js["done"]["items"][1][4] == "2027-05-26" and js["done"]["items"][0][4] is None
    assert js["noFert"]["items"] == [["2027-05-01", 26.0, None, False, None]]


def test_cut_crops_get_top_dressings_while_harvested(js):
    # die Hälfte zur Pflanzung, die andere Hälfte auf drei Gaben nach den Schnitten (alle 5 Wochen ab Erntebeginn)
    items = js["cut"]["items"]
    assert [x[0] for x in items] == ["2027-05-01", "2027-07-08", "2027-08-12", "2027-09-16"][: len(items)]
    assert items[0][1] == 13.0 and [x[3] for x in items] == [False] + [True] * (len(items) - 1)
    assert round(sum(x[1] for x in items), 2) == 26.0
    # kurze Ernte: keine Nachdüngung, alles zur Pflanzung
    assert js["cutShort"]["items"] == [["2027-05-01", 26.0, 200, False, None]]


def test_texts(js):
    assert js["when"] == ["zur Pflanzung", "3 Wochen nach der Pflanzung", "1 Woche nach der Saat", "24 Tage nach der Pflanzung", "nach dem Schnitt"]
    assert js["grams"] == ["205 g", "12 g", "1,25 kg", "1 g"]
    assert js["need"] == [13, 0, 9, 0]
