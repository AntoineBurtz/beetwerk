import os
import tempfile
import urllib.parse
from datetime import date, datetime, timedelta, timezone

import pytest

os.environ.setdefault("BEETWERK_DATA", tempfile.mkdtemp(prefix="beetwerk-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import db, weather  # noqa: E402
from app.main import app  # noqa: E402

TODAY = date(2026, 7, 15)


class FakeMeteo:
    """Ersetzt den Abruf bei Open-Meteo: Regen am 1. jedes Monats, sonst trocken."""

    def __init__(self):
        self.calls = []
        self.fail = False

    def __call__(self, url, params):
        self.calls.append((url, dict(params)))
        if self.fail:
            raise weather.WeatherError("Open-Meteo ist nicht erreichbar (Testfehler)")
        if url == weather.FORECAST_URL:
            start = TODAY - timedelta(days=params["past_days"])
            end = TODAY + timedelta(days=params["forecast_days"] - 1)
        else:
            start, end = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        src = 1.0 if url == weather.FORECAST_URL else 0.0
        return {"daily": {
            "time": [d.isoformat() for d in days],
            "precipitation_sum": [12.0 if d.day == 1 else 0.0 for d in days],
            "temperature_2m_min": [-2.0 if d.month < 4 else 10.0 for d in days],
            "temperature_2m_max": [20.0 + src for _ in days],
            "et0_fao_evapotranspiration": [3.0 for _ in days],
        }}

    def urls(self):
        return [u for u, _ in self.calls]


@pytest.fixture()
def fake(monkeypatch):
    f = FakeMeteo()
    clock = {"now": datetime(2026, 7, 15, 8, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(weather, "_fetch_json", f)
    monkeypatch.setattr(weather, "today", lambda: TODAY)
    monkeypatch.setattr(weather, "now", lambda: clock["now"])
    weather._archive_tries.clear()
    with db.session() as conn:
        conn.execute("DELETE FROM weather_days")
        conn.execute("DELETE FROM settings WHERE key IN ('geo', 'weather_loc', 'weather_fetched_at', "
                     "'weather_lat', 'weather_lon', 'weather_enabled')")
    f.clock = clock
    return f


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_needs_location(client, fake):
    r = client.get("/api/weather?year=2026").json()
    assert r["status"] == "no_location" and r["days"] == []
    assert fake.calls == []


def test_year_from_archive_and_forecast(client, fake):
    assert client.patch("/api/settings", json={"weather_lat": 48.3712, "weather_lon": 10.8977}).status_code == 200
    r = client.get("/api/weather?year=2026").json()
    assert r["status"] == "ok" and r["error"] is None
    assert r["location"] == {"lat": 48.37, "lon": 10.9}  # auf rund 1 km gerundet
    assert "Open-Meteo" in r["attribution"]
    days = r["days"]
    assert days[0]["day"] == "2026-01-01"
    assert days[-1]["day"] == (TODAY + timedelta(days=15)).isoformat()
    assert len(days) == (TODAY - date(2026, 1, 1)).days + 16
    # Archiv bis vor 93 Tagen, danach Forecast-Schnittstelle (an tmax erkennbar)
    split = (TODAY - timedelta(days=92)).isoformat()
    assert all(d["tmax"] == 20.0 for d in days if d["day"] < split)
    assert all(d["tmax"] == 21.0 for d in days if d["day"] >= split)
    assert [d["day"] for d in days if d["forecast"]][0] == TODAY.isoformat()
    assert sum(d["forecast"] for d in days) == 16
    urls = fake.urls()
    assert urls.count(weather.FORECAST_URL) == 1 and urls.count(weather.ARCHIVE_URL) == 1
    arch = next(p for u, p in fake.calls if u == weather.ARCHIVE_URL)
    assert (arch["start_date"], arch["end_date"]) == ("2026-01-01", (TODAY - timedelta(days=93)).isoformat())
    assert arch["timezone"] == "auto" and "et0_fao_evapotranspiration" in arch["daily"]

    # Zweiter Aufruf kurz danach: alles aus dem Speicher
    client.get("/api/weather?year=2026")
    assert len(fake.calls) == 2
    # Nach Ablauf der Frist nur die Vorhersage neu, das Archiv bleibt
    fake.clock["now"] += weather.REFRESH + timedelta(minutes=1)
    client.get("/api/weather?year=2026")
    assert fake.urls()[2:] == [weather.FORECAST_URL]


def test_past_year_only_archive_and_location_change(client, fake):
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    r = client.get("/api/weather?year=2024").json()
    assert len(r["days"]) == 366 and not any(d["forecast"] for d in r["days"])
    assert fake.urls() == [weather.ARCHIVE_URL]
    # Anderer Standort: Speicher wird verworfen
    client.patch("/api/settings", json={"weather_lat": 52.52, "weather_lon": 13.4})
    client.get("/api/weather?year=2024")
    assert fake.urls() == [weather.ARCHIVE_URL, weather.ARCHIVE_URL]
    with db.session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM weather_days").fetchone()[0] == 366


def test_garden_location_wins(client, fake):
    client.patch("/api/settings", json={"weather_lat": 52.52, "weather_lon": 13.4})
    with db.session() as conn:
        conn.execute("INSERT INTO settings(key, value) VALUES ('geo', ?)",
                     ('{"boundary": [[48.0, 11.0], [48.0002, 11.0], [48.0002, 11.0003]], "frame": {}}',))
    r = client.get("/api/weather?year=2026").json()
    assert r["location"] == {"lat": 48.0, "lon": 11.0}
    assert all(p["latitude"] == 48.0 for _, p in fake.calls)


def test_off_and_errors(client, fake):
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    client.get("/api/weather?year=2026")
    n = len(fake.calls)
    # Netz weg: gespeicherte Werte kommen trotzdem, mit Hinweis
    fake.fail = True
    fake.clock["now"] += weather.REFRESH * 2
    r = client.get("/api/weather?year=2026").json()
    assert r["status"] == "ok" and r["days"] and "nicht erreichbar" in r["error"]
    assert len(fake.calls) == n + 1
    # Abgeschaltet: keine Anfragen mehr
    assert client.patch("/api/settings", json={"weather_enabled": "0"}).status_code == 200
    r = client.get("/api/weather?year=2026").json()
    assert r["status"] == "off" and len(fake.calls) == n + 1
    assert client.patch("/api/settings", json={"weather_soil": "clay"}).status_code == 422
    assert client.get("/api/weather?year=1800").status_code == 400
    client.patch("/api/settings", json={"weather_enabled": "1"})


def test_state_not_in_backup(client, fake):
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9, "weather_soil": "loam"})
    client.get("/api/weather?year=2026")
    exported = client.get("/api/export").json()
    assert exported["settings"]["weather_soil"] == "loam"
    assert not set(weather.STATE_KEYS) & set(exported["settings"])
    assert not set(weather.STATE_KEYS) & set(client.get("/api/data").json()["settings"])


def test_real_http_error_message(monkeypatch):
    """_fetch_json übersetzt Fehlerantworten von Open-Meteo in eine lesbare Meldung."""
    import io
    import urllib.error

    def boom(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {},
                                     io.BytesIO(b'{"error": true, "reason": "Latitude must be in range"}'))

    monkeypatch.setattr(weather.urllib.request, "urlopen", boom)
    with pytest.raises(weather.WeatherError, match="Latitude must be in range"):
        weather._fetch_json("https://example.invalid/v1/forecast", {"latitude": 99})
    q = urllib.parse.urlencode({"daily": ",".join(weather.DAILY)})
    assert "precipitation_sum" in q


# ---------------------------------------------------------------- Frost

class FakeClimate:
    """Archiv mit bekannten Frostterminen: letzter Frost am (10 + i). April, erster am (1 + i). Oktober,
    i = 0..19 je nach Jahr. Ein Tag mit 1 °C liegt jeweils eine Woche nach dem letzten und vor dem ersten Frost."""

    def __init__(self, reject_model=False):
        self.calls = []
        self.reject_model = reject_model

    @staticmethod
    def offset(year):
        return year % 20

    def tmin(self, d):
        i = self.offset(d.year)
        last, first = date(d.year, 4, 10 + i), date(d.year, 10, 1 + i)
        if d <= last or d >= first:
            return -1.0 if d in (last, first) or d.month in (1, 2, 12) else 5.0
        if d in (last + timedelta(days=7), first - timedelta(days=7)):
            return 1.0
        return 8.0

    def __call__(self, url, params):
        self.calls.append(dict(params))
        if self.reject_model and "models" in params:
            raise weather.WeatherError("Open-Meteo meldet: Unknown model")
        start, end = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        return {"daily": {"time": [d.isoformat() for d in days], "temperature_2m_min": [self.tmin(d) for d in days]}}


def test_frost_stats_rule():
    springs = list(range(100, 120))           # 11. bis 30. April
    autumns = list(range(273, 293))           # 1. bis 20. Oktober
    st = weather.frost_stats(springs, autumns)
    # Median: in 10 von 20 Jahren war der letzte Frost bis dahin vorbei, "sicher": in 18 von 20
    assert st["spring_median"] == "04-20" and st["spring_safe"] == "04-28"
    assert st["spring_earliest"] == "04-11" and st["spring_latest"] == "04-30"
    # Herbst: bis zum 2. Oktober gab es nur in 2 von 20 Jahren schon Frost
    assert st["autumn_median"] == "10-10" and st["autumn_safe"] == "10-02"
    assert st["frost_free_median"] == 173
    # Jahre ohne Herbstfrost zählen als "kein Risiko"
    st2 = weather.frost_stats([100, None], [None, None])
    assert st2["autumn_median"] is None and st2["spring_median"] == "01-01"


def test_frost_endpoint(client, fake, monkeypatch):
    clim = FakeClimate(reject_model=True)
    monkeypatch.setattr(weather, "_fetch_json", clim)
    weather._climate_tries.clear()
    with db.session() as conn:
        conn.execute("DELETE FROM climate_days")
    assert client.get("/api/frost").json()["status"] == "no_location"
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    r = client.get("/api/frost").json()
    assert r["status"] == "ok" and r["error"] is None
    assert r["years"] == [2006, 2025] and r["n"] == 20 and r["threshold"] == 0
    # erst mit ERA5-Land versucht, dann ohne Modellangabe
    assert clim.calls[0]["models"] == "era5_land" and "models" not in clim.calls[1]
    assert clim.calls[1]["daily"] == "temperature_2m_min"
    assert (clim.calls[1]["start_date"], clim.calls[1]["end_date"]) == ("2006-01-01", "2025-12-31")
    y2025 = next(y for y in r["per_year"] if y["year"] == 2025)
    assert y2025 == {"year": 2025, "spring": "2025-04-15", "autumn": "2025-10-06"}
    assert r["stats"]["spring_median"] == "04-19" and r["stats"]["autumn_median"] == "10-10"
    # Zweiter Aufruf aus dem Speicher; andere Grenze ohne neuen Abruf
    n = len(clim.calls)
    r2 = client.get("/api/frost?threshold=2").json()
    assert len(clim.calls) == n
    assert next(y for y in r2["per_year"] if y["year"] == 2025)["spring"] == "2025-04-22"
    assert client.get("/api/frost?threshold=5").status_code == 400
    # Einstellung bestimmt die Grenze, wenn keine angegeben ist
    assert client.patch("/api/settings", json={"weather_frost": "2"}).status_code == 200
    assert client.get("/api/frost").json()["threshold"] == 2
    client.patch("/api/settings", json={"weather_frost": "0"})
    # Neuer Standort: Statistik wird neu geladen
    client.patch("/api/settings", json={"weather_lat": 50.0, "weather_lon": 8.0})
    client.get("/api/frost")
    assert len(clim.calls) > n
    # abgeschaltet
    client.patch("/api/settings", json={"weather_enabled": "0"})
    assert client.get("/api/frost").json()["status"] == "off"
    client.patch("/api/settings", json={"weather_enabled": "1"})


def test_frost_archive_unreachable(client, fake):
    weather._climate_tries.clear()
    with db.session() as conn:
        conn.execute("DELETE FROM climate_days")
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    fake.fail = True
    r = client.get("/api/frost").json()
    assert r["status"] == "ok" and r["stats"] == {} and "nicht erreichbar" in r["error"]
    # nicht bei jedem Aufruf erneut anfragen
    n = len(fake.calls)
    client.get("/api/frost")
    assert len(fake.calls) == n
