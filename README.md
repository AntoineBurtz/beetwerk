# Beetwerk

Anbauplanung für den Gemüsegarten mit zwei gekoppelten Ansichten:

- **Beetkarte**: Grundstück mit maßstäblichen Beeten (wie bei GrowVeg). Beete ziehst, drehst und skalierst du direkt auf der Karte. Sätze liegen als Flächen im Beet, mit Reihen und einzelnen Pflanzen.
- **Zeitleiste**: Jede Zeile ist ein Beet, jeder Balken ein Satz mit Anzucht, Zeit im Beet und Ernte (wie bei Qrop). Balken lassen sich verschieben, verlängern und in ein anderes Beet ziehen.

Beide Ansichten hängen am **Stichtag** (das gelbe Etikett). Verschiebst du ihn in der Zeitleiste oder im Regler unter der Karte, zeigt die Karte, was an diesem Tag wo im Boden ist. Der Regler zeigt außerdem die Flächenauslastung über das Jahr.

Dazu gibt es:

- Konfliktprüfung: gleiche Fläche zur gleichen Zeit doppelt belegt wird rot markiert.
- Fruchtfolge-Prüfung: gleiche Pflanzenfamilie an gleicher Stelle innerhalb der Anbaupause (Standard 3 Jahre) wird orange markiert.
- Aufgabenliste rund um den Stichtag (vorziehen, säen, auspflanzen, abräumen) zum Abhaken.
- Bedarfsliste je Kultur und Sorte: Fläche, Reihenmeter, Pflanzen, vorzuziehende Jungpflanzen.
- Kulturenliste mit 36 Gemüsen als Startwerte (Anzucht, Kulturdauer, Abstände, Familie), frei anpassbar.
- Folgesätze mit einem Klick, Rückgängig (Strg+Z), JSON-Sicherung.
- Grundstück auf dem Luftbild: Grenze einzeichnen, Beete liegen am echten Ort, Luftbild hinter den Beeten ein- und ausblenden.
- Wetterband in der Zeitleiste: Regen, Frost und Wasserbilanz mit empfohlenen Gießtagen (Daten von Open-Meteo).
- Mischsatz: viele Sorten einer Kultur (z. B. 15 Tomatensorten zu je 4 bis 10 Pflanzen) als ein Satz, mit Sortenliste, Pflanzschema und Pflanzplan zum Herunterladen.

## Wetter und Gießen

Unter dem Kalenderkopf der Zeitleiste liegt ein Wetterband. Es bleibt beim Scrollen durch die Beete stehen und lässt sich mit „Wetter“ in der Werkzeugleiste ausblenden.

- **Regen** pro Tag als Balken (gekappt bei 20 mm). Die nächsten 16 Tage sind Vorhersage und heller hinterlegt.
- **Frost:** violette Marken oben für Tage mit Tiefstwert unter 0 °C.
- **Wasserbilanz** als Streifen: Grün = feucht, Gelb = trocknet ab, orange Marken = Gießtage.
- Überfahren oder Antippen eines Tages zeigt Regen, Temperatur, Verdunstung und Defizit. Links steht der Stand am Stichtag, z. B. „gießen in 2 Tagen“.

Die Wasserbilanz rechnet wie ein Bodenspeicher: Die Verdunstung (ET₀ nach FAO) zehrt, Regen füllt auf. Erreicht das Defizit die Schwelle, ist das ein Gießtag. Danach rechnet Beetwerk so weiter, als wäre wie empfohlen gegossen worden. Schwelle und Menge folgen dem Prinzip der Geisenheimer Bewässerungssteuerung (gießen bei 60 % der nutzbaren Feldkapazität, auffüllen auf 90 %) und hängen vom Boden ab, einstellbar unter Einstellungen → Wetter:

| Boden | Gießen ab Defizit | Menge |
|---|---|---|
| Sand | 12 mm | etwa 9 l/m² |
| lehmiger Sand | 18 mm | etwa 14 l/m² |
| Lehm oder Schluff | 24 mm | etwa 18 l/m² |

Das sind Richtwerte für 30 cm Wurzeltiefe und einen geschlossenen Bestand. Folientunnel und Gewächshaus bekommen keinen Regen, für sie gilt das Band nicht.

**Datenquelle:** Der Server holt die Tageswerte bei [Open-Meteo](https://open-meteo.com) (Lizenz CC BY 4.0) und speichert sie. Die letzten 92 Tage und die Vorhersage werden höchstens alle drei Stunden neu geladen, ältere Tage nur einmal aus dem Archiv. Als Standort dient die Mitte des Grundstücks, auf 0,01° (rund 1 km) gerundet. Ohne Grundstück auf dem Luftbild lässt sich der Standort in den Einstellungen eintragen. Für private Nutzung ist Open-Meteo kostenlos und braucht keinen Schlüssel; unter Einstellungen → Wetter lässt sich der Abruf abschalten.

## Mischsatz

Wer viele Sorten in kleinen Stückzahlen anbaut, legt dafür einen einzigen Satz an statt vieler kleiner:

1. Im Satz-Dialog „Mehrere Sorten (Mischsatz)“ ankreuzen.
2. Sorten mit Anzahl eintragen. Eingabe springt zur Anzahl, ein zweites Eingabe legt die nächste Zeile an. Eine kopierte Spalte aus Baserow oder einer Tabelle (Name, optional Tabulator oder Semikolon und Anzahl) lässt sich direkt in ein Namensfeld einfügen.
3. Reihenfolge am Griff links ändern (ziehen oder Pfeiltasten). Die Plätze im Beet rücken automatisch nach.
4. Pflanzschema wählen: **Schlange** (die Reihe entlang, am Ende eine Reihe weiter und zurück) oder **Querreihen** (je ein Platz pro Reihe, dann einen Platz weiter). In der Vorschau die Startecke antippen.

Termine und Abstände gelten für alle Sorten gemeinsam. Der Dialog zeigt, wie viele Plätze belegt oder frei sind; passt es nicht, schlägt er eine passende Länge vor.

Auf der Karte bekommt jede Sorte eine Farbe und einen Buchstaben, in der Zeitleiste bleibt es ein Balken („Tomate 15 Sorten“). Die Seitenleiste listet jede Sorte mit ihrer Lage („Reihe 1: 1–7 · Reihe 2: 9–10“) und bietet den Pflanzplan als CSV (Reihe; Platz; Kürzel; Sorte) zum Ausdrucken an. In der Bedarfsliste erscheint jede Sorte mit ihrer Stückzahl.

Jede Sorte hat neben Name und Anzahl ein freies Feld `ref` für eine spätere Verknüpfung mit einer Sortendatenbank wie Baserow.

## Grundstück auf dem Luftbild

Unter **Einstellungen → Grundstück** oder in der Seitenleiste der Karte. Die Einrichtung läuft in vier Schritten:

1. **Garten finden:** Oben nach Adresse oder Ort suchen, oder in der Karte heranzoomen. Die Karte zeigt zuerst Straßen und Orte (Webkarte Bayern bzw. OpenStreetMap); nach der Suche wechselt sie zum Luftbild. Oben rechts auf der Karte lässt sich jederzeit zwischen **Karte** und **Luftbild** umschalten, im Luftbild auch die Beschriftung **Straßen und Orte** ein- und ausblenden.
2. **Grenze zeichnen:** Die Ecken des Gartens der Reihe nach antippen, die erste Ecke noch einmal antippen schließt die Grenze. Danach lassen sich Ecken verschieben; Kantenlängen und Fläche werden angezeigt.
3. **Ausrichtung wählen:** Eine Seite des Gartens antippen (Standard: die längste) und festlegen, ob sie in der Beetkarte **unten, links, rechts oder oben** liegt. Eine Vorschau zeigt, wie die Beetkarte danach aussieht. Das **Raster** verläuft parallel zu dieser Seite und beginnt an ihrer Ecke auf vollen Metern. Alternativ: Norden oben.
4. **Übernehmen:** Der Server speichert einen Luftbild-Ausschnitt rund um die Grenze.

Danach:

- **Luftbild:** liegt in `data/imagery/`, die Karte lädt danach nichts mehr aus dem Internet. Der Schalter mit dem Ebenen-Symbol blendet das Bild ein und aus. Unter Einstellungen lässt es sich neu laden, z. B. wenn neue Befliegungen erscheinen. Ein Nordpfeil zeigt die Himmelsrichtung.
- **Beete als Anker:** Wird die Grenze später neu gezeichnet oder anders ausgerichtet, bleiben alle Beete an ihrer Stelle im Garten. Beim Drehen eines Beets rastet der Winkel parallel oder rechtwinklig zu den Grundstückskanten ein (Umschalt hält das Einrasten an).

**Quellen:**

| Quelle | Gebiet | Bedingungen |
|---|---|---|
| Luftbild Bayern (DOP 20 cm), Farbe oder Colorinfrarot | Bayern | Open Data der Bayerischen Vermessungsverwaltung, CC BY 4.0. Vorschau über den WMTS, gespeichert wird über den WMS in voller Auflösung. |
| Webkarte Bayern, Beschriftung Bayern (Straßen und Orte) | Bayern | Open Data der Bayerischen Vermessungsverwaltung (WMTS Geobasisdaten), Quellenangabe auf der Karte, nur in der Einrichtung |
| OpenStreetMap | weltweit | nur in der Einrichtung zum Zurechtfinden, wird nicht gespeichert |
| Eigene Quelle (WMS oder XYZ-Kacheln) | frei wählbar | z. B. der Orthofoto-WMS eines anderen Bundeslands; die Nutzungsbedingungen der Quelle gelten |

Google Maps ist nicht eingebaut: Es braucht einen API-Schlüssel mit hinterlegter Zahlung, und die Bilder dürfen nicht gespeichert werden. Die üblichen freien Beschriftungsebenen von CARTO verlangen seit 2026 ebenfalls einen API-Schlüssel.

Die Adresssuche nutzt Nominatim (OpenStreetMap). Gesucht wird nur, wenn du auf „Suchen“ tippst; dabei geht der Suchbegriff an nominatim.openstreetmap.org. Karten- und Luftbild-Kacheln lädt beim Einrichten der Browser direkt vom jeweiligen Dienst.

## Installation

Bei jedem Push auf `main` testet GitHub den Code und baut ein fertiges Image: `ghcr.io/antoineburtz/beetwerk:latest`. Der Server lädt nur dieses Image, gebaut wird dort nichts.

### Unraid

1. Vorlage einmalig ablegen (Terminal, `>_` oben rechts):
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-beetwerk.xml \
     https://raw.githubusercontent.com/AntoineBurtz/beetwerk/main/unraid/beetwerk.xml
   ```
   Ist das Repo privat, die Datei `unraid/beetwerk.xml` stattdessen von Hand dorthin kopieren, z. B. über die Freigabe `flash` nach `config/plugins/dockerMan/templates-user/`.
2. **Docker → Add Container**, oben bei *Template* `beetwerk` wählen, bei Bedarf Port oder Passwort anpassen, **Apply**.
3. Im Docker-Tab aufs Symbol klicken → **WebUI**.

Daten liegen in `/mnt/user/appdata/beetwerk`. Der Container gibt den Ordner automatisch an `PUID`/`PGID` (Unraid: 99/100) und läuft danach ohne root-Rechte.

**Updates:** Docker-Tab → **Check for Updates** → beim Container **apply update**. Daten bleiben erhalten.

**Privates Repo:** Dann ist auch das Image privat, und Unraid meldet beim Laden `unauthorized`. Zwei Wege:

- Image öffentlich machen: auf GitHub das Paket `beetwerk` öffnen → *Package settings* → *Danger Zone* → *Change visibility* → Public. Im Image stecken keine Gartendaten oder Passwörter. Achtung: Ein öffentliches Paket lässt sich nicht wieder auf privat stellen.
- Image privat lassen: auf GitHub einen *Personal access token (classic)* mit dem Recht `read:packages` anlegen und auf Unraid einmal `docker login ghcr.io -u <GitHub-Name>` ausführen, als Passwort den Token einfügen. Unraid speichert die Anmeldung auf dem Flash-Stick, sie bleibt nach einem Neustart erhalten.

### Andere Server mit Docker Compose

```bash
docker compose up -d
```

`docker-compose.yml` nutzt das fertige Image. Zum Bauen aus dem Quellcode dort `image:` durch `build: .` ersetzen und `docker compose up -d --build` ausführen.

### Erster Start

Danach im Browser `http://<server>:8000` öffnen. Beim ersten Start ist der Garten leer; unter **Einstellungen** (Regler-Symbol oben rechts) oder im leeren Garten selbst lässt sich ein Beispielgarten laden.

Die Datenbank ist eine SQLite-Datei (`beetwerk.db` im Datenordner). Für Backups reicht es, diese Datei zu kopieren, oder du lädst unter Einstellungen eine JSON-Sicherung herunter.

### Passwortschutz

`BEETWERK_PASSWORD` setzen, dann fragt der Browser nach Benutzer (`BEETWERK_USER`, Standard `garten`) und Passwort. Für Zugriff von außerhalb des Heimnetzes besser hinter einen Reverse Proxy mit HTTPS (z. B. Nginx Proxy Manager, Caddy, Traefik) oder per VPN/Tailscale erreichbar machen.

### Auf dem Handy

Die Oberfläche passt sich an kleine Bildschirme an (Navigation unten). Über „Zum Startbildschirm hinzufügen“ läuft sie wie eine App.

- Karte: ein Finger verschiebt, zwei Finger zoomen. Kultur antippen, dann aufs Beet tippen. Doppelt tippen öffnet den Dialog.
- Zeitleiste: Balken antippen öffnet den Dialog. Ziehen von Balken geht mit Maus oder Stift.

## Ohne Docker

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
BEETWERK_DATA=./data uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Bedienung in Kürze

| Wo | Was |
|---|---|
| Karte | Beet anklicken und ziehen verschiebt es (10-cm-Raster). Griffe rechts und unten ändern die Größe, der runde Griff oben dreht (15°-Schritte, mit Umschalt 1°). |
| Karte | Kultur aus der Seitenleiste auf ein Beet ziehen legt einen Satz an. Termine werden aus den Kulturdaten so berechnet, dass der Satz am Stichtag ins Beet kommt. |
| Karte | Satz anklicken und ziehen verschiebt ihn im Beet, die vier Griffe ändern Länge und Breite. Pfeiltasten verschieben um 10 cm (mit Umschalt 1 m), Entf löscht, Eingabe öffnet den Dialog. |
| Karte | Gestrichelte Flächen: Sätze, die in den nächsten drei Wochen ins Beet kommen. Jungpflanzen in Anzucht stehen in der Seitenleiste. |
| Karte | Ebenen-Symbol links blendet das Luftbild ein oder aus. Darunter zeigt der Pfeil nach Norden. |
| Karte | **+** unten rechts: Art der Fläche wählen (Beet, Hochbeet, Gewächshaus, Weg, Sonstiges) und auf der Karte aufziehen; Antippen legt eine Fläche in Standardgröße an. Mehrere nacheinander möglich, „Fertig“ beendet. |
| Karte | Sätze ohne Beet (z. B. aus der Zeitleiste ohne Beet angelegt) zeigt ein Hinweis oben rechts. In der Seitenleiste lassen sie sich auf ein Beet ziehen oder antippen und dann aufs Beet tippen. |
| Zeitleiste | Balken waagerecht ziehen verschiebt alle Termine, senkrecht in eine andere Zeile wechselt das Beet. Rechte Kante ändert das Ernteende, linke Kante den Aussaattermin. |
| Zeitleiste | Klick auf eine freie Stelle legt dort einen neuen Satz an. Klick in den Kopf setzt den Stichtag. |
| Zeitleiste | Klick auf den Beetnamen links öffnet rechts die Eigenschaften des Beets (Name, Art, Länge, Breite, Notizen) zum direkten Bearbeiten, dazu Belegung und Fruchtfolge. Esc oder × schließt. |
| Überall | `[` und `]` springen eine Woche zurück oder vor, Strg+Z macht die letzte Änderung rückgängig. |

### Begriffe

- **Satz**: eine Pflanzung einer Kultur und Sorte an einer Stelle, mit Aussaat, ggf. Pflanzung, Erntebeginn und Ernteende.
- **Bis zur Ernte** (Kultur): Tage ab Pflanzung, bei Direktsaat ab Aussaat.
- **Breite leer** im Satz heißt: reicht bis zum Beetrand.
- **Reihen leer** heißt: automatisch berechnet. Reihen laufen immer entlang der längeren Seite der Fläche (ein 1 × 20 m Beet mit 50 × 50 cm hat 2 Reihen à 40 Pflanzen).
- **Reihe und Platz** im Mischsatz werden ab der gewählten Startecke gezählt.

## Schnittstelle

Die REST-API ist unter `/api/docs` dokumentiert. Wichtige Endpunkte:

- `GET /api/data` liefert Einstellungen, Beete, Kulturen und Sätze.
- `POST/PATCH/DELETE /api/beds`, `/api/crops`, `/api/plantings`
- `GET /api/export`, `POST /api/import` für JSON-Sicherungen
- `POST /api/demo?replace=true` lädt den Beispielgarten
- `GET /api/weather?year=2026` liefert die gespeicherten Tageswerte (Niederschlag, Tiefst- und Höchsttemperatur, ET₀, Vorhersage ja/nein) und lädt bei Bedarf nach

Ein Mischsatz trägt `varieties` (Liste aus `{"name", "count", "ref"}`), `fill` (`snake` oder `columns`) und `fill_start` (`tl`, `tr`, `bl`, `br`). Eine leere Liste macht ihn wieder zum normalen Satz mit `variety`.

Damit lässt sich z. B. aus Home Assistant oder einem Skript abfragen, was diese Woche zu säen ist, oder eine Sortenliste aus Baserow übernehmen.

## Entwicklung

```bash
pip install -r requirements.txt pytest httpx
pytest -q
BEETWERK_DATA=./data uvicorn app.main:app --reload
```

Ablauf für neue Funktionen: Änderung auf einem Branch, Pull Request, GitHub führt die Tests aus. Nach dem Mergen in `main` entsteht automatisch ein neues Image, das Unraid als Update anbietet. Jede Version ist zusätzlich unter ihrem Commit-Kürzel verfügbar (`ghcr.io/antoineburtz/beetwerk:sha-1a2b3c4`), damit lässt sich notfalls auf einen älteren Stand zurückgehen.

Aufbau:

- `app/main.py`: FastAPI-Server und REST-API
- `app/db.py`: SQLite-Schema
- `app/seed.py`: Kulturen und Beispielgarten
- `app/geo.py`: Koordinaten zwischen Grundstück und Erde, Luftbild-Abruf
- `app/static/`: Oberfläche ohne Build-Schritt, reines JavaScript mit ES-Modulen (`map.js` Beetkarte, `timeline.js` Zeitleiste, `plantings.js` Sätze und Aufgaben, `editor.js` Dialoge, `geosetup.js` Grundstück auf dem Luftbild, `store.js` Zustand und Rückgängig)
- `docker-entrypoint.py`: übergibt den Datenordner an PUID/PGID und startet ohne root
- `unraid/beetwerk.xml`: Vorlage für Unraid
- `.github/workflows/image.yml`: Tests und Image-Build

Schrift: Barlow (SIL Open Font License) und Kartenbibliothek Leaflet 1.9.4 (BSD-2-Clause) sind lokal eingebunden, damit die Oberfläche ohne Internet läuft.

Für Tests mit Luftbild gibt es einen kleinen Fake-Kartendienst: `python tests/fakemap.py 8790` liefert unter `http://127.0.0.1:8790/wms` (Layer beliebig) bzw. `/tiles/{z}/{x}/{y}.jpg` ein künstliches Grundstück bei 48,0° N / 11,0° O, dazu `/map/…` als Straßenkarte und `/label/…` als Beschriftung.
