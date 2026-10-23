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
