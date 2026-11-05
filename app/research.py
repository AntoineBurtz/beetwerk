"""Saatgut-Recherche: Claude sucht im Netz nach einer Sorte und schlägt die Einordnung vor.

Ablauf: Sortenname (und auf Wunsch ein Foto vom Samentütchen) → Claude mit
Websuche → JSON mit den Feldern der Sortenliste und den wichtigsten Quellen.
Bildvorschläge kommen von Wikimedia Commons (frei lizenziert) und aus dem
Vorschaubild (og:image) der gefundenen Seiten. Nichts wird ohne Bestätigung
gespeichert; Bilder lädt Beetwerk erst herunter, wenn eines gewählt ist.
"""
import base64
import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from typing import Optional

from . import db

ANTHROPIC_URL = os.environ.get("BEETWERK_ANTHROPIC_URL", "https://api.anthropic.com").rstrip("/")
COMMONS_URL = os.environ.get("BEETWERK_COMMONS_URL", "https://commons.wikimedia.org/w/api.php")
ALLOW_PRIVATE = os.environ.get("BEETWERK_ALLOW_PRIVATE_FETCH") == "1"  # nur für Tests mit lokalen Servern
API_VERSION = "2023-06-01"
TIMEOUT = 180
USER_AGENT = "Beetwerk/1.0 (selbst gehostete Anbauplanung; Saatgut-Recherche)"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Beetwerk"

KEYS = ("research_api_key", "research_model")
MODELS = [
    ("claude-sonnet-5-5", "Claude Sonnet 5.5 – empfohlen"),
    ("claude-haiku-5-5", "Claude Haiku 5.5 – schneller und günstiger"),
    ("claude-opus-5-5", "Claude Opus 5.5 – am gründlichsten, teurer"),
]
DEFAULT_MODEL = MODELS[0][0]
FIELDS = ("name", "crop", "species", "kind", "seed", "supplier", "description")


class ResearchError(Exception):
    pass


class FatalResearchError(ResearchError):
    """Fehler, bei dem weitere Anfragen nichts bringen (Schlüssel, Guthaben, keine Verbindung)."""


class BusyError(ResearchError):
    """Zu viele Anfragen oder überlastet: später noch einmal."""


# ---------------------------------------------------------------- Einstellungen

def settings() -> dict:
    with db.session() as conn:
        rows = {r["key"]: r["value"] for r in db.rows(
            conn, "SELECT key, value FROM settings WHERE key IN (?, ?)", KEYS)}
    return {"api_key": rows.get("research_api_key", ""), "model": rows.get("research_model") or DEFAULT_MODEL}


def save_settings(api_key: Optional[str], model: Optional[str]) -> None:
    with db.session() as conn:
        if api_key is not None:
            if api_key.strip():
                conn.execute("INSERT INTO settings(key, value) VALUES ('research_api_key', ?) "
                             "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (api_key.strip(),))
            else:
                conn.execute("DELETE FROM settings WHERE key = 'research_api_key'")
        if model:
            conn.execute("INSERT INTO settings(key, value) VALUES ('research_model', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (model,))


def status() -> dict:
    s = settings()
    key = s["api_key"]
    return {"configured": bool(key), "model": s["model"], "models": [{"id": m, "label": l} for m, l in MODELS],
            "key_hint": f"…{key[-4:]}" if len(key) > 8 else ""}


# ---------------------------------------------------------------- Claude

def _claude(body: dict, api_key: str) -> dict:
    req = urllib.request.Request(
        f"{ANTHROPIC_URL}/v1/messages", data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json",
                 "user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read().decode("utf-8")).get("error", {})
        except Exception:
            err = {}
        kind, msg = err.get("type", ""), err.get("message", "") or exc.reason
        if exc.code == 401 or kind == "authentication_error":
            raise FatalResearchError("Der API-Schlüssel wird nicht angenommen. Prüfe ihn in den Einstellungen.") from exc
        if exc.code == 403 or kind == "permission_error":
            raise FatalResearchError(f"Der API-Schlüssel darf das nicht: {msg}") from exc
        if exc.code == 429 or kind == "rate_limit_error":
            raise BusyError("Zu viele Anfragen an Claude. Bitte in einer Minute noch einmal.") from exc
        if exc.code in (500, 529) or kind in ("overloaded_error", "api_error"):
            raise BusyError("Claude ist gerade überlastet. Bitte gleich noch einmal versuchen.") from exc
        if "credit balance" in str(msg).lower():
            raise FatalResearchError("Das Guthaben des API-Kontos reicht nicht. Lade es in der Claude Console auf.") from exc
        raise ResearchError(f"Claude meldet: {msg}") from exc
    except urllib.error.URLError as exc:
        raise FatalResearchError(f"Claude ist nicht erreichbar ({exc.reason}). Hat der Server Internet?") from exc
    except (TimeoutError, OSError) as exc:
        raise ResearchError(f"Claude antwortet nicht ({exc})") from exc


def test_key(api_key: Optional[str] = None, model: Optional[str] = None) -> dict:
    s = settings()
    key = api_key or s["api_key"]
    if not key:
        raise ResearchError("Es ist noch kein API-Schlüssel gespeichert")
    res = _claude({"model": model or s["model"], "max_tokens": 5,
                   "messages": [{"role": "user", "content": "Antworte nur mit OK."}]}, key)
    return {"ok": True, "model": res.get("model", model or s["model"])}


SYSTEM = (
    "Du bist ein sorgfältiger Saatgut-Experte für Gemüse und hilfst, eine private Sortenliste zu pflegen. "
    "Recherchiere mit der Websuche, bevorzugt bei Saatgut-Händlern, Erhalterorganisationen und Sortenlisten. "
    "Unterscheide genau zwischen ähnlich benannten Sorten. Erfinde nichts: Was du nicht belegen kannst, bleibt leer. "
    "Antworte auf Deutsch."
)


def _trait_lines(traits: list[dict]) -> str:
    """Merkmale der Sortenliste, die Claude füllen soll, mit erlaubten Werten."""
    lines = []
    for t in traits:
        if t["type"] == "number":
            what = f"Zahl in {t['unit']}" if t.get("unit") else "Zahl"
        elif t["type"] == "multi":
            what = "Liste aus: " + " | ".join(t["options"] or [])
        else:
            what = "genau eines von: " + " | ".join(t["options"] or [])
        group = {"tomato": " (nur Tomate)", "pepper": " (nur Paprika/Chili)"}.get(t.get("grp"), "")
        lines.append(f"- {t['key']}: {t['name']}{group} – {what}")
    return "\n".join(lines)


def _prompt(name: str, crop: str, crops: list[str], hint: str, with_image: bool, traits: list[dict]) -> str:
    parts = []
    if name:
        parts.append(f"Recherchiere die Gemüsesorte „{name}“" + (f" (Kultur: {crop})" if crop else "") + ".")
    else:
        parts.append("Recherchiere die Gemüsesorte auf dem Foto" + (f" (Kultur: {crop})" if crop else "") + ".")
    if with_image:
        parts.append("Das Foto zeigt das Samentütchen: Lies Sortenname, Händler und Angaben darauf ab und nutze sie.")
    if hint:
        parts.append(f"Hinweis: {hint}")
    parts.append(
        "Antworte zum Schluss mit genau einem JSON-Objekt in einem ```json-Block mit diesen Schlüsseln:\n"
        "name: Sortenname in der üblichen Schreibweise\n"
        f"crop: Kultur auf Deutsch, wenn möglich genau eine aus dieser Liste: {', '.join(crops)}\n"
        "species: botanische Art, z. B. Solanum lycopersicum oder Capsicum chinense\n"
        "kind: Typ, z. B. Fleischtomate, Cocktailtomate, Spitzpaprika, Habanero-Typ\n"
        "seed: „samenfest“, „F1-Hybride“ oder leer\n"
        "supplier: Händler oder Bezugsquelle, nur wenn vom Tütchen oder Hinweis bekannt\n"
        "description: zwei bis vier Sätze zu Frucht, Geschmack, Verwendung, Herkunft\n"
        "confidence: „hoch“, „mittel“ oder „niedrig“, je nachdem wie sicher genau diese Sorte gefunden wurde\n"
        "sources: die wichtigsten Seiten als Liste [{\"url\": …, \"title\": …}], höchstens fünf\n"
        "images: direkte Bild-URLs genau dieser Sorte von diesen Seiten, höchstens vier, sonst leere Liste\n"
        "traits: Merkmale als Objekt {Schlüssel: Wert}, nur mit den Schlüsseln aus der Liste unten und nur, "
        "wenn eine Quelle sie belegt\n"
        "Unbekannte Werte als leerer Text."
    )
    if traits:
        parts.append(
            "Merkmale für traits. Klassen und Zahlen sind getrennte Felder: schreibe in ein Klassen-Feld nur die "
            "Klasse (z. B. plant_size „groß“) und in das Zahlen-Feld nur die Zahl ohne Einheit (z. B. height 180). "
            "Bei Spannen wie „150–200 cm“ die Mitte (175). Rechne Einheiten um, wenn nötig (1 m = 100 cm). "
            "Lass ein Merkmal weg, wenn du es nicht belegen kannst.\n" + _trait_lines(traits))
    return "\n\n".join(parts)


def _parse_json(text: str) -> dict:
    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = blocks[::-1] or ([text[text.find("{"): text.rfind("}") + 1]] if "{" in text else [])
    for c in candidates:
        try:
            data = json.loads(c)
            if isinstance(data, dict):
                return data
        except ValueError:
            continue
    raise ResearchError("Claude hat keine auswertbare Antwort geliefert. Bitte noch einmal versuchen.")


def research(name: str, crop: str = "", crops: Optional[list[str]] = None, hint: str = "",
             image: Optional[dict] = None, traits: Optional[list[dict]] = None, images: bool = True) -> dict:
    """Recherchiert eine Sorte. image: {"data": base64, "media_type": "image/jpeg"} (Samentütchen)."""
    s = settings()
    if not s["api_key"]:
        raise FatalResearchError("Für die Recherche fehlt der API-Schlüssel (Einstellungen → KI-Recherche)")
    name = (name or "").strip()
    if not name and not image:
        raise ResearchError("Bitte einen Sortennamen eingeben oder ein Foto vom Samentütchen wählen")
    content: list = []
    if image:
        content.append({"type": "image", "source": {"type": "base64", "media_type": image.get("media_type", "image/jpeg"),
                                                    "data": image["data"]}})
    content.append({"type": "text", "text": _prompt(name, crop, crops or [], hint.strip(), bool(image), traits or [])})
    messages = [{"role": "user", "content": content}]
    body = {
        "model": s["model"], "max_tokens": 4000, "system": SYSTEM, "messages": messages,
        "tools": [
            {"type": "web_search_20250305", "name": "web_search", "max_uses": 5,
             "user_location": {"type": "approximate", "country": "DE", "timezone": "Europe/Berlin"}},
            {"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 2, "max_content_tokens": 8000},
        ],
    }
    usage = {"input_tokens": 0, "output_tokens": 0, "web_search_requests": 0, "web_fetch_requests": 0}
    blocks: list = []
    for _ in range(4):  # Websuche kann die Antwort unterbrechen (pause_turn), dann weitermachen
        res = _claude(body, s["api_key"])
        u = res.get("usage") or {}
        usage["input_tokens"] += u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
        usage["output_tokens"] += u.get("output_tokens", 0)
        for k in ("web_search_requests", "web_fetch_requests"):
            usage[k] += (u.get("server_tool_use") or {}).get(k, 0)
        blocks += res.get("content") or []
        if res.get("stop_reason") != "pause_turn":
            if res.get("stop_reason") == "refusal":
                raise ResearchError("Claude hat die Anfrage abgelehnt")
            break
        body = {**body, "messages": messages + [{"role": "assistant", "content": res.get("content") or []}]}
    # Mit Quellenangaben teilt Claude den Text in mehrere Blöcke; sie gehören ohne Trenner zusammen
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    data = _parse_json(text)

    found = []  # Treffer der Websuche als Rückfall für Quellen und Bilder
    for b in blocks:
        if b.get("type") == "web_search_tool_result" and isinstance(b.get("content"), list):
            found += [{"url": r.get("url"), "title": r.get("title", "")} for r in b["content"] if r.get("url")]
    out = {k: str(data.get(k) or "").strip() for k in FIELDS}
    out["confidence"] = str(data.get("confidence") or "").strip()
    out["traits"] = data.get("traits") if isinstance(data.get("traits"), dict) else {}
    sources = [x for x in (data.get("sources") or []) if isinstance(x, dict) and _http(x.get("url"))]
    if not sources:
        sources = found[:5]
    out["sources"] = [{"url": x["url"], "title": str(x.get("title") or "")[:200]} for x in sources[:5]]
    model_images = [u for u in (data.get("images") or []) if isinstance(u, str) and _http(u)][:4]
    out["images"] = image_candidates(out["name"] or name, out["species"], out["crop"] or crop,
                                     [x["url"] for x in out["sources"]] + [x["url"] for x in found[:3]],
                                     model_images) if images else []
    out["usage"] = usage
    out["model"] = s["model"]
    return out


# ---------------------------------------------------------------- Bilder

def _http(url) -> bool:
    return isinstance(url, str) and re.match(r"^https?://", url, re.I) is not None


def _check_public(url: str) -> None:
    """Keine Abrufe ins eigene Netz (Schutz vor umgeleiteten Anfragen auf den Server oder den Router)."""
    if ALLOW_PRIVATE:
        return
    host = urllib.parse.urlsplit(url).hostname
    if not host:
        raise ResearchError("Ungültige Adresse")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ResearchError(f"{host} ist nicht erreichbar") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ResearchError("Adressen im eigenen Netz werden nicht abgerufen")


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_public(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def fetch(url: str, limit: int, accept: str = "*/*", ua: str = BROWSER_UA, timeout: int = 15) -> tuple[bytes, str]:
    if not _http(url):
        raise ResearchError("Nur http- und https-Adressen")
    _check_public(url)
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": accept})
    try:
        with _opener.open(req, timeout=timeout) as res:
            data = res.read(limit + 1)
            ctype = res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        raise ResearchError(f"Die Seite antwortet mit {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ResearchError(f"Die Seite ist nicht erreichbar ({getattr(exc, 'reason', exc)})") from exc
    if len(data) > limit:
        raise ResearchError("Die Datei ist zu groß")
    return data, ctype


def commons_images(query: str, limit: int = 4) -> list[dict]:
    params = {"action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrsearch": query,
              "gsrlimit": 8, "prop": "imageinfo", "iiprop": "url|mime|extmetadata", "iiurlwidth": 480}
    url = f"{COMMONS_URL}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read().decode("utf-8"))
    except Exception:
        return []
    pages = sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    out = []
    for p in pages:
        info = (p.get("imageinfo") or [{}])[0]
        if info.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
            continue
        meta = info.get("extmetadata") or {}
        lic = (meta.get("LicenseShortName") or {}).get("value", "")
        artist = re.sub(r"<[^>]+>", "", unescape((meta.get("Artist") or {}).get("value", ""))).strip()
        out.append({"url": info.get("url"), "thumb": info.get("thumburl") or info.get("url"),
                    "page": info.get("descriptionurl", ""),
                    "credit": f"Wikimedia Commons, {artist + ', ' if artist else ''}{lic}".strip(", "),
                    "free": True})
        if len(out) >= limit:
            break
    return out


OG_RE = re.compile(r"<meta[^>]+(?:property|name)=[\"'](?:og:image|og:image:url|twitter:image)[\"'][^>]*>", re.I)
CONTENT_RE = re.compile(r"content=[\"']([^\"']+)[\"']", re.I)


def page_image(page_url: str) -> Optional[dict]:
    """Vorschaubild einer Seite (og:image), z. B. das Produktfoto im Saatgut-Shop."""
    try:
        html, ctype = fetch(page_url, 1_500_000, accept="text/html")
    except ResearchError:
        return None
    if "html" not in ctype.lower():
        return None
    text = html.decode("utf-8", errors="replace")
    for tag in OG_RE.findall(text):
        m = CONTENT_RE.search(tag)
        if m:
            img = urllib.parse.urljoin(page_url, unescape(m.group(1)))
            host = urllib.parse.urlsplit(page_url).hostname or ""
            return {"url": img, "thumb": img, "page": page_url, "credit": f"{host} (nur für den privaten Gebrauch)",
                    "free": False}
    return None


def image_candidates(name: str, species: str, crop: str, pages: list[str], direct: list[str]) -> list[dict]:
    out, seen = [], set()

    def add(c):
        if c and c.get("url") and c["url"] not in seen:
            seen.add(c["url"])
            out.append(c)

    for q in (f"{name} {species}".strip(), f"{name} {crop}".strip()):
        for c in commons_images(q, 3):
            add(c)
        if len(out) >= 3:
            break
    for page in list(dict.fromkeys(p for p in pages if _http(p)))[:4]:
        add(page_image(page))
    for u in direct:
        host = urllib.parse.urlsplit(u).hostname or ""
        add({"url": u, "thumb": u, "page": "", "credit": f"{host} (nur für den privaten Gebrauch)", "free": False})
    return out[:8]


def download_image(url: str) -> bytes:
    data, ctype = fetch(url, 15_000_000, accept="image/*")
    looks_like_image = data[:3] == b"\xff\xd8\xff" or data[:4] in (b"\x89PNG", b"RIFF")
    if not ctype.lower().startswith("image/") and not looks_like_image:
        raise ResearchError("Unter dieser Adresse liegt kein Bild")
    return data


def decode_image(data_url: str) -> dict:
    """Bild aus der Oberfläche (data:image/jpeg;base64,…) für die Anfrage an Claude."""
    m = re.match(r"^data:(image/(?:jpeg|png|webp|gif));base64,(.+)$", data_url or "", re.S)
    if not m:
        raise ResearchError("Das Foto konnte nicht gelesen werden (JPEG, PNG oder WebP)")
    raw = m.group(2)
    if len(raw) > 7_000_000:
        raise ResearchError("Das Foto ist zu groß; bitte kleiner aufnehmen")
    base64.b64decode(raw[:100] + "=" * (-len(raw[:100]) % 4), validate=False)
    return {"media_type": m.group(1), "data": raw}
