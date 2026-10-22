"""Grundstück auf dem Luftbild: Koordinaten und Luftbild-Abruf.

Die Beete leben in einem lokalen Meter-System (x nach rechts, y nach unten).
Ein Grundstück mit Grenze legt fest, wo dieses System auf der Erde liegt:

- Ursprung: Schwerpunkt der Grenzpunkte (lat0, lon0)
- Ausrichtung: Kompasskurs der x-Achse in Grad (90 = Osten, also Norden oben)
- Versatz: ox, oy, damit die Grenze bei (0, 0) beginnt

Für Flächen in Gartengröße reicht eine lokale Tangentialebene (ENU) völlig.
"""
from __future__ import annotations

import io
import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

USER_AGENT = "Beetwerk (selbst gehostete Gartenplanung)"
MARGIN_M = 12.0          # Umgebung rund um die Grenze im gespeicherten Luftbild
WMS_RESOLUTION = 0.1     # Meter pro Pixel beim WMS-Abruf
MAX_PIXELS = 4000
MAX_TILES = 64

SOURCES = {
    "bayern-dop20": {
        "label": "Luftbild Bayern (20 cm)",
        "type": "wms",
        "url": "https://geoservices.bayern.de/od/wms/dop/v1/dop20",
        "layers": "by_dop20c",
        "attribution": "Luftbild © Bayerische Vermessungsverwaltung, CC BY 4.0",
        "snapshot": True,
    },
    "bayern-dop20-cir": {
        "label": "Luftbild Bayern Colorinfrarot",
        "type": "wms",
        "url": "https://geoservices.bayern.de/od/wms/dop/v1/dop20",
        "layers": "by_dop20cir",
        "attribution": "Luftbild © Bayerische Vermessungsverwaltung, CC BY 4.0",
        "snapshot": True,
    },
    "osm": {
        "label": "OpenStreetMap (nur zur Orientierung)",
        "type": "xyz",
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "max_zoom": 19,
        "attribution": "© OpenStreetMap-Mitwirkende",
        "snapshot": False,
    },
}


class GeoError(Exception):
    """Fehler, die der Nutzer lesen soll."""


# ---------------------------------------------------------------- Koordinaten

def meters_per_degree(lat: float) -> tuple[float, float]:
    p = math.radians(lat)
    m_lat = 111132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
    m_lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)
    return m_lat, m_lon


@dataclass
class Frame:
    lat0: float
    lon0: float
    bearing: float
    ox: float = 0.0
    oy: float = 0.0

    def __post_init__(self):
        self.m_lat, self.m_lon = meters_per_degree(self.lat0)
        b = math.radians(self.bearing)
        self.s, self.c = math.sin(b), math.cos(b)

    def to_enu(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.m_lon, (lat - self.lat0) * self.m_lat

    def from_enu(self, e: float, n: float) -> tuple[float, float]:
        return self.lat0 + n / self.m_lat, self.lon0 + e / self.m_lon

    def enu_to_local(self, e: float, n: float) -> tuple[float, float]:
        return e * self.s + n * self.c - self.ox, e * self.c - n * self.s - self.oy

    def local_to_enu(self, x: float, y: float) -> tuple[float, float]:
        X, Y = x + self.ox, y + self.oy
        return X * self.s + Y * self.c, X * self.c - Y * self.s

    def to_local(self, lat: float, lon: float) -> tuple[float, float]:
        return self.enu_to_local(*self.to_enu(lat, lon))

    def to_latlon(self, x: float, y: float) -> tuple[float, float]:
        return self.from_enu(*self.local_to_enu(x, y))

    def as_dict(self) -> dict:
        return {"lat0": self.lat0, "lon0": self.lon0, "bearing": self.bearing, "ox": self.ox, "oy": self.oy}


def frame_for(boundary: list[tuple[float, float]], bearing: float) -> Frame:
    lat0 = sum(p[0] for p in boundary) / len(boundary)
    lon0 = sum(p[1] for p in boundary) / len(boundary)
    f = Frame(lat0, lon0, bearing % 360)
    pts = [f.to_local(lat, lon) for lat, lon in boundary]
    f.ox = min(x for x, _ in pts)
    f.oy = min(y for _, y in pts)
    return f


def polygon_area(pts: list[tuple[float, float]]) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def build_geo(boundary: list[tuple[float, float]], bearing: float) -> dict:
    if len(boundary) < 3:
        raise GeoError("Die Grenze braucht mindestens drei Punkte")
    f = frame_for(boundary, bearing)
    poly = [f.to_local(lat, lon) for lat, lon in boundary]
    width = max(x for x, _ in poly)
    height = max(y for _, y in poly)
    if width > 2000 or height > 2000:
        raise GeoError("Das Grundstück ist größer als 2 km. Bitte die Grenze prüfen.")
    area = polygon_area(poly)
    if area < 1:
        raise GeoError("Die Grenze umschließt keine Fläche")
    return {
        "boundary": [[round(lat, 8), round(lon, 8)] for lat, lon in boundary],
        "frame": f.as_dict(),
        "polygon": [[round(x, 3), round(y, 3)] for x, y in poly],
        "width": round(width, 2),
        "height": round(height, 2),
        "area": round(area, 1),
    }


def frame_from(geo: dict) -> Frame:
    fr = geo["frame"]
    return Frame(fr["lat0"], fr["lon0"], fr["bearing"], fr["ox"], fr["oy"])


def reanchor_bed(bed: dict, old: Frame, new: Frame) -> dict:
    """Beet an derselben Stelle auf der Erde halten, wenn sich das Koordinatensystem ändert."""
    cx = bed["x"] + bed["length"] / 2
    cy = bed["y"] + bed["width"] / 2
    lat, lon = old.to_latlon(cx, cy)
    nx, ny = new.to_local(lat, lon)
    rot = (bed["rotation"] + old.bearing - new.bearing) % 360
    return {
        "x": round(nx - bed["length"] / 2, 3),
        "y": round(ny - bed["width"] / 2, 3),
        "rotation": round(rot, 3),
    }


# ---------------------------------------------------------------- Luftbild

def resolve_source(source_id: str, custom: dict | None) -> dict:
    if source_id == "custom":
        if not custom or not custom.get("url"):
            raise GeoError("Für eine eigene Quelle fehlt die Adresse")
        src = {"label": "Eigene Quelle", "snapshot": True, **custom}
        if src.get("type") not in ("wms", "xyz"):
            raise GeoError("Eigene Quelle: Typ muss WMS oder XYZ sein")
        if not str(src["url"]).startswith(("http://", "https://")):
            raise GeoError("Eigene Quelle: Adresse muss mit http:// oder https:// beginnen")
        if src["type"] == "wms" and not src.get("layers"):
            raise GeoError("Eigene WMS-Quelle: Layer fehlt")
        return src
    if source_id not in SOURCES:
        raise GeoError("Unbekannte Luftbildquelle")
    return SOURCES[source_id]


def _get(url: str, timeout: float = 25) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read(), res.headers.get("Content-Type", "")
    except Exception as exc:  # Netzwerk, HTTP-Fehler, Zeitüberschreitung
        host = urllib.parse.urlsplit(url).netloc
        raise GeoError(f"Luftbild konnte nicht von {host} geladen werden ({exc})") from exc


def snapshot_bbox(geo: dict) -> tuple[float, float, float, float]:
    """Süd, West, Nord, Ost der Grenze plus Rand."""
    f = frame_from(geo)
    es, ns = zip(*(f.to_enu(lat, lon) for lat, lon in geo["boundary"]))
    s_lat, w_lon = f.from_enu(min(es) - MARGIN_M, min(ns) - MARGIN_M)
    n_lat, e_lon = f.from_enu(max(es) + MARGIN_M, max(ns) + MARGIN_M)
    return s_lat, w_lon, n_lat, e_lon


def fetch_wms(src: dict, bbox: tuple[float, float, float, float], frame: Frame) -> tuple[bytes, tuple]:
    s, w, n, e = bbox
    width_m = (e - w) * frame.m_lon
    height_m = (n - s) * frame.m_lat
    res = max(WMS_RESOLUTION, max(width_m, height_m) / MAX_PIXELS)
    px_w = max(64, round(width_m / res))
    px_h = max(64, round(height_m / res))
    params = {
        "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap",
        "LAYERS": src["layers"], "STYLES": "", "SRS": "EPSG:4326",
        "BBOX": f"{w},{s},{e},{n}", "WIDTH": px_w, "HEIGHT": px_h,
        "FORMAT": "image/jpeg",
    }
    sep = "&" if "?" in src["url"] else "?"
    data, ctype = _get(src["url"] + sep + urllib.parse.urlencode(params))
    if not ctype.startswith("image/"):
        text = data[:300].decode("utf-8", "replace")
        raise GeoError(f"Der Kartendienst hat kein Bild geliefert: {text}")
    return data, bbox


def _tile_x(lon: float, z: int) -> float:
    return (lon + 180) / 360 * 2 ** z


def _tile_y(lat: float, z: int) -> float:
    r = math.radians(lat)
    return (1 - math.asinh(math.tan(r)) / math.pi) / 2 * 2 ** z


def _tile_lat(y: float, z: int) -> float:
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** z))))


def _tile_lon(x: float, z: int) -> float:
    return x / 2 ** z * 360 - 180


def fetch_xyz(src: dict, bbox: tuple[float, float, float, float]) -> tuple[bytes, tuple]:
    from PIL import Image

    s, w, n, e = bbox
    z = int(src.get("max_zoom") or 19)
    while True:
        x0, x1 = int(_tile_x(w, z)), int(_tile_x(e, z))
        y0, y1 = int(_tile_y(n, z)), int(_tile_y(s, z))
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES or z <= 12:
            break
        z -= 1
    size = None
    mosaic = None
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            url = (src["url"].replace("{z}", str(z)).replace("{x}", str(tx))
                   .replace("{y}", str(ty)).replace("{-y}", str(2 ** z - 1 - ty)))
            data, _ = _get(url)
            try:
                tile = Image.open(io.BytesIO(data)).convert("RGB")
            except Exception as exc:
                raise GeoError(f"Kachel {z}/{tx}/{ty} ist kein Bild") from exc
            if mosaic is None:
                size = tile.size[0]
                mosaic = Image.new("RGB", ((x1 - x0 + 1) * size, (y1 - y0 + 1) * size))
            if tile.size[0] != size:
                tile = tile.resize((size, size))
            mosaic.paste(tile, ((tx - x0) * size, (ty - y0) * size))
    out = io.BytesIO()
    mosaic.save(out, "JPEG", quality=85)
    tile_bbox = (_tile_lat(y1 + 1, z), _tile_lon(x0, z), _tile_lat(y0, z), _tile_lon(x1 + 1, z))
    return out.getvalue(), tile_bbox


def fetch_snapshot(geo: dict, src: dict, target: Path) -> dict:
    """Luftbild rund um die Grenze holen und speichern. Liefert Lage (Süd, West, Nord, Ost)."""
    if not src.get("snapshot", True):
        raise GeoError("Diese Quelle ist nur zur Orientierung gedacht und wird nicht gespeichert")
    frame = frame_from(geo)
    bbox = snapshot_bbox(geo)
    if src["type"] == "wms":
        data, img_bbox = fetch_wms(src, bbox, frame)
    else:
        data, img_bbox = fetch_xyz(src, bbox)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return {
        "bbox": list(img_bbox),
        "attribution": src.get("attribution", ""),
        "source": src.get("label", ""),
        "fetched_at": int(time.time()),
    }


def dumps(geo: dict | None) -> str:
    return json.dumps(geo, ensure_ascii=False, separators=(",", ":")) if geo else ""


def loads(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None
