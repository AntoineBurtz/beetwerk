"""Kleines künstliches Baserow für Tests: nur die Endpunkte, die Beetwerk nutzt.

Aufruf für Versuche mit der Oberfläche:  python tests/fakebaserow.py 8793
Anmeldung: garten@example.org / geheim, eine Datenbank „Garten“ mit der Tabelle „Sorten“.
"""
import json
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

EMAIL, PASSWORD = "garten@example.org", "geheim"


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.seq = 100
        self.jwts = set()
        self.tokens = {}
        self.files = {}
        self.calls = []
        self.workspace = {"id": 1, "name": "Mein Garten"}
        self.databases = {10: {"id": 10, "name": "Garten", "tables": []}}
        self.tables = {}  # id -> {"id", "name", "database", "fields": [..], "rows": {id: row}}
        sorten = self.add_table(10, "Sorten", "Name")
        for name in ("Ochsenherz", "Green Zebra", "Lemon Drop"):
            self.add_row(sorten, {"Name": name})
        etiketten = self.add_table(10, "Etiketten", "Etikett")
        for label in ("T26-001", "T26-002"):
            self.add_row(etiketten, {"Etikett": label})
        self.add_table(10, "Notizen", "Titel")

    def next_id(self):
        self.seq += 1
        return self.seq

    def add_table(self, db_id, name, primary):
        tid = self.next_id()
        table = {"id": tid, "name": name, "database": db_id, "rows": {},
                 "fields": [{"id": self.next_id(), "name": primary, "type": "text", "primary": True}]}
        self.tables[tid] = table
        self.databases[db_id]["tables"].append(tid)
        return table

    def add_row(self, table, values):
        rid = self.next_id()
        row = {"id": rid, **{f["name"]: _empty(f) for f in table["fields"]}, **values}
        table["rows"][rid] = row
        return row


def _empty(field):
    return [] if field["type"] in ("link_row", "file") else False if field["type"] == "boolean" else None


class Handler(BaseHTTPRequestHandler):
    store: Store = None

    def log_message(self, *args):
        pass

    def _send(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, status, code, detail=""):
        self._send(status, {"error": code, "detail": detail})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _auth(self):
        a = self.headers.get("Authorization", "")
        if a.startswith("JWT ") and a[4:] in self.store.jwts:
            return "jwt"
        if a.startswith("Token ") and a[6:] in self.store.tokens:
            return "token"
        return None

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PATCH(self):
        self._route("PATCH")

    def _route(self, method):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        raw = self._body()
        s = self.store
        with s.lock:
            s.calls.append((method, path))
            if path == "/_state":
                return self._send(200, {"tables": list(s.tables.values()), "files": list(s.files)})
            if path == "/api/user/token-auth/" and method == "POST":
                data = json.loads(raw or b"{}")
                if data.get("email") == EMAIL and data.get("password") == PASSWORD:
                    jwt = secrets.token_hex(8)
                    s.jwts.add(jwt)
                    return self._send(200, {"access_token": jwt, "refresh_token": "r", "user": {"username": EMAIL}})
                return self._err(401, "ERROR_INVALID_CREDENTIALS", "Invalid credentials")
            auth = self._auth()
            if auth is None:
                return self._err(401, "ERROR_INVALID_ACCESS_TOKEN", "Token invalid")
            if path == "/api/applications/" and method == "GET" and auth == "jwt":
                return self._send(200, [{"id": d["id"], "name": d["name"], "type": "database", "workspace": s.workspace,
                                         "tables": [{"id": t, "name": s.tables[t]["name"], "database_id": d["id"]}
                                                    for t in d["tables"]]} for d in s.databases.values()])
            m = re.fullmatch(r"/api/database/tables/database/(\d+)/", path)
            if m and method == "POST" and auth == "jwt":
                data = json.loads(raw)
                header = data["data"][0] if data.get("first_row_header") else ["Field 1"]
                t = s.add_table(int(m.group(1)), data["name"], header[0])
                for extra in header[1:]:
                    t["fields"].append({"id": s.next_id(), "name": extra, "type": "text", "primary": False})
                return self._send(200, {"id": t["id"], "name": t["name"], "order": 1, "database_id": t["database"]})
            m = re.fullmatch(r"/api/database/fields/table/(\d+)/", path)
            if m:
                t = s.tables.get(int(m.group(1)))
                if t is None:
                    return self._err(404, "ERROR_TABLE_DOES_NOT_EXIST")
                if method == "GET":
                    return self._send(200, [{**f, "table_id": t["id"]} for f in t["fields"]])
                if method == "POST" and auth == "jwt":
                    data = json.loads(raw)
                    if any(f["name"] == data["name"] for f in t["fields"]):
                        return self._err(400, "ERROR_FIELD_WITH_SAME_NAME_ALREADY_EXISTS")
                    field = {"id": s.next_id(), "name": data["name"], "type": data["type"], "primary": False}
                    if data["type"] == "link_row":
                        target = s.tables[data["link_row_table_id"]]
                        field["link_row_table_id"] = target["id"]
                        if data.get("has_related_field", True):
                            target["fields"].append({"id": s.next_id(), "name": t["name"], "type": "link_row",
                                                     "primary": False, "link_row_table_id": t["id"]})
                    for k in ("number_decimal_places", "date_format"):
                        if k in data:
                            field[k] = data[k]
                    t["fields"].append(field)
                    for row in t["rows"].values():
                        row[field["name"]] = _empty(field)
                    return self._send(200, field)
            if path == "/api/database/tokens/" and method == "POST" and auth == "jwt":
                key = secrets.token_hex(16)
                s.tokens[key] = json.loads(raw)
                return self._send(200, {"id": len(s.tokens), "name": "Beetwerk", "key": key, "workspace": 1,
                                        "permissions": {"create": True, "read": True, "update": True, "delete": True}})
            if path == "/api/user-files/upload-file/" and method == "POST":
                m = re.search(rb'filename="([^"]+)"', raw)
                name = f"{secrets.token_hex(6)}_{m.group(1).decode() if m else 'datei'}"
                s.files[name] = len(raw)
                return self._send(200, {"name": name, "visible_name": m.group(1).decode() if m else "datei",
                                        "url": f"/media/user_files/{name}", "is_image": True, "size": len(raw)})
            m = re.fullmatch(r"/api/database/rows/table/(\d+)/(batch/|batch-delete/)?", path)
            if m and auth == "token":
                t = s.tables.get(int(m.group(1)))
                if t is None:
                    return self._err(404, "ERROR_TABLE_DOES_NOT_EXIST")
                kind = m.group(2)
                if method == "GET" and not kind:
                    rows = sorted(t["rows"].values(), key=lambda r: r["id"])
                    size = int(query.get("size", ["100"])[0])
                    page = int(query.get("page", ["1"])[0])
                    chunk = rows[(page - 1) * size: page * size]
                    nxt = "next" if page * size < len(rows) else None
                    return self._send(200, {"count": len(rows), "next": nxt, "previous": None, "results": chunk})
                data = json.loads(raw or b"{}")
                items = data.get("items") or []
                if len(items) > 200:
                    return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", "too many items")
                if kind == "batch-delete/" and method == "POST":
                    missing = [i for i in items if i not in t["rows"]]
                    if missing:
                        return self._err(404, "ERROR_ROW_DOES_NOT_EXIST", f"The rows {missing} do not exist.")
                    for i in items:
                        del t["rows"][i]
                    return self._send(204)
                if kind == "batch/":
                    problem = self._check(t, items, update=method == "PATCH")
                    if problem:
                        return problem
                    out = []
                    if method == "POST":
                        for item in items:
                            out.append(s.add_row(t, item))
                    elif method == "PATCH":
                        missing = [i["id"] for i in items if i["id"] not in t["rows"]]
                        if missing:
                            return self._err(404, "ERROR_ROW_DOES_NOT_EXIST", f"The rows {missing} do not exist.")
                        for item in items:
                            row = t["rows"][item["id"]]
                            row.update({k: v for k, v in item.items() if k != "id"})
                            out.append(row)
                    return self._send(200, {"items": out})
            return self._err(404, "ERROR_NOT_FOUND", f"{method} {path}")

    def _check(self, t, items, update):
        fields = {f["name"]: f for f in t["fields"]}
        for item in items:
            for k, v in item.items():
                if k == "id" and update:
                    continue
                f = fields.get(k)
                if f is None:
                    return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": "unknown field"}]})
                if f["type"] == "link_row":
                    target = self.store.tables[f["link_row_table_id"]]
                    if not isinstance(v, list) or any(x not in target["rows"] for x in v):
                        return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": f"bad link {v}"}]})
                if f["type"] == "file":
                    if not isinstance(v, list) or any(x.get("name") not in self.store.files for x in v):
                        return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": "unknown file"}]})
                if f["type"] == "number" and v is not None and not isinstance(v, (int, float)):
                    return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": "not a number"}]})
                if f["type"] == "date" and v is not None and not re.fullmatch(r"\d{4}-\d\d-\d\d", str(v)):
                    return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": "bad date"}]})
                if f["type"] == "boolean" and not isinstance(v, bool):
                    return self._err(400, "ERROR_REQUEST_BODY_VALIDATION", {k: [{"error": "not a boolean"}]})
        return None


def serve(port: int = 0):
    store = Store()
    handler = type("BoundHandler", (Handler,), {"store": store})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, store


if __name__ == "__main__":
    server, _ = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8793)
    print(f"Künstliches Baserow auf http://127.0.0.1:{server.server_address[1]}")
    threading.Event().wait()
