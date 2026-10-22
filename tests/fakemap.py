"""Kleiner Kartendienst für Tests: liefert ein künstliches Luftbild als WMS und als Kacheln.

Das Bild zeigt ein um 25° gedrehtes Grundstück (20 x 12 m) mit drei Beeten und roten
Eckpunkten an bekannten Koordinaten. So lässt sich prüfen, ob Grenze und Bild deckungsgleich sind.

Start von Hand: python tests/fakemap.py 8790
"""
import io
import math
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw

CENTER = (48.0, 11.0)
ANGLE = 25.0  # Drehung der langen Seite gegen Osten, gegen den Uhrzeigersinn
SIZE = (20.0, 12.0)


def _mpd(lat):
    p = math.radians(lat)
    return (111132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p),
            111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p))


M_LAT, M_LON = _mpd(CENTER[0])


def ll(e, n):
    """Meter östlich/nördlich der Mitte → (lat, lon)."""
    a = math.radians(ANGLE)
    E = e * math.cos(a) - n * math.sin(a)
    N = e * math.sin(a) + n * math.cos(a)
    return CENTER[0] + N / M_LAT, CENTER[1] + E / M_LON


def rect(e0, n0, e1, n1):
    return [ll(e0, n0), ll(e1, n0), ll(e1, n1), ll(e0, n1)]


W2, H2 = SIZE[0] / 2, SIZE[1] / 2
PLOT = rect(-W2, -H2, W2, H2)
CORNERS = PLOT
BEDS = [rect(-8, 3, 8, 4.2), rect(-8, 0, 8, 1.2), rect(-8, -3, 8, -1.8)]


def render(width, height, to_px):
    img = Image.new("RGB", (width, height), (150, 150, 140))
    d = ImageDraw.Draw(img)
    # Raster alle 5 m, damit Verzerrungen auffallen
    for k in range(-40, 41, 5):
        d.line([to_px(*ll(k, -40)), to_px(*ll(k, 40))], fill=(170, 170, 160), width=1)
        d.line([to_px(*ll(-40, k)), to_px(*ll(40, k))], fill=(170, 170, 160), width=1)
    d.polygon([to_px(*p) for p in PLOT], fill=(70, 140, 60))
    for bed in BEDS:
        d.polygon([to_px(*p) for p in bed], fill=(120, 80, 50))
    for lat, lon in CORNERS:
        x, y = to_px(lat, lon)
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(230, 30, 30))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90)
    return out.getvalue()


def tile_y(lat, z):
    r = math.radians(lat)
    return (1 - math.asinh(math.tan(r)) / math.pi) / 2 * 2 ** z


def tile_x(lon, z):
    return (lon + 180) / 360 * 2 ** z


class Handler(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        Handler.calls.append(self.path)
        if url.path == "/wms":
            q = {k.upper(): v for k, v in urllib.parse.parse_qsl(url.query)}
            if q.get("REQUEST") != "GetMap":
                return self._send(400, b"<ServiceException>nur GetMap</ServiceException>", "application/xml")
            w, h = int(q["WIDTH"]), int(q["HEIGHT"])
            if q.get("SRS", q.get("CRS")) == "EPSG:3857":
                x0, y0, x1, y1 = map(float, q["BBOX"].split(","))

                def to_px(lat, lon):
                    mx = lon * 20037508.34 / 180
                    my = math.log(math.tan(math.radians(90 + lat) / 2)) * 20037508.34 / math.pi
                    return (mx - x0) / (x1 - x0) * w, (y1 - my) / (y1 - y0) * h
            else:
                west, south, east, north = map(float, q["BBOX"].split(","))

                def to_px(lat, lon):
                    return (lon - west) / (east - west) * w, (north - lat) / (north - south) * h
            return self._send(200, render(w, h, to_px), "image/jpeg")
        parts = url.path.strip("/").split("/")
        if len(parts) == 4 and parts[0] == "tiles":
            z, x, y = int(parts[1]), int(parts[2]), int(parts[3].split(".")[0])

            def to_px(lat, lon):
                return (tile_x(lon, z) - x) * 256, (tile_y(lat, z) - y) * 256
            return self._send(200, render(256, 256, to_px), "image/jpeg")
        self._send(404, b"nicht gefunden", "text/plain")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def start(port=0):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    srv = start(int(sys.argv[1]) if len(sys.argv) > 1 else 8790)
    print(f"Fake-Luftbild auf http://127.0.0.1:{srv.server_port}", flush=True)
    threading.Event().wait()
