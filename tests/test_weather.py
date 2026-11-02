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
        self.forecast_nulls = set()   # Tage, für die die Forecast-Schnittstelle nichts liefert
        self.archive_fail = False

    def __call__(self, url, params):
        self.calls.append((url, dict(params)))
        if self.fail or (self.archive_fail and url == weather.ARCHIVE_URL):
            raise weather.WeatherError("Open-Meteo meldet: The service is overloaded", busy=True)
        if url == weather.FORECAST_URL:
            start = TODAY - timedelta(days=params["past_days"])
            end = TODAY + timedelta(days=params["forecast_days"] - 1)
        else:
            start, end = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        src = 1.0 if url == weather.FORECAST_URL else 0.0
        return {"daily": {
            "time": [d.isoformat() for d in days],
            "precipitation_sum": [None if (url == weather.FORECAST_URL and d in self.forecast_nulls)
                                  else 12.0 if d.day == 1 else 0.0 for d in days],
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
    monkeypatch.setattr(weather, "CHUNK_PAUSE", 0)
    monkeypatch.setattr(weather, "RETRY_SLEEP", 0)
    monkeypatch.setattr(weather, "_backoff_until", {})
    monkeypatch.setattr(weather, "_forecast_failed", None)
    weather._archive_tries.clear()
    weather._climate_tries.clear()
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
    assert r["status"] == "ok" and r["days"] and "overloaded" in r["error"]
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
        tmin = [self.tmin(d) for d in days]
        return {"daily": {
            "time": [d.isoformat() for d in days],
            "temperature_2m_min": tmin,
            "temperature_2m_max": [t + 10 for t in tmin],
            # Regen: jeden 3. Tag 3 mm, also rund 1 mm am Tag
            "precipitation_sum": [3.0 if d.toordinal() % 3 == 0 else 0.0 for d in days],
            "et0_fao_evapotranspiration": [2.0 if 4 <= d.month <= 9 else 0.5 for d in days],
        }}


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
    assert clim.calls[1]["daily"].split(",") == weather.CLIMATE_VARS
    # in Teilen zu fünf Jahren geladen, jeweils erst mit, dann ohne Modellangabe
    assert [(c["start_date"], c["end_date"]) for c in clim.calls[1::2]] == [
        ("2006-01-01", "2010-12-31"), ("2011-01-01", "2015-12-31"), ("2016-01-01", "2020-12-31"), ("2021-01-01", "2025-12-31")]
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
    assert r["status"] == "ok" and r["stats"] == {} and "overloaded" in r["error"]
    # nicht bei jedem Aufruf erneut anfragen
    n = len(fake.calls)
    client.get("/api/frost")
    assert len(fake.calls) == n


def test_climate_normals(client, fake, monkeypatch):
    clim = FakeClimate()
    monkeypatch.setattr(weather, "_fetch_json", clim)
    weather._climate_tries.clear()
    with db.session() as conn:
        conn.execute("DELETE FROM climate_days")
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    r = client.get("/api/climate").json()
    assert r["status"] == "ok" and r["error"] is None and r["n"] == 20
    assert len(clim.calls) == 4 and all(c["models"] == "era5_land" for c in clim.calls)
    assert len(r["daily"]["precip_cum"]) == 365 and len(r["daily"]["tmin"]) == 365
    # jeder dritte Tag 3 mm: rund 365 mm im Jahr, gut 10 Regentage im Monat
    assert 355 <= r["year_precip"] <= 375
    assert abs(r["daily"]["precip_cum"][-1] - 365) < 10
    jan, jul = r["months"][0], r["months"][6]
    assert 9.5 <= jan["rain_days"] <= 11 and jan["frost_days"] >= 29 and jul["frost_days"] == 0
    assert jul["et0"] == 62.0 and jul["tmax"] == 18.0 and jul["tmin"] == 8.0
    # Frost nutzt denselben Speicher: kein weiterer Abruf
    client.get("/api/frost")
    assert len(clim.calls) == 4


def test_smooth_wraps_year():
    vals = [0.0] * 365
    vals[0] = 15.0
    sm = weather._smooth(vals, 15)
    assert sm[0] == 1.0 and sm[364] == 1.0 and sm[7] == 1.0 and sm[8] == 0.0


def test_gaps_in_recent_days_are_filled(client, fake):
    """Liefert die Forecast-Schnittstelle für einige vergangene Tage nichts, hilft das Archiv aus."""
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    hole = {TODAY - timedelta(days=d) for d in range(40, 50)}
    fake.forecast_nulls = hole
    fake.archive_fail = True
    r = client.get("/api/weather?year=2026").json()
    a, b = min(hole).isoformat(), max(hole).isoformat()
    assert r["gaps"] == [["2026-01-01", (TODAY - timedelta(days=93)).isoformat()], [a, b]]
    assert "overloaded" in r["error"]
    # nach der Pause: das Archiv füllt beide Lücken, vorhandene Tage bleiben unverändert
    fake.archive_fail = False
    fake.clock["now"] += weather.RETRY_FAILED + timedelta(minutes=1)
    r = client.get("/api/weather?year=2026").json()
    assert r["gaps"] == [] and r["error"] is None
    arch = [p for u, p in fake.calls if u == weather.ARCHIVE_URL][-1]
    assert (arch["start_date"], arch["end_date"]) == ("2026-01-01", b)
    day = {d["day"]: d for d in r["days"]}
    assert day[a]["tmax"] == 20.0                                    # aus dem Archiv
    assert day[(TODAY - timedelta(days=30)).isoformat()]["tmax"] == 21.0  # Forecast bleibt


def test_past_year_comes_from_climate(client, fake, monkeypatch):
    clim = FakeClimate()
    monkeypatch.setattr(weather, "_fetch_json", clim)
    with db.session() as conn:
        conn.execute("DELETE FROM climate_days")
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    client.get("/api/climate")
    n = len(clim.calls)
    r = client.get("/api/weather?year=2024").json()
    assert len(r["days"]) == 366 and r["gaps"] == []
    assert len(clim.calls) == n  # kein weiterer Abruf


def test_climate_loads_in_parts_and_resumes(client, fake, monkeypatch):
    clim = FakeClimate()
    calls = []

    def flaky(url, params):
        calls.append(params["start_date"])
        if params["start_date"] == "2011-01-01" and calls.count("2011-01-01") == 1:
            raise weather.WeatherError("Open-Meteo meldet: The service is overloaded", busy=True)
        return clim(url, params)

    monkeypatch.setattr(weather, "_fetch_json", flaky)
    with db.session() as conn:
        conn.execute("DELETE FROM climate_days")
    client.patch("/api/settings", json={"weather_lat": 48.37, "weather_lon": 10.9})
    r = client.get("/api/climate").json()
    assert "overloaded" in r["error"] and calls == ["2006-01-01", "2011-01-01"]
    # kurz danach kein neuer Versuch, nach der Pause nur die fehlenden Jahre
    client.get("/api/climate")
    assert len(calls) == 2
    fake.clock["now"] += weather.RETRY_FAILED + timedelta(minutes=1)
    r = client.get("/api/climate").json()
    assert r["error"] is None and r["n"] == 20
    assert calls[2:] == ["2011-01-01", "2016-01-01", "2021-01-01"]


def test_busy_service_backs_off(monkeypatch):
    import io
    import urllib.error

    tries = []

    def overloaded(req, timeout):
        tries.append(req.full_url)
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {},
                                     io.BytesIO(b'{"error": true, "reason": "The service is overloaded"}'))

    clock = {"now": datetime(2026, 7, 15, 8, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(weather, "now", lambda: clock["now"])
    monkeypatch.setattr(weather, "RETRY_SLEEP", 0)
    monkeypatch.setattr(weather, "_backoff_until", {})
    monkeypatch.setattr(weather.urllib.request, "urlopen", overloaded)
    with pytest.raises(weather.WeatherError, match="overloaded") as exc:
        weather._fetch_json("https://example.invalid/v1/archive", {"latitude": 1})
    assert exc.value.busy and len(tries) == 2          # ein zweiter Versuch
    with pytest.raises(weather.WeatherError, match="überlastet"):
        weather._fetch_json("https://example.invalid/v1/archive", {"latitude": 1})
    assert len(tries) == 2                              # in der Pause gar nicht erst gefragt
    # der andere Server (Vorhersage) ist davon nicht betroffen
    with pytest.raises(weather.WeatherError, match="overloaded"):
        weather._fetch_json("https://other.invalid/v1/forecast", {"latitude": 1})
    assert len(tries) == 4
    clock["now"] += weather.BACKOFF + timedelta(seconds=1)
    with pytest.raises(weather.WeatherError):
        weather._fetch_json("https://example.invalid/v1/archive", {"latitude": 1})
    assert len(tries) == 6
