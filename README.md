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
- Wetter-Seite mit Diagrammen und Monatstabelle, jeweils im Vergleich zum Mittel der letzten 20 Jahre.
- Mischsatz: viele Sorten einer Kultur (z. B. 15 Tomatensorten zu je 4 bis 10 Pflanzen) als ein Satz, mit Sortenliste, Pflanzschema und Pflanzplan zum Herunterladen.
- Bonitur: Pflanzen einzeln oder als Block bewerten, mit BBCH-Bildern, Merkmalen nach UPOV für Tomate und Paprika/Chili, Sortenvergleich und CSV-Export.

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

### Wetter-Seite

Der Reiter „Wetter“ zeigt das Jahr des Stichtags (mit „‹ 2025“ und „2027 ›“ umschaltbar), jeweils mit dem Mittel der letzten 20 Jahre als Vergleich:

- **Kennzahlen:** Regen seit 1. Januar und in den letzten 30 Tagen, nächster Gießtag, Frost (laut Vorhersage oder bisher).
- **Niederschlag seit 1. Januar:** aufsummiert, dieses Jahr gegen das Mittel; die Vorhersage gestrichelt.
- **Niederschlag je Monat:** Säulen für dieses Jahr, graue Striche für das Mittel.
- **Temperatur:** Tiefst bis Höchst je Tag, Frost violett, das Mittel als graues Band.
- **Bodenwasser-Defizit:** Verlauf der Wasserbilanz mit Gießschwelle und Gießtagen.
- **Monatswerte:** Regen, Abweichung, Regentage, mittlere Höchst- und Tiefstwerte, Frosttage, Verdunstung und Gießtage, in Klammern das Mittel.
- **Die nächsten Tage:** die 16 Tage Vorhersage mit Hinweisen auf Frost, Gießtage und viel Regen.
- **Frostfreie Zeit je Jahr:** für jedes der letzten 20 Jahre die Spanne vom letzten bis zum ersten Frost, dazu das laufende Jahr.

Alle Diagramme zeigen beim Überfahren oder Antippen die Werte des Tages; die drei Tagesdiagramme folgen dabei gemeinsam.

### Frosttermine

Aus den Tiefstwerten der letzten 20 abgeschlossenen Jahre an deinem Standort ermittelt Beetwerk je Jahr den letzten Frost im Frühjahr (bis Ende Juli) und den ersten im Herbst (ab August). Daraus entsteht eine Statistik, keine Wettervorhersage:

- In der Zeitleiste liegt hinter den Beeten eine violette Schattierung. Je kräftiger sie ist, in desto mehr Jahren gab es an diesem Tag oder später (Frühjahr) bzw. bis zu diesem Tag (Herbst) Frost. Die gestrichelten Linien markieren die mittleren Termine; im Wetterband stehen sie als „Ø letzter Frost“ und „Ø erster Frost“.
- Überfahren oder Antippen eines Tages zeigt z. B. „Frost an diesem Tag oder später noch in 3 von 20 Jahren“, auch für kommende Jahre.
- Unter Einstellungen → Wetter steht die Zusammenfassung, etwa „in 18 von 20 Jahren bis 7. Mai vorbei“. Dort lässt sich auch die Frostgrenze wählen: 0 °C, +2 °C (vorsichtig, Bodenfrost möglich) oder −2 °C.

Die Werte stammen aus der Reanalyse ERA5-Land (rund 9 km Raster, 2 m Höhe) über das Open-Meteo-Archiv: Tiefst- und Höchstwerte, Niederschlag und Verdunstung der letzten 20 Jahre, einmal geladen und gespeichert (nach Open-Meteos Rechnung rund 200 Aufrufe von 10.000 am Tag). In Senken und direkt über dem Boden ist es in klaren Nächten oft kälter, dafür ist die Einstellung +2 °C gedacht.

**Datenquelle:** Der Server holt die Tageswerte bei [Open-Meteo](https://open-meteo.com) (Lizenz CC BY 4.0) und speichert sie. Die letzten 92 Tage und die Vorhersage werden höchstens alle drei Stunden neu geladen, ältere Tage nur einmal aus dem Archiv. Als Standort dient die Mitte des Grundstücks, auf 0,01° (rund 1 km) gerundet. Ohne Grundstück auf dem Luftbild lässt sich der Standort in den Einstellungen eintragen. Für private Nutzung ist Open-Meteo kostenlos und braucht keinen Schlüssel; unter Einstellungen → Wetter lässt sich der Abruf abschalten.

Beetwerk fragt Open-Meteo nacheinander statt gleichzeitig an und lädt die 20 Vergleichsjahre in Teilen zu fünf Jahren. Meldet der Dienst Überlastung, wartet Beetwerk zehn Minuten und versucht es dann erneut; bis dahin gelten die gespeicherten Werte. Vergangene Jahre kommen aus den gespeicherten Vergleichsdaten. Fehlen für einzelne vergangene Tage Werte, holt Beetwerk sie aus dem Archiv nach; die Wetter-Seite nennt fehlende Tage.

## Mischsatz

Wer viele Sorten in kleinen Stückzahlen anbaut, legt dafür einen einzigen Satz an statt vieler kleiner:

1. Im Satz-Dialog „Mehrere Sorten (Mischsatz)“ ankreuzen.
2. Sorten mit Anzahl eintragen. Eingabe springt zur Anzahl, ein zweites Eingabe legt die nächste Zeile an. Eine kopierte Spalte aus Baserow oder einer Tabelle (Name, optional Tabulator oder Semikolon und Anzahl) lässt sich direkt in ein Namensfeld einfügen.
3. Reihenfolge am Griff links ändern (ziehen oder Pfeiltasten). Die Plätze im Beet rücken automatisch nach.
4. Pflanzschema wählen: **Schlange** (die Reihe entlang, am Ende eine Reihe weiter und zurück) oder **Querreihen** (je ein Platz pro Reihe, dann einen Platz weiter). In der Vorschau die Startecke antippen.

Termine und Abstände gelten für alle Sorten gemeinsam. Der Dialog zeigt, wie viele Plätze belegt oder frei sind; passt es nicht, schlägt er eine passende Länge vor.

Auf der Karte bekommt jede Sorte eine Farbe und einen Buchstaben, in der Zeitleiste bleibt es ein Balken („Tomate 15 Sorten“). Die Seitenleiste listet jede Sorte mit ihrer Lage („Reihe 1: 1–7 · Reihe 2: 9–10“) und bietet den Pflanzplan als CSV (Reihe; Platz; Kürzel; Sorte) zum Ausdrucken an. In der Bedarfsliste erscheint jede Sorte mit ihrer Stückzahl.

Jede Sorte hat neben Name und Anzahl ein freies Feld `ref` für eine spätere Verknüpfung mit einer Sortendatenbank wie Baserow.

## Bonitur

Der Reiter **Bonitur** ist fürs Handy im Beet gedacht. Bonitiert wird an einem eigenen Datum (oben, Standard heute), unabhängig vom Stichtag der Planung.

1. **Satz wählen.** Die Liste zeigt die Sätze des Jahres; Tomaten, Paprika und Chili stehen vorne. Welche Kultur welche Merkmale bekommt, steht im Kultur-Dialog unter „Bonitur-Merkmale“ (Tomate, Paprika und Chili oder nur allgemeine). Aus der Karte führt „Bonitieren“ in der Seitenleiste direkt hierher.
2. **Pflanzen festlegen.** Beim ersten Öffnen übernimmt Beetwerk den Pflanzplan und gibt jeder Pflanze eine feste Nummer mit Sorte, Reihe und Platz. Danach ändert ein Umsortieren der Sorten nichts mehr an der Zuordnung. Unter „Pflanzen“ trägst du die Etiketten-IDs ein (einzeln oder als kopierte Spalte), fügst Pflanzen hinzu oder markierst ausgefallene.
3. **Was bonitierst du?** Einzelne Pflanzen im Raster antippen oder als Block wählen (alle, eine Sorte, eine Reihe). Für Merkmale, die zur Sorte gehören, auf „Ganze Sorte“ umschalten.
4. **Merkmale** einzeln wählen oder als Vorlage („Rundgang“, „Ernte“, „Fruchtmerkmale“, „Verkostung“, „Saatgut“; eigene Auswahl lässt sich als Vorlage speichern). „Jetzt fällig“ wählt die einmaligen Merkmale, deren Zeitpunkt nach dem zuletzt erfassten BBCH-Stadium gekommen ist und die noch fehlen.
5. **Werte eingeben.** „Ein Wert für alle“ speichert denselben Wert für jede gewählte Pflanze. „Pflanze für Pflanze“ geht mit „Speichern und weiter“ durch die Auswahl; die Werte der vorigen Pflanze sind vorbelegt, die aktuelle Pflanze ist im Raster gelb umrandet.

Regelmäßige Merkmale (BBCH, Höhe, Wuchskraft, Befall, Ernte) sammeln einen Verlauf, ein zweiter Wert am selben Tag ersetzt den ersten. Einmalige Merkmale gelten als erledigt, sobald ein Wert da ist, und bleiben änderbar. Fruchtgewicht und -maße lassen sich als Einzelwerte eingeben; Beetwerk speichert das Mittel und die Einzelwerte. Fotos werden vor dem Hochladen verkleinert und im Datenordner unter `photos/` abgelegt.

Die **Übersicht** zeigt je Pflanze das aktuelle Stadium, Höhe, Blüh- und Reifebeginn (erster Tag mit BBCH 61 bzw. 81), Ernte und wie viele einmalige Merkmale erfasst sind; ein Klick öffnet den Verlauf zum Ändern und Löschen. „Sorten vergleichen“ stellt die Sorten nebeneinander: Blüh- und Reifebeginn in Tagen ab Pflanzung, Ertrag je Pflanze, mittleres Fruchtgewicht, Anteil aussortierter Früchte und alle einmaligen Merkmale. „CSV“ lädt alle Werte des Jahres als Tabelle (Semikolon, Dezimalkomma) herunter, je Wert eine Zeile.

Unter **Merkmale** lassen sich Merkmale ausschalten, eigene anlegen und Vorlagen löschen. Die eingebauten Merkmale folgen den UPOV-Prüfrichtlinien TG/44 (Tomate) und TG/76 (Paprika), ergänzt um Verkostung sowie Kreuzung und Saatgut.

Die BBCH-Zeichnungen liegen im Original unter `assets/bbch/<kultur>/` (Dateiname mit `BBCH<code>`, z. B. `SoLy-BBCH61.png`). `python tools/bbch_images.py` erzeugt daraus kleine WebP-Bilder für die App. Für Paprika und Chili gelten die Tomatenbilder, bis ein Ordner `assets/bbch/paprika/` dazukommt.

Jede Pflanze, jedes Merkmal und jeder Wert hat eine feste Nummer, Werte zusätzlich Zeitstempel für Änderungen (`updated_at`, `synced_at`). Darauf baut der spätere Abgleich mit Baserow auf.

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

Die Datenbank ist eine SQLite-Datei (`beetwerk.db` im Datenordner). Für Backups reicht es, diese Datei zu kopieren, oder du lädst unter Einstellungen eine JSON-Sicherung herunter. Die JSON-Sicherung enthält auch Pflanzen und Boniturwerte, aber keine Fotos; die liegen im Datenordner unter `photos/`.

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
- `GET /api/climate` liefert die Mittelwerte der letzten 20 Jahre je Tag (geglättet) und je Monat
- `GET /api/frost?threshold=0` liefert je Jahr den letzten und ersten Frosttag der letzten 20 Jahre samt Statistik
- `GET /api/weather?year=2026` liefert die gespeicherten Tageswerte (Niederschlag, Tiefst- und Höchsttemperatur, ET₀, Vorhersage ja/nein) und lädt bei Bedarf nach

Bonitur:

- `GET /api/bonitur?year=2026` liefert Merkmale, Vorlagen sowie Pflanzen und Werte der Sätze des Jahres
- `POST /api/plantings/{id}/plants` legt die Pflanzen eines Satzes fest, `POST/PATCH/DELETE /api/plants`, `PUT /api/plantings/{id}/labels` für Etiketten
- `POST /api/observations` speichert Werte (`{"entries": [{"trait_id", "planting_id", "plant_id" oder "variety", "date", "value"}]}`), `PATCH/DELETE /api/observations/{id}`
- `POST /api/photos` (Bild als Rohdaten), `GET /api/photos/{name}`
- `GET /api/bonitur.csv?year=2026`
- `POST/PATCH/DELETE /api/traits` und `/api/trait-sets` für eigene Merkmale und Vorlagen

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
- `app/bonitur.py`: Merkmalkatalog, Einzelpflanzen, Boniturwerte, Fotos und CSV
- `app/static/`: Oberfläche ohne Build-Schritt, reines JavaScript mit ES-Modulen (`map.js` Beetkarte, `timeline.js` Zeitleiste, `plantings.js` Sätze und Aufgaben, `editor.js` Dialoge, `geosetup.js` Grundstück auf dem Luftbild, `bonitur.js` Bonitur mit `bstore.js` und `bwidgets.js`, `store.js` Zustand und Rückgängig)
- `docker-entrypoint.py`: übergibt den Datenordner an PUID/PGID und startet ohne root
- `unraid/beetwerk.xml`: Vorlage für Unraid
- `.github/workflows/image.yml`: Tests und Image-Build

Schrift: Barlow (SIL Open Font License) und Kartenbibliothek Leaflet 1.9.4 (BSD-2-Clause) sind lokal eingebunden, damit die Oberfläche ohne Internet läuft.

Für Tests mit Luftbild gibt es einen kleinen Fake-Kartendienst: `python tests/fakemap.py 8790` liefert unter `http://127.0.0.1:8790/wms` (Layer beliebig) bzw. `/tiles/{z}/{x}/{y}.jpg` ein künstliches Grundstück bei 48,0° N / 11,0° O, dazu `/map/…` als Straßenkarte und `/label/…` als Beschriftung.
