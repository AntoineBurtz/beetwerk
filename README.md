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
| Überall | `[` und `]` springen eine Woche zurück oder vor, Strg+Z macht die letzte Änderung rückgängig. |

### Begriffe

- **Satz**: eine Pflanzung einer Kultur und Sorte an einer Stelle, mit Aussaat, ggf. Pflanzung, Erntebeginn und Ernteende.
- **Bis zur Ernte** (Kultur): Tage ab Pflanzung, bei Direktsaat ab Aussaat.
- **Breite leer** im Satz heißt: reicht bis zum Beetrand.
- **Reihen leer** heißt: aus Breite und Reihenabstand berechnet.

## Schnittstelle

Die REST-API ist unter `/api/docs` dokumentiert. Wichtige Endpunkte:

- `GET /api/data` liefert Einstellungen, Beete, Kulturen und Sätze.
- `POST/PATCH/DELETE /api/beds`, `/api/crops`, `/api/plantings`
- `GET /api/export`, `POST /api/import` für JSON-Sicherungen
- `POST /api/demo?replace=true` lädt den Beispielgarten

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
