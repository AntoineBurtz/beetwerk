import math
import os
import tempfile

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import geo  # noqa: E402
from app.main import app, IMAGE_PATH  # noqa: E402
from tests import fakemap  # noqa: E402


# ---------------------------------------------------------------- Rechnen

def test_frame_roundtrip_and_orientation():
    f = geo.Frame(48.0, 11.0, 90, 5, 7)
    for x, y in [(0, 0), (12.5, 3.2), (-4, 30)]:
        lat, lon = f.to_latlon(x, y)
        bx, by = f.to_local(lat, lon)
        assert abs(bx - x) < 1e-6 and abs(by - y) < 1e-6
    # Norden oben: ein Punkt nördlich hat ein kleineres y
    _, y_south = f.to_local(48.0, 11.0)
    _, y_north = f.to_local(48.0001, 11.0)
    assert y_north < y_south
    assert abs((y_south - y_north) - 0.0001 * f.m_lat) < 1e-6


def test_build_geo_aligned_to_edge():
    # Kante 0→1 ist die lange Seite (20 m), Kurs = 90° - 25° = 65°
    g = geo.build_geo(fakemap.PLOT, 65)
    assert abs(g["width"] - 20) < 0.05
    assert abs(g["height"] - 12) < 0.05
    assert abs(g["area"] - 240) < 0.5
    xs = [p[0] for p in g["polygon"]]
    ys = [p[1] for p in g["polygon"]]
    assert min(xs) == pytest.approx(0, abs=1e-6) and min(ys) == pytest.approx(0, abs=1e-6)


def test_build_geo_rejects_bad_input():
    with pytest.raises(geo.GeoError):
        geo.build_geo([(48, 11), (48.0001, 11)], 90)
    with pytest.raises(geo.GeoError):
        geo.build_geo([(48, 11), (48.0001, 11), (48.0002, 11)], 90)


def test_reanchor_keeps_bed_in_place():
    old = geo.frame_for(fakemap.PLOT, 90)
    new = geo.frame_for(fakemap.PLOT, 65)
    bed = {"x": 3.0, "y": 4.0, "length": 4.0, "width": 1.2, "rotation": 0.0}
    moved = geo.reanchor_bed(bed, old, new)
    c_old = old.to_latlon(bed["x"] + 2, bed["y"] + 0.6)
    c_new = new.to_latlon(moved["x"] + 2, moved["y"] + 0.6)
    assert abs(c_old[0] - c_new[0]) * old.m_lat < 0.001
    assert abs(c_old[1] - c_new[1]) * old.m_lon < 0.001
    assert moved["rotation"] == pytest.approx(25)


# ---------------------------------------------------------------- Schnittstelle

@pytest.fixture(scope="module")
def mapserver():
    srv = fakemap.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_geo_with_wms(client, mapserver):
    client.post("/api/demo?replace=true")
    body = {"boundary": fakemap.PLOT, "bearing": 65, "source": "custom",
            "custom": {"type": "wms", "url": f"{mapserver}/wms", "layers": "test", "attribution": "Test"}}
    r = client.put("/api/garden/geo", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["warning"] is None
    g = d["geo"]
    assert g["image"]["url"].startswith("/api/garden/image")
    assert abs(float(d["settings"]["garden_width"]) - 20) < 0.1
    assert "geo" not in d["settings"]
    assert d["imagery"]["custom"]["url"].endswith("/wms")
    # Das Bild deckt Grenze plus Rand ab
    e0, n0, e1, n1 = g["image"]["enu"]
    assert e1 - e0 > 20 and n1 - n0 > 12
    img = client.get(g["image"]["url"])
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"


def test_redraw_moves_beds_with_ground(client, mapserver):
    before = client.get("/api/data").json()
    bed = before["beds"][0]
    f_old = geo.frame_from({"frame": before["geo"]["frame"]})
    c_before = f_old.to_latlon(bed["x"] + bed["length"] / 2, bed["y"] + bed["width"] / 2)
    r = client.put("/api/garden/geo", json={"boundary": fakemap.PLOT, "bearing": 90, "source": "custom"})
    assert r.status_code == 200, r.text
    after = r.json()
    moved = next(b for b in after["beds"] if b["id"] == bed["id"])
    f_new = geo.frame_from({"frame": after["geo"]["frame"]})
    c_after = f_new.to_latlon(moved["x"] + moved["length"] / 2, moved["y"] + moved["width"] / 2)
    assert math.dist((c_before[0] * f_old.m_lat, c_before[1] * f_old.m_lon),
                     (c_after[0] * f_old.m_lat, c_after[1] * f_old.m_lon)) < 0.01
    assert moved["rotation"] == pytest.approx((bed["rotation"] - 25) % 360)


def test_geo_with_tiles(client, mapserver):
    r = client.post("/api/garden/image", json={"source": "custom", "custom": {
        "type": "xyz", "url": f"{mapserver}/tiles/{{z}}/{{x}}/{{y}}.jpg", "max_zoom": 20}})
    assert r.status_code == 200, r.text
    g = r.json()["geo"]
    e0, n0, e1, n1 = g["image"]["enu"]
    assert e1 - e0 > 20 and n1 - n0 > 12
    assert any("/tiles/20/" in c or "/tiles/19/" in c for c in fakemap.Handler.calls)


def test_unreachable_source_keeps_boundary(client):
    body = {"boundary": fakemap.PLOT, "bearing": 65, "source": "custom",
            "custom": {"type": "wms", "url": "http://127.0.0.1:9/wms", "layers": "x"}}
    r = client.put("/api/garden/geo", json=body)
    assert r.status_code == 200
    d = r.json()
    assert "nicht" in d["warning"]
    assert d["geo"]["frame"]["bearing"] == 65
    assert d["geo"]["image"] is not None  # das vorige Bild bleibt nutzbar


def test_osm_is_not_stored(client):
    r = client.post("/api/garden/image", json={"source": "osm"})
    assert r.status_code == 502
    assert "Orientierung" in r.json()["detail"]


def test_export_keeps_geo_and_delete(client):
    exported = client.get("/api/export").json()
    assert "geo" in exported["settings"]
    r = client.delete("/api/garden/geo")
    assert r.json()["geo"] is None
    assert not IMAGE_PATH.exists()
    client.post("/api/import", json=exported)
    assert client.get("/api/data").json()["geo"]["image_missing"] is True


def test_anchor_puts_side_on_grid():
    # Kante 0 (20 m) als untere Seite: Kurs 65°, linke Ecke = Ecke 0
    g = geo.build_geo(fakemap.PLOT, 65, anchor=0)
    (x0, y0), (x1, y1) = g["polygon"][0], g["polygon"][1]
    assert abs(y0 - y1) < 1e-3                      # waagrecht
    assert y0 == pytest.approx(max(p[1] for p in g["polygon"]), abs=1e-3)  # ganz unten
    assert abs(x0 - round(x0)) < 1e-3 and abs(y0 - round(y0)) < 1e-3     # Ecke auf vollen Metern
    assert x1 > x0

    # Dieselbe Kante links: Kurs 335°, obere Ecke = Ecke 0
    g = geo.build_geo(fakemap.PLOT, 335, anchor=0)
    (x0, y0), (x1, y1) = g["polygon"][0], g["polygon"][1]
    assert abs(x0 - x1) < 1e-3                      # senkrecht
    assert x0 == pytest.approx(min(p[0] for p in g["polygon"]), abs=1e-3)  # ganz links
    assert abs(x0 - round(x0)) < 1e-3 and abs(y0 - round(y0)) < 1e-3
    assert y1 > y0


def test_put_geo_keeps_orientation_choice(client, mapserver):
    body = {"boundary": fakemap.PLOT, "bearing": 335, "source": "custom", "orient": "edge",
            "ref_edge": 0, "ref_side": "left", "anchor": 0,
            "custom": {"type": "wms", "url": f"{mapserver}/wms", "layers": "test"}}
    r = client.put("/api/garden/geo", json=body)
    assert r.status_code == 200, r.text
    g = r.json()["geo"]
    assert (g["ref_edge"], g["ref_side"], g["orient"]) == (0, "left", "edge")
    assert any(o["id"] == "bayern-label" for o in r.json()["imagery"]["overlays"])
    assert {s["kind"] for s in r.json()["imagery"]["sources"]} == {"aerial", "map"}
