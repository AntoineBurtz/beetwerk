"""Künstliche Claude-Schnittstelle mit Websuche, dazu Wikimedia Commons und ein Saatgut-Shop.

Aufruf für Versuche mit der Oberfläche:  python tests/fakeclaude.py 8794
und Beetwerk mit BEETWERK_ANTHROPIC_URL=http://127.0.0.1:8794,
BEETWERK_COMMONS_URL=http://127.0.0.1:8794/w/api.php und BEETWERK_ALLOW_PRIVATE_FETCH=1 starten.
API-Schlüssel: sk-test
"""
import io
import json
import os
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _jpeg(color="#c0392b", size=(64, 48)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "JPEG")
    return buf.getvalue()


class Fake(BaseHTTPRequestHandler):
    """Claude-Schnittstelle, Wikimedia Commons und ein Saatgut-Shop in einem."""
    calls: list = []
    base = ""

    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8") if not isinstance(body, str) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/w/api.php"):
            return self._send(200, {"query": {"pages": {"1": {"index": 1, "imageinfo": [{
                "url": f"{self.base}/img/commons.jpg", "thumburl": f"{self.base}/img/commons.jpg", "mime": "image/jpeg",
                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Ochsenherz.jpg",
                "extmetadata": {"LicenseShortName": {"value": "CC BY-SA 4.0"}, "Artist": {"value": "<a>Gärtnerin</a>"}}}]}}}})
        if self.path == "/shop/ochsenherz":
            return self._send(200, '<html><head><meta property="og:image" content="/img/shop.jpg"></head></html>',
                              "text/html; charset=utf-8")
        if self.path.startswith("/img/"):
            return self._send(200, _jpeg(), "image/jpeg")
        return self._send(404, {"error": "nicht da"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Fake.calls.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        if self.headers.get("x-api-key") != "sk-test":
            return self._send(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        if body["max_tokens"] == 5:
            return self._send(200, {"model": body["model"], "content": [{"type": "text", "text": "OK"}],
                                    "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 1}})
        time.sleep(float(os.environ.get("FAKE_CLAUDE_DELAY") or 0))  # für Versuche mit der Oberfläche
        usage = {"input_tokens": 1000, "output_tokens": 200, "server_tool_use": {"web_search_requests": 1}}
        if len(body["messages"]) == 1:  # erste Runde: Websuche, dann Pause
            return self._send(200, {"stop_reason": "pause_turn", "usage": usage, "content": [
                {"type": "server_tool_use", "id": "srv1", "name": "web_search", "input": {"query": "Ochsenherz Tomate"}},
                {"type": "web_search_tool_result", "tool_use_id": "srv1", "content": [
                    {"type": "web_search_result", "url": f"{self.base}/shop/ochsenherz", "title": "Ochsenherz – Shop",
                     "encrypted_content": "x"}]}]})
        prompt = json.dumps(body["messages"][0]["content"], ensure_ascii=False)
        if len(body["messages"]) >= 3:  # Nachfrage: nur die genannten fehlenden Angaben
            asked = body["messages"][-1]["content"][-1]["text"]
            extra = {k: v for k, v in FOLLOW.items() if f"- {k}:" in asked}
            answer = {"traits": {k: v for k, v in extra.items() if k not in FOLLOW_FIELDS},
                      **{k: v for k, v in extra.items() if k in FOLLOW_FIELDS},
                      "sources": [{"url": f"{self.base}/shop/datenblatt", "title": "Datenblatt"}]}
            return self._send(200, {"stop_reason": "end_turn", "usage": usage, "content": [
                {"type": "server_tool_use", "id": "srv2", "name": "web_search", "input": {"query": "Scoville"}},
                {"type": "text", "text": "Nachgetragen:\n```json\n" + json.dumps(answer, ensure_ascii=False) + "\n```"}]})
        if "„Habanero Orange" in prompt:  # wie im Echten: Scoville fehlt in der ersten Antwort
            answer = {"name": "Habanero Orange", "crop": "Chili", "species": "Capsicum chinense", "kind": "Habanero-Typ",
                      "seed": "samenfest", "description": "", "confidence": "hoch",
                      "traits": {"plant_size": "mittel", "height": "60–80 cm", "pep_fruit_color": "Orange",
                                 "pep_pungency": "vorhanden"},
                      "sources": [{"url": f"{self.base}/shop/habanero", "title": "Shop"}], "images": []}
            return self._send(200, {"stop_reason": "end_turn", "usage": usage, "content": [
                {"type": "text", "text": "```json\n" + json.dumps(answer, ensure_ascii=False) + "\n```"}]})
        named = "Ochsenherz" if ("„Ochsenherz" in prompt or '"type": "image"' in prompt) else "Unbekannte Sorte"
        answer = {"name": named, "crop": "Tomate", "species": "Solanum lycopersicum", "kind": "Fleischtomate",
                  "seed": "samenfest", "supplier": "", "description": "Große, herzförmige Früchte.",
                  # Klassen und Zahlen getrennt, dazu etwas, das nicht passt
                  "traits": {"plant_size": "groß", "height": "150–200 cm", "tom_growth": "indeterminiert (Stabtomate)",
                             "fruit_size": "sehr groß", "tom_fruit_weight": "250 g", "tom_fruit_color": "Rot",
                             "maturity_class": "mittelspät", "days_to_maturity": "75 bis 85 Tage",
                             "tom_fruit_shape": "herzförmig", "pep_scoville": 50000, "tom_locules": "viele",
                             "erfunden": "x"},
                  "confidence": "hoch" if named == "Ochsenherz" else "niedrig", "sources": [{"url": f"{self.base}/shop/ochsenherz", "title": "Shop"}],
                  "images": []}
        return self._send(200, {"stop_reason": "end_turn", "usage": usage, "content": [
            {"type": "text", "text": "Hier das Ergebnis:\n```json\n" + json.dumps(answer, ensure_ascii=False) + "\n```"}]})


# Was die Nachfrage findet, wenn danach gefragt wird
FOLLOW = {"pep_scoville": "100.000–350.000 SHU", "pep_fruit_weight": "8 g", "pep_species": "C. chinense",
          "pep_fruit_shape": "herzförmig", "tom_locules": "5–6", "tom_brix": "5,5",
          "description": "Orange Habanero mit fruchtigem Aroma und sehr hoher Schärfe."}
FOLLOW_FIELDS = {"species", "kind", "seed", "description"}


def serve(port: int = 0):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Fake)
    Fake.base = f"http://127.0.0.1:{srv.server_address[1]}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    srv = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8794)
    print(f"Künstliches Claude auf {Fake.base}")
    threading.Event().wait()
