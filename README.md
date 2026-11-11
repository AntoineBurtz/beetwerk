# Beetwerk

Selbst gehostete Anbauplanung für den Gemüsegarten. Zwei Ansichten hängen am selben **Stichtag**: die maßstäbliche **Beetkarte** zeigt, was an diesem Tag wo im Boden ist, die **Zeitleiste** zeigt jedes Beet übers Jahr. Dazu kommen Anzucht, satzweiser Anbau, Düngung, Wetter, Bonitur und eine Sortenliste. Die Oberfläche ist deutsch und läuft auch auf dem Handy.

## Installation

Bei jedem Push auf `main` testet GitHub den Code und baut das Image `ghcr.io/antoineburtz/beetwerk:latest`. Der Server lädt nur dieses Image.

**Unraid**

1. Vorlage ablegen (Terminal):
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-beetwerk.xml \
     https://raw.githubusercontent.com/AntoineBurtz/beetwerk/main/unraid/beetwerk.xml
   ```
2. **Docker → Add Container**, Template `beetwerk` wählen, bei Bedarf Port und Passwort anpassen, **Apply**.
3. Im Docker-Tab aufs Symbol klicken → **WebUI**.

Update: Docker-Tab → **Check for Updates** → **apply update**. Die Daten liegen in `/mnt/user/appdata/beetwerk` und bleiben erhalten.

**Docker Compose** (andere Server): `docker compose up -d`, danach `http://<server>:8000`. Zum Bauen aus dem Quellcode in `docker-compose.yml` `image:` durch `build: .` ersetzen.

**Ohne Docker**

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
BEETWERK_DATA=./data uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Einstellungen des Containers**

| Variable | Bedeutung |
|---|---|
| `BEETWERK_PASSWORD`, `BEETWERK_USER` | Passwortschutz (HTTP Basic Auth). Leer = kein Schutz, Benutzer ist sonst `garten`. Von außerhalb des Heimnetzes nur hinter HTTPS oder VPN nutzen. |
| `PUID`, `PGID` | Wem der Datenordner gehört (Unraid: 99 und 100). Der Container läuft danach ohne root. |
| `TZ` | Zeitzone, Standard `Europe/Berlin` |
| `BEETWERK_BASEROW_DELAY` | Sekunden bis zum Abgleich nach einer Änderung (Standard 15, `0` = nur von Hand) |

**Erster Start:** Der Garten ist leer. Beetwerk fragt, ob alle Beete gleich breit sind, und bietet einen Beispielgarten an. Alles Weitere steht unter **Einstellungen** (Regler-Symbol oben rechts).

**Sicherung:** Die Datenbank ist `beetwerk.db` im Datenordner; Fotos liegen in `photos/`, das Luftbild in `imagery/`. Unter Einstellungen gibt es zusätzlich eine JSON-Sicherung zum Herunterladen und Einspielen (ohne Fotos, ohne Zugangsdaten).

## Die Seiten

| Seite | Wofür |
|---|---|
| **Karte** | Beete aufziehen, verschieben, drehen. Kulturen aus der Seitenleiste aufs Beet ziehen. Zeigt Sätze als Flächen mit Reihen und Pflanzen. |
| **Zeitleiste** | Eine Zeile je Beet, ein Balken je Satz (Anzucht, Zeit im Beet, Ernte). Reicht 1, 1½ oder 2 Jahre. Mit Wetterband und Frostschattierung. |
| **Sätze** | Liste aller Sätze nach Jahr, Aufgaben rund um den Stichtag zum Abhaken, Bedarf je Kultur und Sorte. |
| **Anzucht** | Wochenplan: aussäen, pikieren, abhärten, auspflanzen, an Freunde abgeben. |
| **Kulturen** | Kulturen mit Dauer, Abständen, Düngung und Anzucht; darunter die Sortenliste. |
| **Wetter** | Regen, Temperatur, Bodenwasser und Frost im Vergleich zu den letzten 20 Jahren. |
| **Bonitur** | Pflanzen im Beet bewerten, fürs Handy gebaut. |

Überall gilt: Ein Klick zeigt erst eine **Übersicht** zum Lesen, geändert wird nach „Bearbeiten“. Unterstrichene Namen führen zur Übersicht von Kultur, Sorte, Beet oder Satz.

## Mechaniken

### Satz, Termine und Anbauart

- Ein **Satz** ist eine Pflanzung einer Kultur an einer Stelle: Aussaat, ggf. Pflanzung, Erntebeginn, Ernteende, dazu Start, Länge und Breite im Beet.
- Die Termine kommen aus der Kultur (Anzuchtdauer, Tage bis zur Ernte, Erntedauer). Ein neuer Satz kommt am Stichtag ins Beet. „Tage bis zur Ernte“ zählen ab Pflanzung, bei Direktsaat ab Aussaat.
- **Direktsaat oder Voranzucht:** Jede Kultur hat eine übliche Anbauart und per Haken auch die andere, mit eigenen Tagen bis zur Ernte und eigenen Abständen. Leere Tage werden geschätzt: Direktsaat statt Voranzucht = Tage im Beet + Anzuchtdauer − 7; Voranzucht statt Direktsaat = Tage im Beet − Anzuchtdauer + 7 (mindestens 14, ohne Anzuchtdauer 28 Tage Anzucht). Das ist eine Faustregel dieses Programms; die Oberfläche kennzeichnet sie als geschätzt.
- Wechselst du im Satz die Anbauart, bleibt der Tag im Beet stehen und die übrigen Termine rechnen neu.
- **Folgesatz** legt eine Kopie 14 Tage später an. Strg+Z macht die letzte Änderung rückgängig.

### Reihen, Abstände und Pflanzenzahl

- Reihen laufen immer **in Beetrichtung**, also entlang der langen Beetseite, auch wenn ein Satz nur ein kurzes Stück belegt.
- Pflanzen = Reihen × Plätze je Reihe. Reihen = Breite ÷ Reihenabstand, Plätze = Länge ÷ Pflanzabstand, jeweils abgerundet. Ein 1 × 20 m Beet mit 50 × 50 cm hat 2 Reihen à 40 Pflanzen.
- Abstände gelten in dieser Reihenfolge: eigene Angabe im Satz, sonst das Raster der Folie, sonst die Kultur in der Anbauart des Satzes. „Breite leer“ heißt bis zum Beetrand, „Reihen leer“ heißt automatisch.
- **Gleich breite Beete** (Einstellungen → Beete): Jedes neue Beet bekommt die feste Breite, auf der Karte ziehst du nur die Länge. Gilt für die Art „Beet“, nicht für Hochbeet, Gewächshaus und Weg.

### Folien und Pflanzraster

Für Gewebe- oder Mulchfolie mit Löchern. Eine **Vorlage** hat Reihen im Beet, Reihenabstand und Abstand in der Reihe. Angelegt sind drei Beispiele zum Ändern: 20 × 20 cm (3 Reihen), 40 × 40 cm (2 Reihen), 50 × 50 cm (1 Reihe).

- **Vorlagen** stehen unter Einstellungen → Folien und Pflanzraster. Im Dialog einer Vorlage hakst du die Beete an, auf denen sie liegt; im Dialog eines Beets lässt sich die Folie ebenfalls wählen.
- Liegt eine Folie auf dem Beet, rechnen **alle Sätze dort mit ihrem Raster** statt mit den Abständen der Kultur: Pflanzenzahl, Anzucht, satzweiser Anbau, Abgleich mit Baserow. Auf einem 0,8 m breiten Beet hat ein 2 m langer Satz Kopfsalat mit der 20er-Folie 3 Reihen à 10 = 30 Pflanzen.
- Die Reihen liegen mittig im Beet (bei 3 Reihen mit 20 cm auf 80 cm Breite: 20, 40 und 60 cm). Die Karte zeichnet sie dort. Ein Satz über einen Teil der Breite bekommt die Reihen, die in seinem Streifen liegen.
- **Kulturen, die nicht ins Raster passen**, behalten ihre eigenen Abstände: Haken „passt ins Raster einer Lochfolie“ im Dialog der Kultur. Voreingestellt ist er für alle Kulturen ab 15 cm Abstand in der Reihe, also nicht für Radieschen, Möhre, Pastinake, Rote Bete, Zwiebel, Spinat, Feldsalat, Rucola, Erbse, Bohnen, Petersilie und Kerbel.
- **Je Satz** lässt sich das Raster abweichend wählen (Feld „Pflanzraster“): wie das Beet, ohne Folie oder eine andere Vorlage – etwa wenn im Lauf des Jahres die Folie gewechselt wird.
- Bekommt ein Beet eine andere Folie, behalten **abgeerntete Sätze** ihr bisheriges Raster. Wird eine Vorlage gelöscht, bekommen sie es als eigene Abstände.
- Beetwerk prüft nicht, ob das Raster für eine Kultur zu eng ist. Der Dialog des Satzes zeigt Raster und Abstand der Kultur nebeneinander.

### Karte: jetzt, geplant, abgeerntet

- Die Karte zeigt auf jeder Stelle nur eines: was am Stichtag dort steht, sonst was als Nächstes kommt, sonst was dort zuletzt stand.
- **Im Beet:** farbige Fläche mit Pflanzen. **Geplant** (bis gut ein Jahr voraus): abgesteckter Rahmen mit Saatrillen und „ab …“. **Abgeerntet** (im Jahr des Stichtags): Stoppeln mit „bis …“.
- Geplante und abgeerntete Flächen lassen sich antippen; die Seitenleiste nennt unter „Davor“ und „Danach“, was auf derselben Stelle steht.
- **Schloss** (links unter den Zoom-Knöpfen): sperrt alle Beete. Ziehen verschiebt dann nur den Ausschnitt; Sätze lassen sich nach dem Antippen weiter verschieben.
- **Konflikt** (rot): gleiche Fläche zur gleichen Zeit doppelt belegt. **Fruchtfolge** (orange): gleiche Pflanzenfamilie an gleicher Stelle innerhalb der Anbaupause (Standard 3 Jahre, 0 schaltet ab).
- Der Regler unter der Karte zeigt die Flächenauslastung übers Jahr.

### Mischsatz

Viele Sorten in kleinen Stückzahlen als ein Satz (z. B. 15 Tomatensorten): Sorten mit Anzahl eintragen oder als Spalte einfügen, Reihenfolge ziehen, Pflanzschema wählen (**Schlange** oder **Querreihen**) und die Startecke antippen. Die Karte gibt jeder Sorte Farbe und Buchstaben, die Seitenleiste nennt die Lage („Reihe 1: 1–7“) und bietet den Pflanzplan als CSV.

### Satzweiser Anbau

Für alles, was laufend geerntet wird. Du gibst Kultur, Erntezeitraum und **Menge je Woche** an („6 Köpfe Kopfsalat von KW 20 bis KW 41“, einzelne Wochen abweichend, 0 im Urlaub). Beetwerk rechnet rückwärts:

- **Abstand der Sätze** = Erntefenster je Satz (Standard: Erntedauer der Kultur).
- **Pflanzen je Satz** = Erntemenge bis zum nächsten Satz ÷ Ertrag je Pflanze. Wochen mit 0 bekommen keinen Satz.
- **Termine:** so, dass die Kultur zum Erntebeginn fertig ist. Mit „Kulturdauer an die Jahreszeit anpassen“ zählt Beetwerk die Wärmesumme aus den Wetterdaten deines Gartens: Die Kulturdauer gilt für eine Pflanzung Anfang Mai (wärmeliebende Anfang Juni), im Frühjahr und Herbst dauert es länger.
- **Block auf einem Beet:** Jeder Satz ist ein Streifen über die Beetbreite, gerade so lang, wie seine Pflanzen brauchen. Ein neuer Satz kommt auf den Streifen, der gerade abgeerntet ist. Das Beet-Feld zeigt für jedes Beet, wie viel Länge die Folge braucht und ob die Fruchtfolge stört; der Beetplan zeigt den Block über die Zeit.
- **Ändern** rechnet alle noch nicht begonnenen Sätze neu. Gesäte, gepflanzte und bonitierte Sätze bleiben, wie sie sind.
- In der Zeitleiste steht die Folge als ein Balken, auf der Karte vor ihrem Beginn als eine geplante Fläche.

### Anzucht

Aus allen Sätzen mit Voranzucht entsteht der Wochenplan. Eine **Anzucht** fasst zusammen, was von einer Kultur und Sorte am selben Tag gesät wird.

- **Rechnung:** Bedarf (Beete + Freunde) plus Reserve der Kultur (Standard 20 %) ergibt die Jungpflanzen, die Keimrate daraus die Körner. Bei Zellen und Töpfen so viele, dass in genug Zellen mindestens ein Korn aufgeht.
- **Je Kultur:** Aussaatgefäß, Pikieren (Gefäß und nach wie vielen Tagen), Körner je Zelle, Keimrate, Reserve, Abhärten, Wärme, Anzuchtplatz. Richtwerte sind hinterlegt.
- **Plätze und Belegung:** Anzuchtplätze in Plattenplätzen (etwa 30 × 50 cm); zu volle Wochen stehen rot im Wochenplan.
- **Freunde:** Wünsche mit Anzahl und Abholtermin laufen in der passenden Anzucht mit oder bekommen eine eigene.
- „Gesät“ und „Ausgepflanzt“ übertragen sich auf die Sätze. Unter „Stand eintragen“ hältst du fest, was wirklich gesät wurde.

### Düngung

Beetwerk rechnet je Satz den Stickstoff und die Termine. Phosphat, Kali und Kalk rechnet es nicht.

| Stufe | Stickstoff | Beispiele |
|---|---|---|
| keine | – | genügsame Kräuter (Dill, Thymian, Salbei …): Kompost genügt |
| gering | 6,5 g/m² | Salate, Spinat, Radies, Möhre, Rote Bete, Zwiebel, Erbse, Bohne, Gurke |
| mittel | 13 g/m² | Tomate, Sellerie, Kohlrabi, Lauch, Kohlarten |
| hoch | 19,5 g/m² | frei wählbar |

- **Menge** = Stufe × Fläche × Anpassung (Einstellungen: 100 bis 25 % für humusreiche Böden), umgerechnet auf deinen Dünger aus der Düngerliste.
- **Termine:** Langsam wirkender Dünger (Horn, organisch) kommt zur Saat oder Pflanzung, bei „hoch“ zur Hälfte gut 3 Wochen später. Schnell wirkender kommt in Teilgaben: gering 1 Woche nach der Pflanzung bzw. 2 nach der Saat, mittel zur Pflanzung und nach 3 Wochen, hoch zur Pflanzung, nach 3 und nach 5 Wochen.
- **Sonderregeln:** Langsam auflaufende Saaten bekommen schnellen Dünger erst nach 3 bis 4 Wochen. Feldsalat und Radieschen ab August werden nicht gedüngt. Schnittkulturen bekommen die Hälfte zum Start und den Rest nach den Schnitten.
- Die Gaben stehen beim Satz zum Abhaken, fällige unter Sätze → Aufgaben und auf der Karte. Die Beetübersicht summiert den Stickstoff des Jahres.
- **Richtwerte prüfen** (Kulturen) stellt deine Abstände und Stufen neben die Quellen; übernommen wird nur, was du anhakst.

### Wetter, Gießen und Frost

- **Wasserbilanz:** Verdunstung (ET₀) zehrt, Regen füllt auf. Erreicht das Defizit die Schwelle des Bodens, ist das ein Gießtag; danach rechnet Beetwerk weiter, als wäre gegossen worden.

  | Boden | Gießen ab Defizit | Menge |
  |---|---|---|
  | Sand | 12 mm | etwa 9 l/m² |
  | lehmiger Sand | 18 mm | etwa 14 l/m² |
  | Lehm oder Schluff | 24 mm | etwa 18 l/m² |

- **Wetterband** in der Zeitleiste: Regen je Tag, Frostmarken, Wasserbilanz mit Gießtagen; 16 Tage Vorhersage.
- **Frosttermine:** Aus 20 Jahren am Standort ermittelt Beetwerk den letzten und ersten Frost je Jahr. Die Zeitleiste schattiert, wie oft es an einem Tag noch Frost gab. Die Frostgrenze ist wählbar (0, +2 oder −2 °C). Das ist Statistik, keine Vorhersage.
- **Wetter-Seite:** Niederschlag, Temperatur, Bodenwasser und Monatswerte gegen das 20-Jahres-Mittel.
- Standort ist die Mitte des Grundstücks (auf rund 1 km gerundet) oder eine Angabe in den Einstellungen. Der Abruf lässt sich abschalten.

### Bonitur

1. Satz wählen, Pflanzen festlegen: Jede Pflanze bekommt eine feste Nummer mit Sorte, Reihe und Platz, optional eine Etiketten-ID.
2. Pflanzen einzeln, als Block (Sorte, Reihe, alle) oder die ganze Sorte wählen.
3. Merkmale einzeln oder als Vorlage wählen („Rundgang“, „Ernte“, „Fruchtmerkmale“ …). „Jetzt fällig“ wählt, was nach dem BBCH-Stadium ansteht.
4. Werte eingeben: ein Wert für alle oder Pflanze für Pflanze.

Regelmäßige Merkmale (BBCH, Höhe, Befall, Ernte) sammeln einen Verlauf, einmalige gelten als erledigt. Merkmale folgen UPOV TG/44 (Tomate) und TG/76 (Paprika, Chili); eigene lassen sich anlegen. Die Übersicht zeigt den Stand je Pflanze, „Sorten vergleichen“ stellt Blüh- und Reifebeginn, Ertrag und Fruchtgewicht nebeneinander, „CSV“ exportiert alles.

### Sorten und KI-Recherche

- Die **Sortenliste** (Kulturen → Sorten) führt Art, Typ, Saatgut, Bezugsquelle, Beschreibung, Foto und Merkmale. „Aus Sätzen übernehmen“ legt fehlende Sorten an.
- Jedes **Merkmal** zeigt seine Herkunft: Bonitur (gilt, sobald es Werte gibt), Internet (recherchiert) oder eigene Angabe.
- **Recherche:** Sortennamen eingeben oder das Samentütchen fotografieren; Claude sucht im Netz und schlägt Einordnung und Bilder vor. Du prüfst alles vor dem Speichern. „Merkmale recherchieren“ füllt leere Angaben aller Sorten im Hintergrund.
- Dafür braucht es einen API-Schlüssel aus der Claude Console (Einstellungen → KI-Recherche). Abgerechnet wird je Nutzung; jede Recherche zeigt Suchen und Tokens.

### Abgleich mit Baserow

Beetwerk schreibt Kulturen, Sorten, Sätze, Merkmale, Pflanzen und Boniturwerte samt Fotos in eine Baserow-Datenbank. Die Richtung ist nur Beetwerk → Baserow.

- **Einrichten** (Einstellungen → Baserow): Adresse eintragen (nicht `localhost`), dann einmal anmelden und die Tabellen anlegen lassen. Gespeichert wird nur ein Datenbank-Token, nicht das Passwort. Alternativ eigene Tabellen mit Token und Tabellen-IDs eintragen; die nötigen Felder nennt der Dialog.
- **Abgleich:** etwa 15 Sekunden nach einer Änderung, alle 30 Minuten und mit „Jetzt abgleichen“. Übertragen wird nur, was sich geändert hat. Ist Baserow nicht erreichbar, bleibt alles in Beetwerk und wird später nachgeholt.

### Grundstück auf dem Luftbild

Unter Einstellungen → Grundstück: Garten suchen, Grenze Ecke für Ecke zeichnen, Ausrichtung wählen (welche Seite unten liegt), übernehmen. Der Server speichert einen Luftbild-Ausschnitt; danach lädt die Karte nichts mehr aus dem Internet. Wird die Grenze neu gezeichnet, bleiben die Beete an ihrem Ort. Eingebaut sind das Luftbild Bayern (DOP 20 cm, CC BY 4.0) und eigene Quellen (WMS oder XYZ-Kacheln).

## Bedienung in Kürze

| Wo | Was |
|---|---|
| Karte | Beet ziehen verschiebt (10-cm-Raster), Griffe ändern die Größe, der runde Griff dreht. **+** unten rechts zieht neue Flächen auf. |
| Karte | Kultur aus der Seitenleiste aufs Beet ziehen legt einen Satz an. Satz ziehen verschiebt ihn, Griffe ändern Länge und Breite. Pfeiltasten: 10 cm, mit Umschalt 1 m. Entf löscht. |
| Karte | Sätze ohne Beet stehen in der Seitenleiste: aufs Beet ziehen oder antippen und dann aufs Beet tippen. |
| Zeitleiste | Balken waagerecht ziehen verschiebt die Termine, senkrecht wechselt das Beet, die Kanten ändern Aussaat und Ernteende. Klick auf eine freie Stelle legt einen Satz an. |
| Zeitleiste | Erster Klick markiert, zweiter öffnet die Übersicht. Strg- oder Umschalt-Klick markiert mehrere; „Ändern“ und „Löschen“ gelten dann für alle. |
| Sätze | Jahr wählen, Häkchen markieren Sätze (gilt auch in der Zeitleiste). Mehrere gemeinsam ändern: Termine, Beet, Sorte, Länge, Reihen, erledigt. |
| Überall | `[` und `]` springen eine Woche, Strg+Z macht rückgängig. |
| Handy | Navigation unten; ein Finger verschiebt die Karte, zwei zoomen. „Zum Startbildschirm hinzufügen“ macht daraus eine App. |

## Quellen der Richtwerte

- **Abstände:** „Sä- und Pflanztermine auf einen Blick“ der Bayerischen Gartenakademie (LWG), ergänzend aid „Gemüse, Obst & Co.“ (2017).
- **Düngung:** LWG-Merkblatt 2202 (2020) für Stufen und Höchstmengen, Merkblatt 2166 (2016) für Kräuter. Kulturen, die dort fehlen, sind aus dem Stickstoffbedarf des Erwerbsanbaus abgeleitet (IGZ 2015, LfL 2025) oder einer verwandten Kultur gleichgestellt; der Dialog der Kultur nennt die Herkunft.
- **Gießen:** Prinzip der Geisenheimer Bewässerungssteuerung, Richtwerte für 30 cm Wurzeltiefe.
- **Ohne Quelle:** Anzuchtdauer, Tage bis zur Ernte und Erntedauer sind Erfahrungswerte, ebenso die Schätzung für die andere Anbauart und die 15-cm-Grenze für Folien. Bitte an den eigenen Garten anpassen.

## Was nach außen geht

Ohne Einrichtung läuft Beetwerk ohne Internet. Diese Dienste werden nur unter den genannten Bedingungen genutzt:

| Dienst | Wann | Was |
|---|---|---|
| Open-Meteo | Wetter eingeschaltet und Standort bekannt | Standort auf rund 1 km gerundet |
| Nominatim, Kartendienste | beim Einrichten des Grundstücks | Suchbegriff, Kartenausschnitt |
| Claude-API | bei einer Recherche | Sortenname, ggf. Foto des Samentütchens |
| Baserow | wenn verbunden | Kulturen, Sorten, Sätze, Bonitur |

API-Schlüssel und Baserow-Token liegen nur in der Datenbank auf dem Server und stehen nicht in der JSON-Sicherung.

## Schnittstelle

Die REST-API ist unter `/api/docs` dokumentiert. Die wichtigsten Endpunkte:

- `GET /api/data`: alles für die Oberfläche (Beete, Kulturen, Sätze, Sorten, Anzucht, Dünger, Folien)
- `POST/PATCH/DELETE` auf `/api/beds`, `/api/crops`, `/api/plantings`, `/api/varieties`, `/api/foils`, `/api/fertilizers`
- `POST /api/goals/preview` und `/api/goals`: satzweiser Anbau
- `GET /api/nursery?year=`: Anzuchten, Wochenaufgaben, Belegung
- `GET /api/weather?year=`, `/api/frost`, `/api/climate`
- `GET /api/bonitur?year=`, `POST /api/observations`, `GET /api/bonitur.csv?year=`
- `GET /api/export`, `POST /api/import`: JSON-Sicherung

## Entwicklung

```bash
pip install -r requirements.txt pytest httpx
pytest -q
BEETWERK_DATA=./data uvicorn app.main:app --reload
```

Änderungen laufen über Branch und Pull Request; GitHub führt die Tests aus und baut nach dem Mergen das Image. Jede Version gibt es auch unter ihrem Commit-Kürzel (`ghcr.io/antoineburtz/beetwerk:sha-…`).

| Datei | Inhalt |
|---|---|
| `app/main.py`, `app/db.py` | FastAPI-Server, REST-API, SQLite-Schema |
| `app/seed.py`, `app/feeding.py`, `app/methods.py`, `app/foils.py` | Kulturen und Richtwerte, Düngung, Anbauart, Folienraster |
| `app/goals.py`, `app/nursery.py` | satzweiser Anbau, Anzucht |
| `app/weather.py`, `app/geo.py` | Wetterdaten und Frost, Grundstück und Luftbild |
| `app/bonitur.py`, `app/varieties.py`, `app/profile.py`, `app/research.py` | Bonitur, Sortenliste, Sortenprofil, Recherche |
| `app/baserow.py` | Abgleich mit Baserow |
| `app/static/` | Oberfläche ohne Build-Schritt (ES-Module): `map.js`, `timeline.js`, `editor.js`, `util.js` (Rechnen), `store.js` (Zustand, Rückgängig) |
| `tests/` | pytest; `fake*.py` sind künstliche Dienste (Karte, Baserow, Claude) für Tests |

Die Rechnungen für Anbauart, Pflanzenzahl und Folienraster gibt es zweimal, in Python und in `util.js`; Tests prüfen, dass beide dasselbe ergeben. Schrift (Barlow, SIL OFL) und Leaflet 1.9.4 (BSD-2-Clause) sind lokal eingebunden.
