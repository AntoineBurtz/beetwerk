"""Abgleich der Bonitur mit Baserow (vorerst nur in eine Richtung: Beetwerk → Baserow).

Beetwerk legt drei Tabellen an (Merkmale, Pflanzen, Boniturwerte) oder nutzt
vorhandene mit denselben Feldnamen. Jede Zeile trägt die Beetwerk-ID; welche
Baserow-Zeile zu einem Eintrag gehört, merkt sich Beetwerk in `baserow_id`.
Geändert wird nur, was sich seit dem letzten Abgleich verändert hat (Prüfsumme
über den Inhalt). In Beetwerk gelöschte Einträge werden auch in Baserow gelöscht.

Zum Einrichten meldet sich Beetwerk einmal mit E-Mail und Passwort an (JWT),
legt Tabellen, Felder und einen Datenbank-Token an und speichert nur den Token.
"""
import hashlib
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import bonitur, db, methods, profile

USER_AGENT = "Beetwerk (selbst gehostete Anbauplanung)"
TIMEOUT = 30
BATCH = 100
# Automatischer Abgleich so viele Sekunden nach einer Änderung; 0 schaltet ihn ab (Tests)
DELAY = float(os.environ.get("BEETWERK_BASEROW_DELAY", "15"))
PERIOD = 30 * 60  # und ohnehin alle 30 Minuten, falls etwas liegen geblieben ist

KEYS = ("baserow_url", "baserow_token", "baserow_config", "baserow_state")

# ---------------------------------------------------------------- Tabellen und Felder

TEXT = {"type": "text"}
LONG = {"type": "long_text"}
INT = {"type": "number", "number_decimal_places": 0, "number_negative": False}
DECIMAL = {"type": "number", "number_decimal_places": 3, "number_negative": True}
DATE = {"type": "date", "date_format": "EU", "date_include_time": False}
BOOL = {"type": "boolean"}
FILE = {"type": "file"}

DECIMAL2 = {"type": "number", "number_decimal_places": 2, "number_negative": False}
NUM1 = {"type": "number", "number_decimal_places": 1, "number_negative": False}

TABLES = {
    "crops": {
        "name": "Kulturen",
        "primary": "Kultur",
        "fields": [
            ("Familie", TEXT), ("Anbauart", TEXT), ("Anzucht (Tage)", INT), ("Bis Ernte (Tage)", INT),
            ("Erntedauer (Tage)", INT), ("Reihenabstand (cm)", INT), ("Pflanzabstand (cm)", INT),
            ("Bonitur-Merkmale", TEXT), ("Farbe", TEXT), ("Notizen", LONG), ("Beetwerk-ID", INT),
        ],
    },
    "varieties": {
        "name": "Beetwerk-Sorten",
        "primary": "Sorte",
        "fields": [
            ("Kultur", {"type": "link_row", "to": "crops"}), ("Botanische Art", TEXT), ("Typ", TEXT),
            ("Saatgut", TEXT), ("Wuchs", TEXT), ("Fruchtfarbe", TEXT), ("Reife", TEXT), ("Bezugsquelle", TEXT),
            ("Gekauft", TEXT), ("Beschreibung", LONG), ("Foto", FILE), ("Bildquelle", TEXT), ("Quellen", LONG),
            ("Notizen", LONG), ("Beetwerk-ID", INT),
            # Merkmale: Klasse und Zahl getrennt; „Merkmale“ führt alle mit Herkunft auf
            ("Pflanzengröße", TEXT), ("Pflanzenhöhe (cm)", NUM1), ("Fruchtgröße", TEXT), ("Fruchtgewicht (g)", NUM1),
            ("Tage bis Reife", INT), ("Schärfe (SHU)", INT), ("Merkmale", LONG),
        ],
    },
    "plantings": {
        "name": "Sätze",
        "primary": "Satz",
        "fields": [
            ("Kultur", {"type": "link_row", "to": "crops"}), ("Sorten", {"type": "link_row", "to": "varieties"}),
            ("Sorten (Text)", TEXT), ("Beet", TEXT), ("Anbau", TEXT), ("Jahr", INT), ("Aussaat", DATE),
            ("Pflanzung", DATE), ("Ernte ab", DATE), ("Ernte bis", DATE), ("Pflanzen", INT), ("Fläche (m²)", DECIMAL2),
            ("Notizen", LONG), ("Beetwerk-ID", INT),
        ],
    },
    "traits": {
        "name": "Bonitur-Merkmale",
        "primary": "Merkmal",
        "fields": [
            ("Schlüssel", TEXT), ("Kultur", TEXT), ("Bereich", TEXT), ("Häufigkeit", TEXT), ("Ebene", TEXT),
            ("Werttyp", TEXT), ("Auswahlwerte", LONG), ("Einheit", TEXT), ("Zeitpunkt", TEXT), ("Hinweis", LONG),
            ("Vorlage", TEXT), ("Aktiv", BOOL), ("Beetwerk-ID", INT),
        ],
    },
    "plants": {
        "name": "Bonitur-Pflanzen",
        "primary": "Pflanze",
        "fields": [
            ("Etikett", TEXT), ("Jahr", INT), ("Kultur", TEXT), ("Sorte", TEXT), ("Beet", TEXT), ("Satz", TEXT),
            ("Nr", INT), ("Reihe", INT), ("Platz", INT), ("Status", TEXT), ("Notiz", LONG), ("Beetwerk-ID", INT),
        ],
    },
    "observations": {
        "name": "Boniturwerte",
        "primary": "Eintrag",
        "fields": [
            ("Datum", DATE), ("Pflanze", {"type": "link_row", "to": "plants"}),
            ("Merkmal", {"type": "link_row", "to": "traits"}), ("Sorte", TEXT), ("Satz", TEXT), ("Ebene", TEXT),
            ("Wert", TEXT), ("Zahl", DECIMAL), ("Einheit", TEXT), ("Einzelwerte", TEXT), ("Notiz", LONG),
            ("Foto", FILE), ("Beetwerk-ID", INT), ("Geändert", TEXT),
        ],
    },
}
ORDER = ("crops", "varieties", "plantings", "traits", "plants", "observations")
BASE = ("traits", "plants", "observations")         # nötig für die Bonitur
EXTRA = ("crops", "varieties", "plantings")         # Kulturen, Sorten und Sätze, seit Version 2 dabei
# Pflanzen zusätzlich mit der Beetwerk-Sortenliste verknüpfen, wenn es die Tabelle gibt
SORT_FIELD = ("Beetwerk-Sorte", {"type": "link_row", "to": "varieties"})
# Verknüpfung mit vorhandenen Tabellen (Sorten, Etiketten); Feldname → (Tabellen, Schlüssel der Einstellung)
VARIETY_FIELD = "Sorte verknüpft"
LABEL_FIELD = "Etikett verknüpft"
TEXTLIKE = {"text", "long_text"}


class BaserowError(Exception):
    pass


class AddressError(BaserowError):
    """Unter der Adresse ist kein (erreichbares) Baserow."""


class RowsMissing(BaserowError):
    def __init__(self, ids: list[int]):
        super().__init__(f"Zeilen fehlen in Baserow: {ids}")
        self.ids = ids


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        raise BaserowError("Bitte die Adresse von Baserow angeben")
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    url = re.sub(r"/api$", "", url)
    parts = urllib.parse.urlsplit(url)
    if not parts.netloc:
        raise BaserowError("Die Adresse sieht nicht wie eine Web-Adresse aus")
    return url


# ---------------------------------------------------------------- Zugriff auf die Schnittstelle

class Client:
    def __init__(self, url: str, token: Optional[str] = None, jwt: Optional[str] = None):
        self.url = normalize_url(url)
        self.auth = f"Token {token}" if token else f"JWT {jwt}" if jwt else None

    def call(self, method: str, path: str, body: Any = None, params: Optional[dict] = None,
             raw: Optional[bytes] = None, content_type: Optional[str] = None) -> Any:
        full = f"{self.url}{path}"
        if params:
            full += "?" + urllib.parse.urlencode(params)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if self.auth:
            headers["Authorization"] = self.auth
        data = None
        if raw is not None:
            data = raw
            headers["Content-Type"] = content_type or "application/octet-stream"
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(full, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                text = res.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            raise _http_error(exc, self.url) from exc
        except urllib.error.URLError as exc:
            raise AddressError(f"Baserow ist unter {self.url} nicht erreichbar ({exc.reason})") from exc
        except (TimeoutError, OSError) as exc:
            raise AddressError(f"Baserow ist unter {self.url} nicht erreichbar ({exc})") from exc
        except ValueError as exc:
            raise AddressError(f"Unter {self.url} antwortet kein Baserow (keine gültige Antwort)") from exc

    def rows(self, table_id: int) -> list[dict]:
        out, page = [], 1
        while True:
            res = self.call("GET", f"/api/database/rows/table/{table_id}/",
                            params={"user_field_names": "true", "size": 200, "page": page})
            out += res.get("results", [])
            if not res.get("next"):
                return out
            page += 1

    def fields(self, table_id: int) -> list[dict]:
        return self.call("GET", f"/api/database/fields/table/{table_id}/")

    def upload(self, filename: str, content: bytes, mime: str = "image/jpeg") -> dict:
        boundary = secrets.token_hex(16)
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
                f"Content-Type: {mime}\r\n\r\n").encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
        return self.call("POST", "/api/user-files/upload-file/", raw=body,
                         content_type=f"multipart/form-data; boundary={boundary}")


def _http_error(exc: urllib.error.HTTPError, url: str) -> BaserowError:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:
        payload = None
    if payload is None and exc.code == 400:
        host = urllib.parse.urlsplit(url).hostname
        return AddressError(
            f"Baserow nimmt Anfragen an „{host}“ nicht an. Nutze dieselbe Adresse wie im Browser (BASEROW_PUBLIC_URL) "
            f"oder trage {host} in Baserow unter BASEROW_EXTRA_ALLOWED_HOSTS ein.")
    payload = payload or {}
    code = payload.get("error", "") if isinstance(payload, dict) else ""
    detail = payload.get("detail", "") if isinstance(payload, dict) else ""
    if code == "ERROR_ROW_DOES_NOT_EXIST":
        ids = [int(x) for x in re.findall(r"\d+", str(detail))]
        return RowsMissing(ids)
    if exc.code == 401 or code in ("ERROR_INVALID_ACCESS_TOKEN", "ERROR_NO_PERMISSION_TO_TABLE",
                                   "ERROR_TOKEN_DOES_NOT_EXIST"):
        return BaserowError("Baserow lehnt den Zugang ab. Stimmen Token bzw. E-Mail und Passwort, "
                            "und darf der Token in diese Tabellen schreiben?")
    if exc.code == 404 and not code:
        return AddressError(f"Unter {url} gibt es keine Baserow-Schnittstelle (404). Stimmt die Adresse?")
    if code == "ERROR_TABLE_DOES_NOT_EXIST":
        return BaserowError("Eine der Tabellen gibt es in Baserow nicht (mehr)")
    if code == "ERROR_REQUEST_BODY_VALIDATION":
        return BaserowError(f"Baserow hat die Daten abgelehnt: {_short(detail)}")
    text = _short(detail) if detail else exc.reason
    return BaserowError(f"Baserow meldet {exc.code}: {code or ''} {text}".strip())


def _short(detail) -> str:
    text = json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail
    return text if len(text) < 400 else text[:400] + " …"


# ---------------------------------------------------------------- Einstellungen

def _get_settings(conn) -> dict:
    return {r["key"]: r["value"] for r in db.rows(
        conn, f"SELECT key, value FROM settings WHERE key IN ({','.join('?' for _ in KEYS)})", KEYS)}


def _set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def _loads(raw, default=None):
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def load_config() -> Optional[dict]:
    with db.session() as conn:
        s = _get_settings(conn)
    cfg = _loads(s.get("baserow_config"))
    if not (s.get("baserow_url") and s.get("baserow_token") and cfg):
        return None
    return {"url": s["baserow_url"], "token": s["baserow_token"], **cfg}


def _save_state(**changes) -> None:
    with db.session() as conn:
        state = _loads(_get_settings(conn).get("baserow_state"), {}) or {}
        state.update(changes)
        _set(conn, "baserow_state", json.dumps(state, ensure_ascii=False))


def status() -> dict:
    with db.session() as conn:
        s = _get_settings(conn)
        pending = conn.execute(
            "SELECT COUNT(*) FROM observations WHERE baserow_id IS NULL OR synced_at IS NULL OR synced_at < updated_at"
        ).fetchone()[0]
    cfg = _loads(s.get("baserow_config"), {}) or {}
    state = _loads(s.get("baserow_state"), {}) or {}
    connected = bool(s.get("baserow_url") and s.get("baserow_token") and cfg)
    return {
        "connected": connected,
        "url": s.get("baserow_url") or "",
        "database": cfg.get("database", ""),
        "tables": {k: cfg.get("tables", {}).get(k) for k in ORDER if cfg.get("tables", {}).get(k)} if connected else {},
        "missing": [TABLES[k]["name"] for k in EXTRA if not cfg.get("tables", {}).get(k)] if connected else [],
        "links": {k: v for k, v in (cfg.get("links") or {}).items()} if connected else {},
        "auto": DELAY > 0,
        "pending": pending if connected else 0,
        "last_sync": state.get("last_sync"),
        "last_error": state.get("last_error"),
        "last_result": state.get("last_result"),
        "missing_fields": state.get("missing_fields") or {},
        "running": _lock.locked(),
        "spec": spec(),
    }


FIELD_TEXT = {"text": "Einzeiliger Text", "long_text": "Langer Text", "number": "Zahl", "date": "Datum",
              "boolean": "Boolescher Wert", "file": "Datei", "link_row": "Verknüpfung"}


def spec() -> list[dict]:
    """Tabellen und Felder zum Nachbauen von Hand (für die Oberfläche und die Anleitung)."""
    out = []
    for kind in ORDER:
        t = TABLES[kind]
        fields = [{"name": t["primary"], "type": "Einzeiliger Text (erstes Feld)"}]
        for name, f in t["fields"]:
            label = FIELD_TEXT[f["type"]]
            if f["type"] == "link_row":
                label += f" zu „{TABLES[f['to']]['name']}“"
            if f["type"] == "number":
                label += f", {f['number_decimal_places']} Nachkommastellen"
                if f.get("number_negative"):
                    label += ", negativ erlaubt"
            fields.append({"name": name, "type": label})
        if kind == "plants":
            fields.append({"name": SORT_FIELD[0], "type": f"Verknüpfung zu „{TABLES['varieties']['name']}“ (wenn vorhanden)"})
        out.append({"kind": kind, "name": t["name"], "fields": fields})
    return out


def _reset_local(conn, kinds=ORDER) -> None:
    """Neue Tabellen: Zuordnungen zu Baserow-Zeilen vergessen (nur für die genannten Tabellen)."""
    for kind in kinds:
        extra = ", baserow_file = '', baserow_photo = ''" if kind in ("observations", "varieties") else ""
        extra += ", synced_at = NULL" if kind == "observations" else ""
        conn.execute(f"UPDATE {kind} SET baserow_id = NULL, bw_hash = ''{extra}")
        conn.execute("DELETE FROM baserow_deleted WHERE kind = ?", (kind,))


def disconnect() -> None:
    with db.session() as conn:
        for key in KEYS:
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        _reset_local(conn)


# ---------------------------------------------------------------- Einrichten

def login(url: str, email: str, password: str) -> Client:
    if not email or not password:
        raise BaserowError("E-Mail und Passwort für Baserow angeben")
    anon = Client(url)
    try:
        res = anon.call("POST", "/api/user/token-auth/", {"email": email.strip(), "password": password})
    except AddressError:
        raise
    except BaserowError as exc:
        raise BaserowError("Baserow kennt diese E-Mail-Adresse mit diesem Passwort nicht") from exc
    if res and res.get("two_factor_auth"):
        raise BaserowError("Für dieses Baserow-Konto ist die Zwei-Faktor-Anmeldung aktiv. Lege die Tabellen "
                           "dann bitte selbst an und verbinde Beetwerk mit Token und Tabellen-IDs.")
    jwt = (res or {}).get("access_token") or (res or {}).get("token")
    if not jwt:
        raise BaserowError("Baserow hat keine Anmeldung zurückgegeben")
    return Client(url, jwt=jwt)


def _workspace_of(app: dict) -> dict:
    return app.get("workspace") or app.get("group") or {}


def databases(url: str, email: str, password: str) -> list[dict]:
    """Datenbanken des Kontos mit ihren Tabellen, für die Auswahl beim Einrichten."""
    client = login(url, email, password)
    apps = client.call("GET", "/api/applications/") or []
    out = []
    for a in apps:
        if a.get("type") != "database":
            continue
        ws = _workspace_of(a)
        out.append({"id": a["id"], "name": a.get("name", ""), "workspace": ws.get("name", ""),
                    "tables": [{"id": t["id"], "name": t.get("name", "")} for t in a.get("tables") or []]})
    if not out:
        raise BaserowError("In diesem Baserow-Konto gibt es noch keine Datenbank. Lege zuerst eine an.")
    return out


def _field_body(name: str, spec: dict, tables: dict) -> dict:
    body = {"name": name, **{k: v for k, v in spec.items() if k != "to"}}
    if spec["type"] == "link_row":
        body["link_row_table_id"] = tables[spec["to"]]
        body["has_related_field"] = True
    return body


def setup(url: str, email: str, password: str, database_id: int,
          variety_table: Optional[int] = None, label_table: Optional[int] = None) -> dict:
    """Tabellen und Felder anlegen (oder ergänzen), Datenbank-Token anlegen, Verbindung speichern."""
    client = login(url, email, password)
    apps = client.call("GET", "/api/applications/") or []
    app = next((a for a in apps if a.get("id") == database_id and a.get("type") == "database"), None)
    if app is None:
        raise BaserowError("Diese Datenbank gibt es in Baserow nicht")
    ws = _workspace_of(app)
    existing = {t.get("name"): t["id"] for t in app.get("tables") or []}
    ids_in_db = {t["id"] for t in app.get("tables") or []}
    for extra in (variety_table, label_table):
        if extra and extra not in ids_in_db:
            raise BaserowError("Sorten- und Etikettentabelle müssen in derselben Datenbank liegen")

    tables: dict[str, int] = {}
    for kind in ORDER:
        spec = TABLES[kind]
        if spec["name"] in existing:
            tables[kind] = existing[spec["name"]]
        else:
            t = client.call("POST", f"/api/database/tables/database/{database_id}/",
                            {"name": spec["name"], "data": [[spec["primary"]]], "first_row_header": True})
            tables[kind] = t["id"]
    for kind in ORDER:
        spec = TABLES[kind]
        have = {f["name"]: f for f in client.fields(tables[kind])}
        wanted = list(spec["fields"])
        if kind == "plants":
            wanted.append(SORT_FIELD)
        if kind in ("plants", "observations") and variety_table:
            wanted.append((VARIETY_FIELD, {"type": "link_row", "to": "variety"}))
        if kind == "plants" and label_table:
            wanted.append((LABEL_FIELD, {"type": "link_row", "to": "label"}))
        for name, fspec in wanted:
            if name in have:
                continue
            body = _field_body(name, fspec, {**tables, "variety": variety_table, "label": label_table})
            if fspec.get("to") in ("variety", "label"):
                body["has_related_field"] = False  # vorhandene Tabellen nicht verändern
            client.call("POST", f"/api/database/fields/table/{tables[kind]}/", body)

    key = _reusable_token(client.url, tables)
    if not key:
        token = client.call("POST", "/api/database/tokens/", {"name": "Beetwerk", "workspace": ws.get("id"),
                                                              "group": ws.get("id")})
        key = (token or {}).get("key")
    if not key:
        raise BaserowError("Baserow hat keinen Datenbank-Token angelegt")
    cfg = {"database": app.get("name", ""), "tables": tables, "sort_link": True,
           "links": {"variety": variety_table, "label": label_table}}
    _store(client.url, key, cfg)
    return status()


def _reusable_token(url: str, tables: dict) -> Optional[str]:
    """Beim erneuten Einrichten den vorhandenen Token behalten, wenn er alle Tabellen erreicht."""
    with db.session() as conn:
        s = _get_settings(conn)
    if s.get("baserow_url") != url or not s.get("baserow_token"):
        return None
    try:
        reach = Client(url, token=s["baserow_token"]).call("GET", "/api/database/tables/all-tables/") or []
    except BaserowError:
        return None
    ids = {t.get("id") for t in reach}
    return s["baserow_token"] if set(tables.values()) <= ids else None


def check_tables(client: Client, tables: dict) -> dict:
    """Prüft vorhandene Tabellen auf alle Felder; liefert gefundene Verknüpfungen zurück."""
    links: dict[str, Optional[int]] = {"variety": None, "label": None, "sort_link": False}
    problems = []
    for kind in ORDER:
        if kind not in tables:
            continue
        spec = TABLES[kind]
        fields = client.fields(tables[kind])
        by_name = {f["name"]: f for f in fields}
        primary = next((f for f in fields if f.get("primary")), None)
        missing = []
        if not primary or primary["name"] != spec["primary"] or primary["type"] not in TEXTLIKE:
            missing.append(f"{spec['primary']} (erstes Feld, Text)")
        for name, fspec in spec["fields"]:
            f = by_name.get(name)
            want = fspec["type"]
            ok = f is not None and (f["type"] == want or (want in TEXTLIKE and f["type"] in TEXTLIKE))
            if ok and want == "link_row":
                target = tables[fspec["to"]]
                ok = f.get("link_row_table_id", f.get("link_row_table")) == target
            if not ok:
                missing.append(name)
        if missing:
            problems.append(f"„{spec['name']}“: {', '.join(missing)}")
        for fname, key in ((VARIETY_FIELD, "variety"), (LABEL_FIELD, "label")):
            f = by_name.get(fname)
            if f and f["type"] == "link_row":
                links[key] = f.get("link_row_table_id", f.get("link_row_table"))
        f = by_name.get(SORT_FIELD[0])
        if kind == "plants" and f and f["type"] == "link_row" and \
                f.get("link_row_table_id", f.get("link_row_table")) == tables.get("varieties"):
            links["sort_link"] = True
    if problems:
        raise BaserowError("Es fehlen Felder oder sie haben den falschen Typ – " + "; ".join(problems))
    return links


def connect(url: str, token: str, tables: dict) -> dict:
    """Mit selbst angelegten Tabellen verbinden: Token und Tabellen-IDs."""
    if not token:
        raise BaserowError("Bitte den Datenbank-Token angeben")
    client = Client(url, token=token)
    tables = {k: int(v) for k, v in tables.items() if v}
    if any(k not in tables for k in BASE):
        raise BaserowError("Bitte die IDs der drei Bonitur-Tabellen angeben")
    if "plantings" in tables and not {"crops", "varieties"} <= set(tables):
        raise BaserowError("Für „Sätze“ braucht es auch die Tabellen „Kulturen“ und „Beetwerk-Sorten“")
    if "varieties" in tables and "crops" not in tables:
        raise BaserowError("Für „Beetwerk-Sorten“ braucht es auch die Tabelle „Kulturen“")
    links = check_tables(client, tables)
    for kind in tables:  # darf der Token lesen?
        client.call("GET", f"/api/database/rows/table/{tables[kind]}/", params={"size": 1})
    sort_link = links.pop("sort_link")
    _store(client.url, token, {"database": "", "tables": tables, "links": links, "sort_link": sort_link})
    return status()


def _store(url: str, token: str, cfg: dict) -> None:
    with db.session() as conn:
        before = _loads(_get_settings(conn).get("baserow_config"), {}) or {}
        old = before.get("tables") or {}
        changed = [k for k in ORDER if old.get(k) != cfg["tables"].get(k)]
        if changed:
            _reset_local(conn, changed)
        # Beim ersten Abgleich vorhandene Zeilen über die Beetwerk-ID übernehmen statt doppelt anzulegen
        pending = set(before.get("adopt") or []) | set(changed)
        cfg["adopt"] = [k for k in ORDER if k in pending and cfg["tables"].get(k)]
        _set(conn, "baserow_url", url)
        _set(conn, "baserow_token", token)
        _set(conn, "baserow_config", json.dumps(cfg))
        _set(conn, "baserow_state", json.dumps({}))


# ---------------------------------------------------------------- Inhalte

GROUP_TEXT = {"all": "alle", "tomato": "Tomate", "pepper": "Paprika und Chili"}


def _options_text(t: dict) -> str:
    opts = bonitur._loads(t.get("options"), None)
    if isinstance(opts, list):
        return "\n".join(str(o) for o in opts)
    if isinstance(opts, dict):
        return "\n".join(f"{k} = {v}" for k, v in sorted(opts.items(), key=lambda kv: float(kv[0])))
    return ""


def trait_title(t: dict) -> str:
    return t["name"] if t["grp"] == "all" else f"{t['name']} ({GROUP_TEXT.get(t['grp'], t['grp'])})"


def trait_payload(t: dict) -> dict:
    return {
        "Merkmal": trait_title(t), "Schlüssel": t["key"], "Kultur": GROUP_TEXT.get(t["grp"], t["grp"]),
        "Bereich": bonitur.SECTION_TEXT.get(t["section"], t["section"]),
        "Häufigkeit": bonitur.FREQ_TEXT.get(t["freq"], t["freq"]),
        "Ebene": bonitur.LEVEL_TEXT.get(t["level"], t["level"]),
        "Werttyp": bonitur.TYPE_TEXT.get(t["type"], t["type"]), "Auswahlwerte": _options_text(t),
        "Einheit": t["unit"], "Zeitpunkt": t["stage"], "Hinweis": t["hint"], "Vorlage": t["ref"],
        "Aktiv": bool(t["active"]), "Beetwerk-ID": t["id"],
    }


def _planting_info(conn) -> dict[int, dict]:
    out = {}
    for p in db.rows(conn, """SELECT p.id, p.crop_id, p.variety, p.varieties, p.sow_date, p.plant_date, c.name AS crop,
                                     b.name AS bed FROM plantings p JOIN crops c ON c.id = p.crop_id
                              LEFT JOIN beds b ON b.id = p.bed_id"""):
        start = p["plant_date"] or p["sow_date"]
        refs = {v.get("name"): v.get("ref") for v in (bonitur._loads(p["varieties"], []) or []) if v.get("ref")}
        out[p["id"]] = {
            "crop": p["crop"], "crop_id": p["crop_id"], "bed": p["bed"] or "ohne Beet", "year": int(start[:4]), "refs": refs,
            "satz": f"{p['crop']}, {p['bed'] or 'ohne Beet'}, {start[:4]} (Satz {p['id']})",
        }
    return out


def plant_title(pl: dict, info: dict) -> str:
    return pl["label"] or f"{info['year']} {info['crop']} {info['bed']} Nr. {pl['num']}"


class Lookup:
    """Hauptfeld einer vorhandenen Baserow-Tabelle (Sorten, Etiketten) → Zeilen-ID."""

    def __init__(self, client: Client, table_id: Optional[int]):
        self.ids: set[int] = set()
        self.by_name: dict[str, int] = {}
        if not table_id:
            return
        fields = client.fields(table_id)
        primary = next((f["name"] for f in fields if f.get("primary")), None)
        for row in client.rows(table_id):
            self.ids.add(row["id"])
            value = row.get(primary)
            if isinstance(value, list):  # z. B. Formel oder Verknüpfung als Hauptfeld
                value = " ".join(str(v.get("value", v)) if isinstance(v, dict) else str(v) for v in value)
            if value not in (None, ""):
                self.by_name.setdefault(str(value).strip().lower(), row["id"])

    def find(self, *candidates) -> list[int]:
        for c in candidates:
            if c is None or c == "":
                continue
            s = str(c).strip()
            if s.isdigit() and int(s) in self.ids:
                return [int(s)]
            hit = self.by_name.get(s.lower())
            if hit:
                return [hit]
        return []


def plant_payload(pl: dict, info: dict, cfg: dict, lookups: dict, sort_bid: Optional[int] = None) -> dict:
    out = {
        "Pflanze": plant_title(pl, info), "Etikett": pl["label"], "Jahr": info["year"], "Kultur": info["crop"],
        "Sorte": pl["variety"], "Beet": info["bed"], "Satz": info["satz"], "Nr": pl["num"], "Reihe": pl["row"],
        "Platz": pl["place"], "Status": "ausgefallen" if pl["status"] == "gone" else "aktiv", "Notiz": pl["note"],
        "Beetwerk-ID": pl["id"],
    }
    links = cfg.get("links") or {}
    if links.get("variety"):
        out[VARIETY_FIELD] = lookups["variety"].find(pl["variety_ref"], info["refs"].get(pl["variety"]), pl["variety"])
    if links.get("label"):
        out[LABEL_FIELD] = lookups["label"].find(pl["label"])
    if cfg.get("sort_link") and cfg["tables"].get("varieties"):
        out[SORT_FIELD[0]] = [sort_bid] if sort_bid else []
    return out


METHOD_TEXT = {"direct": "Direktsaat", "transplant": "Anzucht und Pflanzung"}


def crop_payload(c: dict) -> dict:
    return {
        "Kultur": c["name"], "Familie": c["family"], "Anbauart": METHOD_TEXT.get(c["method"], c["method"]),
        "Anzucht (Tage)": c["nursery_days"], "Bis Ernte (Tage)": c["field_days"],
        "Erntedauer (Tage)": c["harvest_days"], "Reihenabstand (cm)": c["row_spacing"],
        "Pflanzabstand (cm)": c["plant_spacing"],
        "Bonitur-Merkmale": GROUP_TEXT.get(c.get("trait_group") or "all", "") if c.get("trait_group") else "allgemein",
        "Farbe": c["color"], "Notizen": c["notes"], "Beetwerk-ID": c["id"],
    }


def _links_text(raw) -> str:
    links = bonitur._loads(raw, []) or []
    return "\n".join(f"{x.get('title') or x.get('url')} – {x.get('url')}" if x.get("title") else x.get("url", "")
                     for x in links if isinstance(x, dict))


def variety_payload(v: dict, crop_bid: Optional[int], rows: list[dict]) -> dict:
    """rows: Sortenprofil (profile.rows_for); Bonitur geht vor Recherche und eigener Angabe."""
    by = {r["key"]: r for r in rows if r["text"]}

    def text(*keys):
        return next((by[k]["text"] for k in keys if k in by), "")

    def number(*keys, digits=1):
        for k in keys:
            if k in by and isinstance(by[k]["value"], (int, float)):
                return round(float(by[k]["value"]), digits) if digits else int(round(by[k]["value"]))
        return None

    lines = []
    for r in rows:
        if not r["text"]:
            continue
        b = r.get("bonitur")
        origin = f"Bonitur {b['year']}" + (f", n={b['n']}" if b.get("n", 1) > 1 else "") if b else \
            ("Internet" if r["source"] == "internet" else "eigene Angabe")
        lines.append(f"{r['name']}: {r['text']} ({origin})")
    return {
        "Sorte": v["name"], "Kultur": [crop_bid] if crop_bid else [], "Botanische Art": v["species"], "Typ": v["kind"],
        "Saatgut": v["seed"], "Wuchs": text("tom_growth", "pep_habit"), "Fruchtfarbe": text("tom_fruit_color", "pep_fruit_color"),
        "Reife": text("maturity_class"), "Bezugsquelle": v["supplier"], "Gekauft": v["bought"],
        "Beschreibung": v["description"], "Bildquelle": v["photo_credit"], "Quellen": _links_text(v["links"]),
        "Notizen": v["notes"], "Beetwerk-ID": v["id"],
        "Pflanzengröße": text("plant_size"), "Pflanzenhöhe (cm)": number("height"), "Fruchtgröße": text("fruit_size"),
        "Fruchtgewicht (g)": number("tom_fruit_weight", "pep_fruit_weight"),
        "Tage bis Reife": number("days_to_maturity", digits=0), "Schärfe (SHU)": number("pep_scoville", digits=0),
        "Merkmale": "\n".join(lines),
    }


def plant_count(p: dict, crop: dict, bed: Optional[dict]) -> int:
    """Wie util.js plantLayout: Reihen laufen immer in Beetrichtung, also entlang der langen Beetseite
    (ohne Beet entlang der Länge des Satzes); gezählt werden Reihen mal Plätze je Reihe."""
    if p.get("varieties"):
        mixed = bonitur._loads(p["varieties"], []) or []
        if mixed:
            return sum(int(v.get("count") or 0) for v in mixed)
    usual = methods.for_method(crop, p.get("method"))  # Abstände der Anbauart dieses Satzes
    row_sp = p["row_spacing"] or usual["row_spacing"] or 30
    plant_sp = p["plant_spacing"] or usual["plant_spacing"] or 30
    span = p["span"] if p["span"] is not None else (max(0.05, bed["width"] - (p["offset"] or 0)) if bed else 1)
    crosswise = bed is not None and bed["length"] < bed["width"]  # Beet breiter als lang: Reihen entlang der Breite
    long_m, short_m = (span, p["len"]) if crosswise else (p["len"], span)
    rows = p["rows"] or max(1, int((short_m * 100 + 0.5) // row_sp))
    per_row = max(1, int((long_m * 100 + 0.5) // plant_sp))
    return rows * per_row


def planting_payload(p: dict, crop: dict, bed: Optional[dict], crop_bid: Optional[int], variety_bids: list[int]) -> dict:
    mixed = bonitur._loads(p["varieties"], []) or []
    names = ", ".join(f"{v.get('name')} ({v.get('count')})" for v in mixed) if mixed else p["variety"]
    start = p["plant_date"] or p["sow_date"]
    span = p["span"] if p["span"] is not None else (max(0.05, bed["width"] - (p["offset"] or 0)) if bed else 1)
    title = f"{crop['name']}{' ' + (p['variety'] if not mixed else f'{len(mixed)} Sorten') if (p['variety'] or mixed) else ''}"
    return {
        "Satz": f"{title}, {bed['name'] if bed else 'ohne Beet'}, {start[:4]}", "Kultur": [crop_bid] if crop_bid else [],
        "Sorten": variety_bids, "Sorten (Text)": names, "Beet": bed["name"] if bed else "",
        "Anbau": METHOD_TEXT.get(p["method"], p["method"]), "Jahr": int(start[:4]), "Aussaat": p["sow_date"],
        "Pflanzung": p["plant_date"], "Ernte ab": p["harvest_start"], "Ernte bis": p["harvest_end"],
        "Pflanzen": plant_count(p, crop, bed), "Fläche (m²)": round(p["len"] * span, 2), "Notizen": p["notes"],
        "Beetwerk-ID": p["id"],
    }


def _num_text(n: float) -> str:
    return f"{n:g}".replace(".", ",")


def obs_payload(o: dict, t: dict, plant: Optional[dict], plant_bid: Optional[int], trait_bid: int,
                info: dict, cfg: dict, lookups: dict) -> dict:
    value = bonitur._loads(o["value"])
    text, number = bonitur.value_text(t, value)
    unit = (value or {}).get("unit", "") if t["type"] == "amount" and isinstance(value, dict) else t["unit"]
    parts = bonitur._loads(o["parts"], []) or []
    target = plant_title(plant, info) if plant else f"Sorte {o['variety'] or info['crop']}"
    out = {
        "Eintrag": f"{o['date']} · {target} · {t['name']}", "Datum": o["date"],
        "Pflanze": [plant_bid] if plant_bid else [], "Merkmal": [trait_bid], "Sorte": o["variety"],
        "Satz": info["satz"], "Ebene": "Pflanze" if plant else "Sorte", "Wert": text,
        "Zahl": round(number, 3) if number is not None else None, "Einheit": unit,
        "Einzelwerte": "; ".join(_num_text(p) for p in parts), "Notiz": o["note"], "Beetwerk-ID": o["id"],
        "Geändert": o["updated_at"],
    }
    if (cfg.get("links") or {}).get("variety"):
        ref = (plant or {}).get("variety_ref") or info["refs"].get(o["variety"])
        out[VARIETY_FIELD] = lookups["variety"].find(ref, o["variety"])
    return out


def _hash(payload: dict, extra: str = "") -> str:
    return hashlib.sha1((json.dumps(payload, sort_keys=True, ensure_ascii=False) + extra).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- Abgleich

_lock = threading.Lock()


def _write(client: Client, table_id: int, local: str, items: list[tuple[dict, dict, str]], result: dict,
           extra_cols=None) -> None:
    """items: (lokaler Datensatz, Inhalt für Baserow, Prüfsumme). Legt an oder ändert, merkt sich die IDs."""
    creates = [x for x in items if not x[0].get("baserow_id")]
    updates = [x for x in items if x[0].get("baserow_id")]
    now = _now()

    def remember(done):
        """done: Liste aus (Datensatz, Baserow-ID, Prüfsumme), in einem Rutsch speichern."""
        with db.session() as conn:
            for rec, bid, h in done:
                cols = {"baserow_id": bid, "bw_hash": h, **((extra_cols or (lambda r: {}))(rec))}
                if local == "observations":
                    cols["synced_at"] = now
                conn.execute(f"UPDATE {local} SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?",
                             [*cols.values(), rec["id"]])

    for i in range(0, len(updates), BATCH):
        chunk = updates[i:i + BATCH]
        try:
            client.call("PATCH", f"/api/database/rows/table/{table_id}/batch/",
                        {"items": [{"id": rec["baserow_id"], **payload} for rec, payload, _ in chunk]},
                        params={"user_field_names": "true"})
        except RowsMissing as exc:
            # In Baserow gelöscht: neu anlegen, den Rest noch einmal ändern
            gone = set(exc.ids)
            if not gone:
                raise
            again = []
            for rec, payload, h in chunk:
                if rec["baserow_id"] in gone:
                    rec["baserow_id"] = None
                    creates.append((rec, payload, h))
                else:
                    again.append((rec, payload, h))
            if again:
                client.call("PATCH", f"/api/database/rows/table/{table_id}/batch/",
                            {"items": [{"id": rec["baserow_id"], **payload} for rec, payload, _ in again]},
                            params={"user_field_names": "true"})
            chunk = again
        remember([(rec, rec["baserow_id"], h) for rec, _, h in chunk])
        result["updated"] += len(chunk)
    for i in range(0, len(creates), BATCH):
        chunk = creates[i:i + BATCH]
        res = client.call("POST", f"/api/database/rows/table/{table_id}/batch/",
                          {"items": [payload for _, payload, _ in chunk]}, params={"user_field_names": "true"})
        rows = (res or {}).get("items") or []
        if len(rows) != len(chunk):
            raise BaserowError("Baserow hat nicht alle Zeilen angelegt")
        for (rec, _, _h), row in zip(chunk, rows):
            rec["baserow_id"] = row["id"]
        remember([(rec, rec["baserow_id"], h) for rec, _, h in chunk])
        result["created"] += len(chunk)


def sync() -> dict:
    """Alles Neue und Geänderte nach Baserow schreiben. Gibt Zähler zurück."""
    if not _lock.acquire(blocking=False):
        raise BaserowError("Der Abgleich läuft gerade schon")
    try:
        cfg = load_config()
        if not cfg:
            raise BaserowError("Beetwerk ist nicht mit Baserow verbunden")
        result = {"created": 0, "updated": 0, "deleted": 0, "photos": 0}
        try:
            _run(Client(cfg["url"], token=cfg["token"]), cfg, result)
        except BaserowError as exc:
            _save_state(last_error=str(exc), last_try=_now(), last_result=result)
            raise
        _save_state(last_sync=_now(), last_error=None, last_result=result, missing_fields=result.pop("_missing", {}))
        return result
    finally:
        _lock.release()


def _adopt(client: Client, cfg: dict) -> None:
    """Zeilen, die schon in Baserow stehen (gleiche Beetwerk-ID), wieder zuordnen."""
    for kind in cfg.get("adopt") or []:
        table_id = cfg["tables"].get(kind)
        if not table_id:
            continue
        found = {}
        for row in client.rows(table_id):
            bid = row.get("Beetwerk-ID")
            try:
                found.setdefault(int(float(bid)), row["id"])
            except (TypeError, ValueError):
                continue
        if found:
            with db.session() as conn:
                conn.executemany(f"UPDATE {kind} SET baserow_id = ?, bw_hash = '' WHERE id = ? AND baserow_id IS NULL",
                                 [(rid, lid) for lid, rid in found.items()])
    if cfg.get("adopt"):
        with db.session() as conn:
            stored = _loads(_get_settings(conn).get("baserow_config"), {}) or {}
            stored.pop("adopt", None)
            _set(conn, "baserow_config", json.dumps(stored))


def _run(client: Client, cfg: dict, result: dict) -> None:
    _adopt(client, cfg)
    tables = cfg["tables"]
    links = cfg.get("links") or {}
    present: dict[str, set] = {}
    missing: dict[str, list] = {}

    def keep(kind: str, payload: dict) -> dict:
        """Felder weglassen, die es in Baserow (noch) nicht gibt, z. B. nach einem Update von Beetwerk."""
        if kind not in present:
            present[kind] = {f["name"] for f in client.fields(tables[kind])}
        gone = [k for k in payload if k not in present[kind]]
        if gone:
            name = TABLES[kind]["name"]
            missing[name] = sorted(set(missing.get(name, [])) | set(gone))
        return {k: v for k, v in payload.items() if k in present[kind]}

    with db.session() as conn:
        bon = profile.bonitur_profiles(conn)
        groups = {c["id"]: c["trait_group"] or "" for c in db.rows(conn, "SELECT id, trait_group FROM crops")}
        ptraits = {g: profile.profile_traits(conn, g) for g in set(groups.values()) | {""}}
        vrows = {v["id"]: profile.rows_for(conn, v, bon.get(v["id"], {}), ptraits[groups.get(v["crop_id"], "")])
                 for v in db.rows(conn, "SELECT * FROM varieties")}
    with db.session() as conn:
        crops = db.rows(conn, "SELECT * FROM crops ORDER BY name")
        varieties = db.rows(conn, "SELECT * FROM varieties ORDER BY name")
        plantings = db.rows(conn, "SELECT * FROM plantings ORDER BY sow_date, id")
        beds = {b["id"]: b for b in db.rows(conn, "SELECT * FROM beds")}
        traits = db.rows(conn, "SELECT * FROM traits ORDER BY sort, id")
        plants = db.rows(conn, "SELECT * FROM plants ORDER BY planting_id, num")
        obs = db.rows(conn, "SELECT * FROM observations ORDER BY date, id")
        info = _planting_info(conn)
        deleted = db.rows(conn, "SELECT rowid AS rid, kind, row_id FROM baserow_deleted")
    lookups = {"variety": Lookup(client, links.get("variety") if (plants or obs) else None),
               "label": Lookup(client, links.get("label") if plants else None)}

    # 0. Kulturen, Sortenliste und Sätze (wenn die Tabellen eingerichtet sind)
    crop_by_id = {c["id"]: c for c in crops}
    if tables.get("crops"):
        items = []
        for c in crops:
            payload = keep("crops", crop_payload(c))
            h = _hash(payload)
            if not c["baserow_id"] or c["bw_hash"] != h:
                items.append((c, payload, h))
        _write(client, tables["crops"], "crops", items, result)
    crop_bid = {c["id"]: c["baserow_id"] for c in crops}
    variety_key = {(v["crop_id"], v["name"].strip().lower()): v for v in varieties}
    if tables.get("varieties"):
        items = []
        for v in varieties:
            payload = keep("varieties", variety_payload(v, crop_bid.get(v["crop_id"]), vrows.get(v["id"], [])))
            h = _hash(payload, extra=v["photo"])
            if v["baserow_id"] and v["bw_hash"] == h and v["photo"] == v["baserow_photo"]:
                continue
            if "Foto" in present["varieties"]:
                _upload_photo(client, "varieties", v, f"sorte-{v['id']}.jpg", result)
                payload["Foto"] = [{"name": v["baserow_file"]}] if v["photo"] and v["baserow_file"] else []
            items.append((v, payload, h))
        _write(client, tables["varieties"], "varieties", items, result, extra_cols=_photo_cols)
    if tables.get("plantings"):
        items = []
        for pt in plantings:
            crop = crop_by_id.get(pt["crop_id"])
            if not crop:
                continue
            mixed = bonitur._loads(pt["varieties"], []) or []
            names = [x.get("name", "") for x in mixed] if mixed else ([pt["variety"]] if pt["variety"] else [])
            vbids = [variety_key[(pt["crop_id"], n.strip().lower())]["baserow_id"] for n in names
                     if (pt["crop_id"], n.strip().lower()) in variety_key
                     and variety_key[(pt["crop_id"], n.strip().lower())]["baserow_id"]]
            payload = keep("plantings", planting_payload(pt, crop, beds.get(pt["bed_id"]), crop_bid.get(pt["crop_id"]),
                                                         list(dict.fromkeys(vbids))))
            h = _hash(payload)
            if not pt["baserow_id"] or pt["bw_hash"] != h:
                items.append((pt, payload, h))
        _write(client, tables["plantings"], "plantings", items, result)

    # 1. Merkmale
    items = []
    for t in traits:
        payload = keep("traits", trait_payload(t))
        h = _hash(payload)
        if not t["baserow_id"] or t["bw_hash"] != h:
            items.append((t, payload, h))
    _write(client, tables["traits"], "traits", items, result)
    trait_bid = {t["id"]: t["baserow_id"] for t in traits}

    # 2. Pflanzen
    items = []
    for pl in plants:
        if pl["planting_id"] not in info:
            continue
        pinfo = info[pl["planting_id"]]
        sort = variety_key.get((pinfo["crop_id"], (pl["variety"] or "").strip().lower()))
        payload = keep("plants", plant_payload(pl, pinfo, cfg, lookups, sort["baserow_id"] if sort else None))
        h = _hash(payload)
        if not pl["baserow_id"] or pl["bw_hash"] != h:
            items.append((pl, payload, h))
    _write(client, tables["plants"], "plants", items, result)
    plant_by_id = {pl["id"]: pl for pl in plants}

    # 3. Werte, Fotos vorher hochladen
    trait_by_id = {t["id"]: t for t in traits}
    items = []
    for o in obs:
        t = trait_by_id.get(o["trait_id"])
        if not t or o["planting_id"] not in info:
            continue
        plant = plant_by_id.get(o["plant_id"]) if o["plant_id"] else None
        if o["plant_id"] and (not plant or not plant.get("baserow_id")):
            continue
        payload = keep("observations", obs_payload(o, t, plant, plant["baserow_id"] if plant else None,
                                                   trait_bid[t["id"]], info[o["planting_id"]], cfg, lookups))
        h = _hash(payload, extra=o["photo"])
        if o["baserow_id"] and o["bw_hash"] == h and o["photo"] == o["baserow_photo"]:
            continue
        if "Foto" in present["observations"]:
            _upload_photo(client, "observations", o, f"bonitur-{o['date']}-{o['id']}.jpg", result)
            payload["Foto"] = [{"name": o["baserow_file"]}] if o["photo"] and o["baserow_file"] else []
        items.append((o, payload, h))
    _write(client, tables["observations"], "observations", items, result, extra_cols=_photo_cols)

    result["_missing"] = missing

    # 4. In Beetwerk Gelöschtes auch in Baserow löschen (Werte zuerst, Kulturen zuletzt)
    for kind in reversed(ORDER):
        rows = [d for d in deleted if d["kind"] == kind]
        if rows and not tables.get(kind):
            with db.session() as conn:
                conn.execute("DELETE FROM baserow_deleted WHERE kind = ?", (kind,))
            continue
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            ids = [d["row_id"] for d in chunk]
            try:
                client.call("POST", f"/api/database/rows/table/{tables[kind]}/batch-delete/", {"items": ids})
            except RowsMissing as exc:
                rest = [x for x in ids if x not in set(exc.ids)]
                if rest:
                    client.call("POST", f"/api/database/rows/table/{tables[kind]}/batch-delete/", {"items": rest})
            with db.session() as conn:
                conn.executemany("DELETE FROM baserow_deleted WHERE rowid = ?", [(d["rid"],) for d in chunk])
            result["deleted"] += len(chunk)


def _photo_cols(rec: dict) -> dict:
    return {"baserow_file": rec.get("baserow_file", ""), "baserow_photo": rec.get("baserow_photo", "")}


def _upload_photo(client: Client, table: str, rec: dict, filename: str, result: dict) -> None:
    """Eigenes Foto einmal nach Baserow hochladen; merkt sich, welches dort liegt."""
    if not rec["photo"]:
        rec["baserow_file"] = rec["baserow_photo"] = ""
        return
    if rec["photo"] == rec["baserow_photo"]:
        return
    path = bonitur.PHOTO_DIR / f"{rec['photo']}.jpg"
    if not path.exists():
        return
    up = client.upload(filename, path.read_bytes())
    rec["baserow_file"], rec["baserow_photo"] = up["name"], rec["photo"]
    result["photos"] += 1
    with db.session() as conn:
        conn.execute(f"UPDATE {table} SET baserow_file = ?, baserow_photo = ? WHERE id = ?",
                     (rec["baserow_file"], rec["baserow_photo"], rec["id"]))


# ---------------------------------------------------------------- Automatisch

_timer: Optional[threading.Timer] = None
_timer_lock = threading.Lock()


def _auto() -> None:
    try:
        if load_config():
            sync()
    except BaserowError:
        pass  # steht im Zustand und wird beim nächsten Mal erneut versucht
    except Exception as exc:  # nie den Server-Thread mit in den Abgrund reißen
        _save_state(last_error=f"Unerwarteter Fehler beim Abgleich: {exc}", last_try=_now())


def schedule(delay: Optional[float] = None) -> None:
    """Abgleich kurz nach einer Änderung; weitere Änderungen schieben ihn auf."""
    global _timer
    wait = DELAY if delay is None else delay
    if DELAY <= 0 and delay is None:
        return
    with _timer_lock:
        if _timer is not None:
            _timer.cancel()
        _timer = threading.Timer(wait, _auto)
        _timer.daemon = True
        _timer.start()


def start_background() -> None:
    if DELAY <= 0:
        return

    def loop():
        stop = threading.Event()
        while not stop.wait(PERIOD):
            _auto()

    threading.Thread(target=loop, name="baserow-sync", daemon=True).start()
    schedule(60)  # nach dem Start einmal nachholen, was liegen geblieben ist


# ---------------------------------------------------------------- Schnittstelle

router = APIRouter()


def _fail(exc: BaserowError):
    raise HTTPException(status_code=502, detail=str(exc))


class LoginIn(BaseModel):
    url: str = Field(min_length=1, max_length=300)
    email: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=500)


class SetupIn(LoginIn):
    database_id: int
    variety_table_id: Optional[int] = None
    label_table_id: Optional[int] = None


class ConnectIn(BaseModel):
    url: str = Field(min_length=1, max_length=300)
    token: str = Field(min_length=1, max_length=200)
    traits_table_id: int = Field(ge=1)
    plants_table_id: int = Field(ge=1)
    observations_table_id: int = Field(ge=1)
    crops_table_id: Optional[int] = Field(None, ge=1)
    varieties_table_id: Optional[int] = Field(None, ge=1)
    plantings_table_id: Optional[int] = Field(None, ge=1)


@router.get("/api/baserow")
def get_status():
    return status()


@router.post("/api/baserow/databases")
def list_databases(body: LoginIn):
    try:
        return {"databases": databases(body.url, body.email, body.password)}
    except BaserowError as exc:
        _fail(exc)


@router.post("/api/baserow/setup")
def do_setup(body: SetupIn):
    try:
        out = setup(body.url, body.email, body.password, body.database_id, body.variety_table_id, body.label_table_id)
    except BaserowError as exc:
        _fail(exc)
    schedule(1)
    return out


@router.post("/api/baserow/connect")
def do_connect(body: ConnectIn):
    try:
        out = connect(body.url, body.token.strip(), {
            "traits": body.traits_table_id, "plants": body.plants_table_id,
            "observations": body.observations_table_id, "crops": body.crops_table_id,
            "varieties": body.varieties_table_id, "plantings": body.plantings_table_id})
    except BaserowError as exc:
        _fail(exc)
    schedule(1)
    return out


@router.post("/api/baserow/sync")
def do_sync():
    try:
        result = sync()
    except BaserowError as exc:
        _fail(exc)
    return {**status(), "result": result}


@router.delete("/api/baserow")
def do_disconnect():
    disconnect()
    return status()
