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

# Letzter Archivabruf je Jahr; fehlen danach noch Tage, wird erst nach REFRESH wieder gefragt
_archive_tries: dict[int, datetime] = {}


class WeatherError(Exception):
    pass


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


def _fetch_json(url: str, params: dict) -> dict:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            reason = json.loads(exc.read().decode("utf-8")).get("reason") or exc.reason
        except Exception:
            reason = exc.reason
        raise WeatherError(f"Open-Meteo meldet: {reason}") from exc
    except Exception as exc:  # Netzwerk, Zeitüberschreitung, kaputte Antwort
        raise WeatherError(f"Open-Meteo ist nicht erreichbar ({exc})") from exc


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


def _store(rows: list[tuple]) -> None:
    stamp = now().isoformat(timespec="seconds")
    with db.session() as conn:
        conn.executemany(
            """INSERT INTO weather_days(day, precip, tmin, tmax, et0, forecast, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(day) DO UPDATE SET precip = excluded.precip, tmin = excluded.tmin,
                 tmax = excluded.tmax, et0 = excluded.et0, forecast = excluded.forecast,
                 fetched_at = excluded.fetched_at""",
            [(*r, stamp) for r in rows],
        )


def _set(key: str, value: str) -> None:
    with db.session() as conn:
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def year_data(year: int, force: bool = False) -> dict:
    with db.session() as conn:
        settings = {r["key"]: r["value"] for r in db.rows(conn, "SELECT key, value FROM settings")}
    base = {"year": year, "attribution": ATTRIBUTION, "days": [], "error": None,
            "soil": settings.get("weather_soil", "loamy_sand")}
    if settings.get("weather_enabled", "1") == "0":
        return {**base, "status": "off"}
    loc = location(settings)
    if not loc:
        return {**base, "status": "no_location"}
    lat, lon = loc
    key = f"{lat:.2f},{lon:.2f}"
    if settings.get("weather_loc") != key:
        # Neuer Standort: alles Gespeicherte gehört zu einem anderen Ort
        with db.session() as conn:
            conn.execute("DELETE FROM weather_days")
        _set("weather_loc", key)
        _set("weather_fetched_at", "")
        settings["weather_fetched_at"] = ""
        _archive_tries.clear()

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

    def archive_due() -> bool:
        last_try = _archive_tries.get(year)
        return force or last_try is None or now() - last_try > REFRESH

    # 1) jüngste Tage und Vorhersage
    if first <= horizon and last >= recent_from and stale("weather_fetched_at"):
        try:
            payload = _fetch_json(FORECAST_URL, {
                "latitude": lat, "longitude": lon, "daily": ",".join(DAILY), "timezone": "auto",
                "past_days": PAST_DAYS, "forecast_days": FORECAST_DAYS,
            })
            _store(_rows(payload, t))
            _set("weather_fetched_at", now().isoformat(timespec="seconds"))
        except WeatherError as exc:
            errors.append(str(exc))

    # 2) ältere Tage aus dem Archiv, nur was noch fehlt
    arch_to = min(last, recent_from - timedelta(days=1))
    if first <= arch_to:
        with db.session() as conn:
            have = {r["day"] for r in db.rows(conn, "SELECT day FROM weather_days WHERE day BETWEEN ? AND ?",
                                              (first.isoformat(), arch_to.isoformat()))}
        missing = [first + timedelta(days=i) for i in range((arch_to - first).days + 1)
                   if (first + timedelta(days=i)).isoformat() not in have]
        if missing and archive_due():
            try:
                payload = _fetch_json(ARCHIVE_URL, {
                    "latitude": lat, "longitude": lon, "daily": ",".join(DAILY), "timezone": "auto",
                    "start_date": missing[0].isoformat(), "end_date": missing[-1].isoformat(),
                })
                _store(_rows(payload, t + timedelta(days=1)))
            except WeatherError as exc:
                errors.append(str(exc))
            _archive_tries[year] = now()

    with db.session() as conn:
        days = db.rows(conn, "SELECT day, precip, tmin, tmax, et0, forecast FROM weather_days "
                             "WHERE day BETWEEN ? AND ? ORDER BY day", (first.isoformat(), last.isoformat()))
        fetched = conn.execute("SELECT value FROM settings WHERE key = 'weather_fetched_at'").fetchone()
    # Vorhersagen, die inzwischen in der Vergangenheit liegen, zählen nicht mehr als Vorhersage
    for d in days:
        d["forecast"] = bool(d["forecast"]) and d["day"] >= t.isoformat()
    return {**base, "status": "ok", "location": {"lat": lat, "lon": lon}, "today": t.isoformat(),
            "fetched_at": fetched[0] if fetched else None, "days": days,
            "error": errors[0] if errors else None}
