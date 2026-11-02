"""Wetterdaten von Open-Meteo (https://open-meteo.com, Lizenz CC BY 4.0) mit Zwischenspeicher.

Der Server fragt selbst bei Open-Meteo an und legt die Tageswerte in SQLite ab:

- die letzten 92 Tage und 16 Tage Vorhersage über die Forecast-Schnittstelle,
  höchstens alle REFRESH neu,
- ältere Tage einmalig über das Archiv (ERA5); die ändern sich nicht mehr.

Der Standort ist die Mitte des Grundstücks, auf 0,01° gerundet (rund 1 km). Genauer
rechnen die Wettermodelle ohnehin nicht, und Open-Meteo erfährt so nicht die Hausnummer.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from . import db, geo

FORECAST_URL = os.environ.get("BEETWERK_FORECAST_URL", "https://api.open-meteo.com/v1/forecast")
ARCHIVE_URL = os.environ.get("BEETWERK_ARCHIVE_URL", "https://archive-api.open-meteo.com/v1/archive")
USER_AGENT = "Beetwerk (selbst gehostete Gartenplanung)"
DAILY = ["precipitation_sum", "temperature_2m_min", "temperature_2m_max", "et0_fao_evapotranspiration"]
PAST_DAYS = 92
FORECAST_DAYS = 16
REFRESH = timedelta(hours=3)
ATTRIBUTION = "Wetterdaten: Open-Meteo.com (CC BY 4.0)"
STATE_KEYS = ("weather_loc", "weather_fetched_at")  # interner Zustand, gehört nicht in Sicherungen

# Letzte Abrufe: (Zeitpunkt, erfolgreich). Nach Erfolg wird erst nach REFRESH wieder gefragt,
# nach einem Fehler nach RETRY_FAILED.
_archive_tries: dict[int, tuple[datetime, bool, str | None]] = {}
_climate_tries: dict[tuple[int, int], tuple[datetime, bool, str | None]] = {}
_forecast_failed: datetime | None = None
RETRY_FAILED = timedelta(minutes=10)

# Open-Meteo nicht mit mehreren großen Anfragen gleichzeitig belasten: eine nach der anderen.
# Meldet der Dienst Überlastung, legt Beetwerk eine Pause ein.
_net_lock = threading.Lock()
_backoff_until: dict[str, datetime] = {}  # je Server (Vorhersage und Archiv sind getrennt)
BACKOFF = timedelta(minutes=10)
RETRY_SLEEP = 3.0       # Sekunden vor einem zweiten Versuch bei Überlastung
CHUNK_PAUSE = 1.0       # Sekunden zwischen den Teilabrufen der Vergleichsjahre
CLIMATE_CHUNK = 5       # Jahre je Archivabruf
ARCHIVE_DELAY = 6       # so viele Tage hinkt das Archiv (ERA5) hinterher

CLIMATE_YEARS = 20                 # so viele abgeschlossene Jahre zählen für die Froststatistik
CLIMATE_MODEL = "era5_land"        # Reanalyse mit rund 9 km Auflösung, über die Jahre einheitlich
FROST_THRESHOLDS = (-2.0, 0.0, 2.0)


class WeatherError(Exception):
    def __init__(self, message: str, busy: bool = False):
        super().__init__(message)
        self.busy = busy  # Dienst überlastet oder Abruflimit erreicht


def today() -> date:
    return date.today()


def now() -> datetime:
    return datetime.now(timezone.utc)


def location(settings: dict) -> tuple[float, float] | None:
    """Mitte des Grundstücks, sonst der von Hand eingetragene Standort."""
    g = geo.loads(settings.get("geo"))
    if g and g.get("boundary"):
        pts = g["boundary"]
        return round(sum(p[0] for p in pts) / len(pts), 2), round(sum(p[1] for p in pts) / len(pts), 2)
    try:
        lat, lon = float(settings.get("weather_lat", "")), float(settings.get("weather_lon", ""))
    except ValueError:
        return None
    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return round(lat, 2), round(lon, 2)
    return None


def _fetch_json(url: str, params: dict, retries: int = 1) -> dict:
    host = urllib.parse.urlsplit(url).netloc
    until = _backoff_until.get(host)
    if until and now() < until:
        raise WeatherError("Open-Meteo ist gerade überlastet", busy=True)
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                reason = json.loads(exc.read().decode("utf-8")).get("reason") or exc.reason
            except Exception:
                reason = exc.reason
            busy = exc.code in (429, 503) or any(w in str(reason).lower() for w in ("overload", "limit", "too many"))
            if busy and attempt < retries:
                time.sleep(RETRY_SLEEP)
                continue
            if busy:
                _backoff_until[host] = now() + BACKOFF
            raise WeatherError(f"Open-Meteo meldet: {reason}", busy=busy) from exc
        except Exception as exc:  # Netzwerk, Zeitüberschreitung, kaputte Antwort
            raise WeatherError(f"Open-Meteo ist nicht erreichbar ({exc})") from exc
    raise WeatherError("Open-Meteo ist nicht erreichbar")


def _due(entry: tuple[datetime, bool, str | None] | None, force: bool = False) -> bool:
    if force or entry is None:
        return True
    when, ok, _ = entry
    return now() - when > (REFRESH if ok else RETRY_FAILED)


def _rows(payload: dict, first_forecast: date) -> list[tuple]:
    d = payload.get("daily") or {}
    days = d.get("time") or []
    out = []
    for i, iso in enumerate(days):
        vals = [(d.get(k) or [None] * len(days))[i] for k in DAILY]
        if vals[0] is None:  # ohne Niederschlag ist der Tag nicht zu gebrauchen
            continue
        out.append((iso, *vals, int(date.fromisoformat(iso) >= first_forecast)))
    return out


def _store(rows: list[tuple], replace: bool = True) -> None:
    """replace=False füllt nur Lücken und lässt vorhandene Tage stehen."""
    stamp = now().isoformat(timespec="seconds")
    conflict = ("DO UPDATE SET precip = excluded.precip, tmin = excluded.tmin, tmax = excluded.tmax, "
                "et0 = excluded.et0, forecast = excluded.forecast, fetched_at = excluded.fetched_at"
                if replace else "DO NOTHING")
    with db.session() as conn:
        conn.executemany(
            f"""INSERT INTO weather_days(day, precip, tmin, tmax, et0, forecast, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) {conflict}""",
            [(*r, stamp) for r in rows],
        )


def _fill_from_climate(first: date, last: date) -> None:
    """Vergangene Jahre stecken schon in den Vergleichsdaten: dort nehmen, statt neu zu fragen."""
    stamp = now().isoformat(timespec="seconds")
    with db.session() as conn:
        conn.execute(
            """INSERT INTO weather_days(day, precip, tmin, tmax, et0, forecast, fetched_at)
               SELECT day, precip, tmin, tmax, et0, 0, ? FROM climate_days
               WHERE day BETWEEN ? AND ? AND precip IS NOT NULL AND tmin IS NOT NULL
               ON CONFLICT(day) DO NOTHING""",
            (stamp, first.isoformat(), last.isoformat()))


def _missing(first: date, last: date) -> list[date]:
    if first > last:
        return []
    with db.session() as conn:
        have = {r["day"] for r in db.rows(conn, "SELECT day FROM weather_days WHERE day BETWEEN ? AND ?",
                                          (first.isoformat(), last.isoformat()))}
    return [first + timedelta(days=i) for i in range((last - first).days + 1)
            if (first + timedelta(days=i)).isoformat() not in have]


def _ranges(days: list[date]) -> list[list[str]]:
    out: list[list[date]] = []
    for d in days:
        if out and (d - out[-1][1]).days == 1:
            out[-1][1] = d
        else:
            out.append([d, d])
    return [[a.isoformat(), b.isoformat()] for a, b in out]


def _set(key: str, value: str) -> None:
    with db.session() as conn:
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def _read_settings() -> dict:
    with db.session() as conn:
        return {r["key"]: r["value"] for r in db.rows(conn, "SELECT key, value FROM settings")}


def _prepare(settings: dict) -> tuple[str, tuple[float, float] | None]:
    """Status ("off", "no_location", "ok") und Standort; verwirft Gespeichertes bei neuem Ort."""
    if settings.get("weather_enabled", "1") == "0":
        return "off", None
    loc = location(settings)
    if not loc:
        return "no_location", None
    key = f"{loc[0]:.2f},{loc[1]:.2f}"
    if settings.get("weather_loc") != key:
        # Neuer Standort: alles Gespeicherte gehört zu einem anderen Ort
        with db.session() as conn:
            conn.execute("DELETE FROM weather_days")
            conn.execute("DELETE FROM climate_days")
        _set("weather_loc", key)
        _set("weather_fetched_at", "")
        settings["weather_loc"] = key
        settings["weather_fetched_at"] = ""
        _archive_tries.clear()
        _climate_tries.clear()
    return "ok", loc


def year_data(year: int, force: bool = False) -> dict:
    settings = _read_settings()
    base = {"year": year, "attribution": ATTRIBUTION, "days": [], "error": None,
            "soil": settings.get("weather_soil", "loamy_sand")}
    status, loc = _prepare(settings)
    if status != "ok":
        return {**base, "status": status}
    lat, lon = loc

    global _forecast_failed
    t = today()
    first, last = date(year, 1, 1), date(year, 12, 31)
    recent_from = t - timedelta(days=PAST_DAYS)
    horizon = t + timedelta(days=FORECAST_DAYS - 1)
    errors = []

    def stale(stamp_key: str) -> bool:
        stamp = settings.get(stamp_key) or ""
        try:
            return force or now() - datetime.fromisoformat(stamp) > REFRESH
        except ValueError:
            return True

    with _net_lock:
        # 1) jüngste Tage und Vorhersage
        recently_failed = _forecast_failed and now() - _forecast_failed < RETRY_FAILED
        if first <= horizon and last >= recent_from and stale("weather_fetched_at") and (force or not recently_failed):
            try:
                payload = _fetch_json(FORECAST_URL, {
                    "latitude": lat, "longitude": lon, "daily": ",".join(DAILY), "timezone": "auto",
                    "past_days": PAST_DAYS, "forecast_days": FORECAST_DAYS,
                })
                _store(_rows(payload, t))
                _set("weather_fetched_at", now().isoformat(timespec="seconds"))
                _forecast_failed = None
            except WeatherError as exc:
                errors.append(str(exc))
                _forecast_failed = now()

        # 2) was in den Vergleichsjahren schon da ist
        _fill_from_climate(first, min(last, t - timedelta(days=1)))

        # 3) übrige vergangene Tage aus dem Archiv, auch Lücken in den letzten Wochen
        arch_to = min(last, t - timedelta(days=ARCHIVE_DELAY))
        missing = _missing(first, arch_to)
        if missing and _due(_archive_tries.get(year), force):
            err = None
            try:
                payload = _fetch_json(ARCHIVE_URL, {
                    "latitude": lat, "longitude": lon, "daily": ",".join(DAILY), "timezone": "auto",
                    "start_date": missing[0].isoformat(), "end_date": missing[-1].isoformat(),
                })
                _store(_rows(payload, t + timedelta(days=1)), replace=False)
            except WeatherError as exc:
                err = str(exc)
            _archive_tries[year] = (now(), err is None, err)
        last_try = _archive_tries.get(year)
        if missing and last_try and last_try[2] and last_try[2] not in errors:
            errors.append(last_try[2])  # letzter Fehler, bis zum nächsten Versuch

    gaps = _ranges(_missing(first, min(last, t - timedelta(days=1))))
    with db.session() as conn:
        days = db.rows(conn, "SELECT day, precip, tmin, tmax, et0, forecast FROM weather_days "
                             "WHERE day BETWEEN ? AND ? ORDER BY day", (first.isoformat(), last.isoformat()))
        fetched = conn.execute("SELECT value FROM settings WHERE key = 'weather_fetched_at'").fetchone()
    # Vorhersagen, die inzwischen in der Vergangenheit liegen, zählen nicht mehr als Vorhersage
    for d in days:
        d["forecast"] = bool(d["forecast"]) and d["day"] >= t.isoformat()
    return {**base, "status": "ok", "location": {"lat": lat, "lon": lon}, "today": t.isoformat(),
            "fetched_at": fetched[0] if fetched else None, "days": days, "gaps": gaps,
            "error": errors[0] if errors else None}


# ---------------------------------------------------------------- Frostdaten

def _norm(d: date) -> int:
    """Tag im Jahr (0 = 1. Januar) in einem Jahr ohne Schalttag, damit Jahre vergleichbar sind."""
    day = min(d.day, 28) if d.month == 2 else d.day
    return (date(2001, d.month, day) - date(2001, 1, 1)).days


def _mmdd(n: int | None) -> str | None:
    return None if n is None else (date(2001, 1, 1) + timedelta(days=n)).strftime("%m-%d")


def frost_dates(tmins: dict[date, float], year: int, threshold: float) -> tuple[date | None, date | None]:
    """Letzter Frost im Frühjahr (bis Ende Juli) und erster Frost im Herbst (ab August)."""
    spring = [d for d, t in tmins.items() if d.year == year and d.month <= 7 and t is not None and t <= threshold]
    autumn = [d for d, t in tmins.items() if d.year == year and d.month >= 8 and t is not None and t <= threshold]
    return (max(spring) if spring else None), (min(autumn) if autumn else None)


def frost_stats(springs: list[int | None], autumns: list[int | None]) -> dict:
    """Aus den Frosttagen der einzelnen Jahre: Median und die Tage mit nur noch 10 % Risiko.

    springs: letzter Frosttag je Jahr (None = kein Frost im Frühjahr), autumns: erster Frosttag
    (None = kein Frost bis Jahresende). Alles als Tag im Jahr ohne Schalttag.
    """
    n = len(springs)
    if not n:
        return {}

    def spring_risk(d):  # Anteil der Jahre, in denen nach Tag d noch Frost kam
        return sum(1 for s in springs if s is not None and s > d) / n

    def autumn_risk(d):  # Anteil der Jahre, in denen bis Tag d schon Frost war
        return sum(1 for a in autumns if a is not None and a <= d) / n

    days = range(365)
    spring_median = next(d for d in days if spring_risk(d) <= 0.5)
    spring_safe = next(d for d in days if spring_risk(d) <= 0.1)
    autumn_median = next((d for d in days if autumn_risk(d) >= 0.5), None)
    autumn_safe = max((d for d in days if autumn_risk(d) <= 0.1 and d >= 182), default=None)
    sp = [s for s in springs if s is not None]
    au = [a for a in autumns if a is not None]
    free = [a - s for s, a in zip(springs, autumns) if s is not None and a is not None]
    return {
        "spring_median": _mmdd(spring_median),
        "spring_safe": _mmdd(spring_safe),          # danach Frost nur noch in höchstens 10 % der Jahre
        "spring_earliest": _mmdd(min(sp)) if sp else None,
        "spring_latest": _mmdd(max(sp)) if sp else None,
        "autumn_median": _mmdd(autumn_median),
        "autumn_safe": _mmdd(autumn_safe),          # bis dahin Frost in höchstens 10 % der Jahre
        "autumn_earliest": _mmdd(min(au)) if au else None,
        "autumn_latest": _mmdd(max(au)) if au else None,
        "frost_free_median": sorted(free)[len(free) // 2] if free else None,
    }


CLIMATE_VARS = ["temperature_2m_min", "temperature_2m_max", "precipitation_sum", "et0_fao_evapotranspiration"]


def _climate_rows(first: date, last: date) -> dict[date, dict]:
    with db.session() as conn:
        rows = db.rows(conn, "SELECT day, tmin, tmax, precip, et0 FROM climate_days WHERE day BETWEEN ? AND ?",
                       (first.isoformat(), last.isoformat()))
    return {date.fromisoformat(r["day"]): r for r in rows}


def _fetch_climate(lat: float, lon: float, first: date, last: date) -> None:
    params = {"latitude": lat, "longitude": lon, "daily": ",".join(CLIMATE_VARS), "timezone": "auto",
              "start_date": first.isoformat(), "end_date": last.isoformat()}
    try:
        payload = _fetch_json(ARCHIVE_URL, {**params, "models": CLIMATE_MODEL})
    except WeatherError as exc:
        if exc.busy:
            raise
        # falls das Modell nicht angeboten wird: Standardauswahl von Open-Meteo
        payload = _fetch_json(ARCHIVE_URL, params)
    d = payload.get("daily") or {}
    days = d.get("time") or []
    col = lambda k: d.get(k) or [None] * len(days)  # noqa: E731
    data = [(day, tn, tx, p, e) for day, tn, tx, p, e in zip(
        days, col("temperature_2m_min"), col("temperature_2m_max"), col("precipitation_sum"),
        col("et0_fao_evapotranspiration")) if tn is not None]
    with db.session() as conn:
        conn.executemany(
            """INSERT INTO climate_days(day, tmin, tmax, precip, et0) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(day) DO UPDATE SET tmin = excluded.tmin, tmax = excluded.tmax,
                 precip = excluded.precip, et0 = excluded.et0""", data)


def _ensure_climate(lat: float, lon: float, y0: int, y1: int) -> tuple[dict[date, dict], str | None]:
    """Tageswerte der Vergleichsjahre; lädt in Teilen von CLIMATE_CHUNK Jahren nach, was fehlt."""
    first, last = date(y0, 1, 1), date(y1, 12, 31)
    error = None
    with _net_lock:
        rows = _climate_rows(first, last)
        count: dict[int, int] = {}
        for d, r in rows.items():
            if r["precip"] is not None and r["tmin"] is not None:
                count[d.year] = count.get(d.year, 0) + 1
        missing = [y for y in range(y0, y1 + 1) if count.get(y, 0) < 360]
        last_try = _climate_tries.get((y0, y1))
        if missing and not _due(last_try):
            error = last_try[2]  # letzter Fehler, bis zum nächsten Versuch
        if missing and _due(last_try):
            chunks: list[list[int]] = []
            for y in missing:
                if chunks and y == chunks[-1][-1] + 1 and len(chunks[-1]) < CLIMATE_CHUNK:
                    chunks[-1].append(y)
                else:
                    chunks.append([y])
            for i, chunk in enumerate(chunks):
                if i:
                    time.sleep(CHUNK_PAUSE)
                try:
                    _fetch_climate(lat, lon, date(chunk[0], 1, 1), date(chunk[-1], 12, 31))
                except WeatherError as exc:
                    error = str(exc)
                    break
            _climate_tries[(y0, y1)] = (now(), error is None, error)
            rows = _climate_rows(first, last)
    return rows, error


def frost_data(threshold: float | None = None) -> dict:
    settings = _read_settings()
    if threshold is None:
        try:
            threshold = float(settings.get("weather_frost", "0"))
        except ValueError:
            threshold = 0.0
    t = today()
    y0, y1 = t.year - CLIMATE_YEARS, t.year - 1
    base = {"attribution": ATTRIBUTION, "threshold": threshold, "years": [y0, y1], "error": None}
    status, loc = _prepare(settings)
    if status != "ok":
        return {**base, "status": status}
    lat, lon = loc
    rows, error = _ensure_climate(lat, lon, y0, y1)
    tmins = {d: r["tmin"] for d, r in rows.items()}
    years = sorted({d.year for d in tmins})
    # Nur vollständige Jahre zählen
    years = [y for y in years if sum(1 for d in tmins if d.year == y) >= 360]
    if not years:
        return {**base, "status": "ok", "per_year": [], "stats": {}, "error": error or "Keine Temperaturdaten im Archiv"}
    per_year, springs, autumns = [], [], []
    for y in years:
        sp, au = frost_dates(tmins, y, threshold)
        per_year.append({"year": y, "spring": sp.isoformat() if sp else None, "autumn": au.isoformat() if au else None})
        springs.append(_norm(sp) if sp else None)
        autumns.append(_norm(au) if au else None)
    return {**base, "status": "ok", "years": [years[0], years[-1]], "n": len(years),
            "location": {"lat": lat, "lon": lon},
            "per_year": per_year, "spring": [_mmdd(v) for v in springs], "autumn": [_mmdd(v) for v in autumns],
            "stats": frost_stats(springs, autumns), "error": error}


# ---------------------------------------------------------------- Vergleichswerte (Mittel der Vorjahre)

def _smooth(values: list[float | None], window: int = 15) -> list[float | None]:
    """Gleitendes Mittel über das Jahr (rund um Silvester fortgesetzt)."""
    n, half = len(values), window // 2
    out = []
    for i in range(n):
        win = [values[(i + k) % n] for k in range(-half, half + 1)]
        win = [v for v in win if v is not None]
        out.append(round(sum(win) / len(win), 2) if win else None)
    return out


def climate_normals(rows: dict[date, dict]) -> dict:
    """Mittel je Tag im Jahr (ohne Schalttag) und je Monat aus vollständigen Jahren."""
    years = sorted({d.year for d in rows})
    per_year_count: dict[int, int] = {}
    for d, r in rows.items():
        if r["precip"] is not None:
            per_year_count[d.year] = per_year_count.get(d.year, 0) + 1
    years = [y for y in years if per_year_count.get(y, 0) >= 360]
    if not years:
        return {}
    n = len(years)
    buckets = {k: [[] for _ in range(365)] for k in ("tmin", "tmax", "precip", "et0")}
    for d, r in rows.items():
        if d.year not in years or (d.month == 2 and d.day == 29):
            continue
        i = _norm(d)
        for k in buckets:
            if r[k] is not None:
                buckets[k][i].append(r[k])
    mean = {k: [sum(v) / len(v) if v else None for v in b] for k, b in buckets.items()}
    cum, total = [], 0.0
    for v in mean["precip"]:
        total += v or 0
        cum.append(round(total, 1))
    by_month: dict[tuple[int, int], list[dict]] = {}
    for d, r in rows.items():
        by_month.setdefault((d.year, d.month), []).append(r)
    months = []
    for m in range(1, 13):
        per_year = []
        for y in years:
            days = by_month.get((y, m), [])
            prec = [r["precip"] for r in days if r["precip"] is not None]
            per_year.append({
                "precip": sum(prec),
                "rain_days": sum(1 for v in prec if v >= 1.0),
                "frost_days": sum(1 for r in days if r["tmin"] is not None and r["tmin"] < 0),
                "et0": sum(r["et0"] or 0 for r in days),
                "tmax": [r["tmax"] for r in days if r["tmax"] is not None],
                "tmin": [r["tmin"] for r in days if r["tmin"] is not None],
            })
        avg = lambda key: round(sum(p[key] for p in per_year) / n, 1)  # noqa: E731
        months.append({
            "month": m, "precip": avg("precip"), "rain_days": avg("rain_days"), "frost_days": avg("frost_days"),
            "et0": avg("et0"),
            "tmax": round(sum(sum(p["tmax"]) / len(p["tmax"]) for p in per_year if p["tmax"]) / n, 1),
            "tmin": round(sum(sum(p["tmin"]) / len(p["tmin"]) for p in per_year if p["tmin"]) / n, 1),
        })
    return {
        "years": [years[0], years[-1]], "n": n,
        "daily": {"tmin": _smooth(mean["tmin"]), "tmax": _smooth(mean["tmax"]),
                  "et0": _smooth(mean["et0"]), "precip_cum": cum},
        "months": months,
        "year_precip": round(sum(m["precip"] for m in months)),
    }


def climate_data() -> dict:
    settings = _read_settings()
    t = today()
    y0, y1 = t.year - CLIMATE_YEARS, t.year - 1
    base = {"attribution": ATTRIBUTION, "years": [y0, y1], "error": None}
    status, loc = _prepare(settings)
    if status != "ok":
        return {**base, "status": status}
    rows, error = _ensure_climate(loc[0], loc[1], y0, y1)
    normals = climate_normals(rows)
    if not normals:
        return {**base, "status": "ok", "error": error or "Keine Vergleichsdaten im Archiv"}
    return {**base, "status": "ok", **normals, "error": error}
