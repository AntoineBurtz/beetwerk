# Beetwerk

Anbauplanung für den Gemüsegarten mit zwei gekoppelten Ansichten:

- **Beetkarte**: Grundstück mit maßstäblichen Beeten (wie bei GrowVeg). Beete ziehst, drehst und skalierst du direkt auf der Karte. Sätze liegen als Flächen im Beet, mit Reihen und einzelnen Pflanzen.
- **Zeitleiste**: Jede Zeile ist ein Beet, jeder Balken ein Satz mit Anzucht, Zeit im Beet und Ernte (wie bei Qrop). Balken lassen sich verschieben, verlängern und in ein anderes Beet ziehen. Oben wählst du, wie viel sie zeigt: **1 Jahr**, **1½ Jahre** oder **2 Jahre** – also bis ins Folgejahr, etwa für Knoblauch, Wintergemüse oder die Planung im Herbst.

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
- Sortenliste mit Foto, Quellen und Merkmalen: nach der Saison aus deiner Bonitur, bis dahin aus dem Internet; neue Samen recherchiert Claude im Netz (auch vom Foto des Samentütchens).
- Abgleich mit Baserow: Kulturen, Sorten, Sätze und die Bonitur landen in deiner Baserow-Datenbank.
- Anzucht: Wochenplan zum Aussäen, Pikieren, Abhärten und Auspflanzen, aus den Sätzen gerechnet – mit Keimrate, Reserve, Gefäßen, Platz in der Anzucht und den Pflanzen, die Freunde bekommen.
- Ernteziele: „6 Köpfe Salat je Woche von Mitte Mai bis Oktober“ – Beetwerk legt die Folgesätze rückwärts an, mit längerer Kulturdauer im Frühjahr und Herbst, und schlägt freie Beete vor.

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

### Abgleich mit Baserow

Beetwerk schreibt Kulturen, die Sortenliste, Sätze sowie Merkmale, Pflanzen und Boniturwerte samt Fotos in eine Baserow-Datenbank. Die Richtung ist vorerst nur Beetwerk → Baserow: Geändert wird in Beetwerk. Ändert sich ein Eintrag in Beetwerk, überschreibt der Abgleich die Zeile in Baserow.

**Einrichten** unter Einstellungen → Baserow → „Mit Baserow verbinden“:

1. **Adresse** eintragen, am besten dieselbe wie im Browser (`BASEROW_PUBLIC_URL`, z. B. `http://192.168.178.20:8090`). `localhost` geht nicht, weil Beetwerk in einem eigenen Container läuft. Baserow nimmt nur Anfragen an Adressen an, die es kennt. Wer eine andere Adresse nutzen will, z. B. die IP statt eines Namens, trägt sie in Baserow unter `BASEROW_EXTRA_ALLOWED_HOSTS` ein.
2. **Tabellen anlegen lassen:** einmal mit E-Mail und Passwort anmelden, Datenbank wählen und optional deine Sorten- und Etikettentabelle. Beetwerk legt die drei Tabellen an (oder ergänzt fehlende Felder, wenn es sie schon gibt) und dazu einen Datenbank-Token „Beetwerk“. Gespeichert wird nur der Token, nicht das Passwort. Bei Konten mit Zwei-Faktor-Anmeldung geht das nicht; dann gilt Schritt 3.
3. **Oder eigene Tabellen nutzen:** Tabellen mit genau diesen Feldnamen selbst anlegen, einen Datenbank-Token mit Lese- und Schreibrecht erstellen und Token sowie die drei Tabellen-IDs eintragen. Beetwerk prüft die Felder und nennt fehlende.

| Tabelle | Felder (das erste ist das Hauptfeld) |
|---|---|
| Kulturen | Kultur, Familie, Anbauart, Anzucht (Tage), Bis Ernte (Tage), Erntedauer (Tage), Reihenabstand (cm), Pflanzabstand (cm), Bonitur-Merkmale, Farbe, Notizen, Beetwerk-ID |
| Beetwerk-Sorten | Sorte, Kultur, Botanische Art, Typ, Saatgut, Wuchs, Fruchtfarbe, Reife, Bezugsquelle, Gekauft, Beschreibung, Foto, Bildquelle, Quellen, Notizen, Beetwerk-ID, Pflanzengröße, Pflanzenhöhe (cm), Fruchtgröße, Fruchtgewicht (g), Tage bis Reife, Schärfe (SHU), Merkmale |
| Sätze | Satz, Kultur, Sorten, Sorten (Text), Beet, Anbau, Jahr, Aussaat, Pflanzung, Ernte ab, Ernte bis, Pflanzen, Fläche (m²), Notizen, Beetwerk-ID |
| Bonitur-Merkmale | Merkmal, Schlüssel, Kultur, Bereich, Häufigkeit, Ebene, Werttyp, Auswahlwerte, Einheit, Zeitpunkt, Hinweis, Vorlage, Aktiv, Beetwerk-ID |
| Bonitur-Pflanzen | Pflanze, Etikett, Jahr, Kultur, Sorte, Beet, Satz, Nr, Reihe, Platz, Status, Notiz, Beetwerk-ID, Beetwerk-Sorte |
| Boniturwerte | Eintrag, Datum, Pflanze, Merkmal, Sorte, Satz, Ebene, Wert, Zahl, Einheit, Einzelwerte, Notiz, Foto, Beetwerk-ID, Geändert |

In „Beetwerk-Sorten“ stehen die Merkmale so, wie Beetwerk sie bei der Sorte zeigt: der Wert aus der Bonitur, sonst aus dem Internet oder deine Angabe. Klasse und Zahl haben eigene Spalten (Pflanzengröße „groß“, Pflanzenhöhe 175), „Merkmale“ führt alle Merkmale mit Herkunft auf („Pflanzenhöhe: 168 cm (Bonitur 2026, n=4)“). Fehlt eine Spalte in Baserow, lässt Beetwerk sie beim Abgleich weg und nennt sie in den Einstellungen; „Neu einrichten“ legt sie an.

„Pflanze“ und „Merkmal“ in „Boniturwerte“ sind Verknüpfungen zu den anderen beiden Tabellen, ebenso „Kultur“ und „Sorten“ in „Beetwerk-Sorten“ und „Sätze“ sowie „Beetwerk-Sorte“ in „Bonitur-Pflanzen“. Wer schon mit einer älteren Version verbunden ist, legt die neuen Tabellen mit „Neu einrichten“ an; vorhandene Tabellen, Werte und der Token bleiben. Sind Sorten- oder Etikettentabelle gewählt, kommen „Sorte verknüpft“ (in Pflanzen und Werten) und „Etikett verknüpft“ (in Pflanzen) dazu. Beetwerk findet die passende Zeile über das Hauptfeld dieser Tabellen, also den Sortennamen bzw. die Etikett-ID, oder über das Feld `ref` einer Sorte im Mischsatz, wenn dort die Zeilen-ID steht. Deine vorhandenen Tabellen bekommen dabei keine neuen Felder.

**Abgleich:** Etwa 15 Sekunden nach einer Änderung in der Bonitur, alle 30 Minuten und mit „Jetzt abgleichen“ (in den Einstellungen oder über den Hinweis „Baserow ✓“ auf der Bonitur-Seite). Übertragen wird nur, was sich seit dem letzten Mal geändert hat. In Beetwerk gelöschte Werte und Pflanzen werden auch in Baserow gelöscht; eine in Baserow gelöschte Zeile legt Beetwerk bei der nächsten Änderung neu an. Fotos landen im Dateifeld „Foto“. Ist Baserow nicht erreichbar, bleibt alles in Beetwerk gespeichert und wird später nachgeholt.

`BEETWERK_BASEROW_DELAY` (Sekunden, Standard 15) ändert die Wartezeit nach einer Änderung; `0` schaltet den automatischen Abgleich ab.

## Kulturen, Sorten und Saatgut-Recherche

### Kulturen

Ein Klick auf eine Kultur öffnet ihre Übersicht: Anbau, Kulturdauer, Abstände (mit Pflanzen je m²), Fruchtfolge, Bonitur-Merkmale, die Anzucht-Einstellungen, **alle Sorten der Kultur** als Karten mit Merkmalen (Klick öffnet die Sorte), die Sätze des Jahres, Ernteziele und was Freunde davon bekommen. Sorten, die in Sätzen stehen, aber noch nicht in der Sortenliste, nimmt „In die Sortenliste aufnehmen“ auf. „+ Sorte“ und „+ Satz“ legen gleich für diese Kultur an. Die Tabelle der Kulturen zählt Sorten und Sätze.

Die Übersicht eines **Satzes** zeigt Ablauf (gesät, gepflanzt, geerntet), Beet, Fläche, Pflanzenzahl, die Sorte mit ihren Merkmalen, das Ernteziel, zu dem er gehört, und Hinweise zur Fruchtfolge; dazu „Auf der Karte“, „Folgesatz“ und „Bonitieren“. Steht eine Sorte des Satzes noch nicht in der Sortenliste, lässt sie sich dort mit einem Klick aufnehmen. Die Übersicht eines **Beets** zeigt Art, Größe, Notizen, Belegung des Jahres und die Fruchtfolge der letzten Jahre.

### Sorten

Unter **Kulturen → Sorten** steht die Sortenliste: Kultur, botanische Art, Typ, Saatgut (samenfest oder F1), Bezugsquelle, Beschreibung, Merkmale, Foto mit Bildquelle und Quellen. Ein Klick auf eine Sorte öffnet ihre Übersicht zum Lesen: Foto, Art, Typ, Saatgut, Bezugsquelle, Beschreibung, Merkmale mit Herkunft, die Sätze mit dieser Sorte, Quellen und Notizen. Ändern lässt sich erst nach „Bearbeiten“; nach dem Speichern oder Abbrechen geht es zurück zur Übersicht. „Aus Sätzen übernehmen“ legt alle Sorten an, die schon in deinen Sätzen stehen. Im Satz-Dialog schlägt Beetwerk die Sorten der gewählten Kultur vor.

**Merkmale der Sorte** sind dieselben wie in der Bonitur (für Tomate und Paprika/Chili die UPOV-Merkmale, dazu Pflanzengröße, Fruchtgröße, Reifezeit und Tage bis Reife für alle Kulturen). Klasse und Zahl sind getrennte Felder: Pflanzengröße „groß“ und Pflanzenhöhe „175 cm“, Fruchtgröße und Fruchtgewicht, Reifezeit und Tage bis Reife, Schärfegrad und Scoville. Jeder Wert zeigt seine Herkunft:

- **Bonitur 2026**: Sobald es Boniturwerte gibt, gelten sie, aus der jüngsten Saison. Einmalige Merkmale als häufigster Wert bzw. Mittel über die Pflanzen (der Dialog zeigt die Verteilung, z. B. „groß (3) · mittel (1)“), Höhe und Wuchskraft als letzter Wert der Saison. Tage bis Reife kommen aus dem ersten BBCH 81 ab Pflanzung, das Fruchtgewicht aus Erntegewicht und Fruchtzahl, wenn es nicht direkt erfasst ist. Werte aus der Bonitur ändert man in der Bonitur.
- **Internet**: von Claude recherchiert, bis die Bonitur sie ablöst. Der vorherige Wert bleibt sichtbar („Internet: 180 cm“).
- **eigene Angabe**: selbst eingetragen oder geändert.

Die Karten der Sortenliste zeigen die wichtigsten Merkmale („Pflanze groß · 168 cm hoch · Frucht sehr groß · 337,5 g“). Wuchs, Fruchtfarbe und Reife aus älteren Versionen übernimmt Beetwerk einmal in die Merkmale; was sich nicht genau zuordnen lässt, steht zusätzlich in den Notizen.

**Neue Samen recherchieren:** Sortennamen eingeben oder das Samentütchen fotografieren. Claude sucht im Netz, bevorzugt bei Saatgut-Händlern und Erhalterorganisationen, und schlägt die Einordnung vor. Dazu kommen Bilder zur Auswahl: frei lizenzierte von Wikimedia Commons und das Vorschaubild der gefundenen Seiten. Du prüfst und änderst alles, bevor es gespeichert wird; das gewählte Bild lädt Beetwerk herunter und legt es mit Quelle ab. Shopfotos sind urheberrechtlich geschützt und taugen für die eigene Sortenliste, nicht zum Veröffentlichen. Alles kommt in einem Schritt: War die Kultur vorher nicht gewählt oder fehlen nach der ersten Antwort wichtige Merkmale (Pflanzengröße und -höhe, Fruchtgröße und -gewicht, Reifezeit, Wuchs, Fruchtfarbe und -form, bei Chilis Art, Schärfe und Scoville), fragt Beetwerk in derselben Unterhaltung gezielt nach den fehlenden Merkmalen der erkannten Kultur. Die Nachfrage nutzt die schon gefundenen Seiten und höchstens drei weitere Suchen; die Recherche zeigt dann „mit Nachfrage“. „Mit Claude ergänzen“ im Dialog einer Sorte fragt nur nach dem, was noch leer ist.

**Merkmale recherchieren (n)** über der Sortenliste geht alle Sorten ohne Merkmale nacheinander durch, im Hintergrund auf dem Server (etwa eine halbe Minute je Sorte, die Seite darf zu sein). Gefüllt werden nur leere Angaben: Merkmale, Art, Typ, Saatgut, Beschreibung und Quellen. Findet Claude eine Sorte nicht sicher, bleibt sie leer und steht im Ergebnis; dann hilft „Mit Claude ergänzen“ mit einem Hinweis wie dem Händler. Bilder wählst du bei jeder Sorte selbst.

Dafür braucht es einen API-Schlüssel aus der [Claude Console](https://console.anthropic.com/), einzutragen unter Einstellungen → KI-Recherche. Der Schlüssel bleibt auf deinem Server und steht nicht in der Sicherung. Abgerechnet wird je Nutzung: die Websuche kostet 1 Cent je Suchanfrage (höchstens fünf je Sorte), dazu kommen die Tokens. Jede Recherche zeigt, wie viele Suchen und Tokens sie gebraucht hat. Der Server braucht dafür Internet.

## Anzucht

Die Seite **Anzucht** rechnet aus der Beetplanung, was wann gesät werden muss. Grundlage sind alle Sätze mit „Anzucht und Pflanzung“: Die Pflanzenzahl kommt aus der Beetbelegung bzw. den Anzahlen im Mischsatz. Ändert sich die Planung, rechnet die Anzucht neu. Eine **Anzucht** fasst alles zusammen, was von einer Kultur und Sorte am selben Tag gesät wird.

- **Rechnung:** Bedarf (Beete + Freunde) plus Reserve der Kultur (Standard 20 %) ergibt die Jungpflanzen. Daraus mit der Keimrate die Körner: bei Breitsaat in die Saatschale so viele, dass genug keimen; bei Zellen und Töpfen so viele Zellen, dass in genug davon mindestens ein Korn aufgeht (bei 2 Körnern je Zelle und 80 % Keimrate also 96 % der Zellen). Mehr als ein Korn je Zelle passt auch für Horste wie Basilikum.
- **Wochenplan:** je Kalenderwoche Aussäen, Pikieren, Abhärten, Auspflanzen und Abgeben, zum Abhaken. „Gesät“ überträgt sich auf die Sätze (ein Mischsatz ist gesät, wenn alle seine Sorten gesät sind), Auspflanzen ist das Häkchen des Satzes, Abgeben setzt den Wunsch auf „abgeholt“. Beim Öffnen springt die Seite zur aktuellen Woche.
- **Anzuchten:** Tabelle mit Aussaat, Bedarf, Jungpflanzen, Körnern, Gefäß und Platz. Ein Klick zeigt die Übersicht mit Terminen, Rechnung, für wen und Stand; unter „Stand eintragen“ hältst du fest, was wirklich gesät wurde und wie viele Jungpflanzen da sind. Fehlen Pflanzen für den Bedarf, steht das oben im Wochenplan.
- **Abgaben an Freunde:** Person, Kultur, Sorte (leer = egal), Anzahl, Abholtermin und Stand (gewünscht, zugesagt, abgeholt, abgesagt). Die Pflanzen laufen in der Anzucht derselben Sorte mit, wenn deren Pflanztermin höchstens zwei Wochen nach und vier Wochen vor der Abholung liegt; bei offener Sorte in der größten passenden. Passt keine, bekommt der Wunsch eine eigene Anzucht (Abholung minus Anzuchtdauer). Die Abholliste ist nach Termin sortiert.
- **Plätze und Belegung:** Lege deine Anzuchtplätze mit Plattenplätzen an (ein Plattenplatz ist eine Standardplatte, etwa 30 × 50 cm). Die Belegung zeigt je Woche, wie viele Plattenplätze belegt sind, bis die Pflanzen zum Abhärten rausgehen; zu volle Wochen sind rot und stehen oben im Wochenplan.
- **Gefäße:** Saatschale (Körner je Schale), Multitopfplatten (Zellen je Platte) und Töpfe, jeweils mit „je Plattenplatz“ (z. B. 15 Töpfe 9 cm). Sechs gängige sind angelegt.
- **Kulturen:** Im Dialog einer Kultur mit Anzucht stehen Aussaatgefäß, Pikieren (Gefäß und nach wie vielen Tagen), Körner je Zelle, Keimrate, Reserve, Abhärten, Wärme und Anzuchtplatz. Für die mitgelieferten Kulturen gibt es Richtwerte, z. B. Tomate: Saatschale, nach 14 Tagen in Töpfe 9 cm pikieren, warm; Salat: Multitopfplatte 104, kühl.

### Folgesätze nach Ernteziel

Für Salat, Kräuter und alles, was laufend geerntet wird: Unter **Sätze → Ernteziel** (oder in der Anzucht über „Ernteziel planen“) gibst du Kultur, Sorte, Erntezeitraum und die **Menge je Woche** an, etwa „6 Köpfe Kopfsalat von KW 20 bis KW 41“. Beetwerk rechnet rückwärts:

- **Abstand der Sätze** = Erntefenster je Satz (Standard: Erntedauer der Kultur, bei Kopfsalat 14 Tage). Ein kürzerer Abstand lässt Sätze überlappen, z. B. Pflücksalat alle 3 Wochen bei 50 Tagen Ernte.
- **Pflanzen je Satz** = Menge je Woche × Abstand ÷ Ertrag je Pflanze über das Erntefenster (Kopfsalat 1 Kopf, Pflücksalat etwa 4 Portionen, Basilikum etwa 5 Bund – Vorschläge kommen mit der Kultur). Die Fläche ohne Beet wird auf volle Reihen aufgerundet.
- **Termine:** Pflanzung so, dass die Kultur zum Erntebeginn fertig ist; bei Anzucht davor die Aussaat. Mit „Kulturdauer an die Jahreszeit anpassen“ zählt Beetwerk die Wärmesumme: Die Kulturdauer der Kultur gilt für eine Pflanzung Anfang Mai (wärmeliebende Kulturen Anfang Juni), im kühlen Frühjahr und Herbst dauert es entsprechend länger – Kopfsalat Mitte März gepflanzt braucht so gut 9 Wochen, im Sommer 6. Grundlage sind die Temperaturen deines Gartens aus den Wetterdaten der letzten Jahre, ohne sie typische Werte für Süddeutschland. Was im Freiland zu kalt wird (mehr als die dreifache Kulturdauer), plant Beetwerk nicht und sagt es; im Gewächshaus schaltest du die Anpassung ab.
- Die Vorschau zeigt alle Sätze mit Aussaat, Pflanzung, Ernte, Pflanzenzahl und Kulturdauer, bevor etwas angelegt wird.
- In der Zeitleiste stehen die Sätze eines Ziels als **eine Satzfolge** in einer Spur statt in mehreren Reihen übereinander: hell die Zeit im Beet, kräftig die Erntefenster (ein heller Strich, wo der nächste Satz in die Ernte geht), kleine Dreiecke oben, wo ein Satz gesät oder gepflanzt wird. Der zweite Klick öffnet die Übersicht des Ernteziels mit allen Sätzen auf einem gemeinsamen Zeitstrahl, Stand, nächster Aussaat und Pflanzenzahl; „Sätze einzeln zeigen“ klappt die Folge in der Zeitleiste auf, „Als Satzfolge zeigen“ oder „Zusammenfassen“ wieder zu.
- Die Sätze entstehen **ohne Beet** und stehen sofort in der Anzucht. Auf der Karte legst du sie nacheinander ab: ersten Satz antippen, aufs Beet tippen, dann „Nächster Satz“ – der Stichtag springt jeweils mit, abgeerntete Flächen früherer Sätze sind angedeutet. „Beete vorschlagen“ zeigt je Satz Beete mit freiem Platz während der ganzen Zeit im Beet; Beete, auf denen dieselbe Pflanzenfamilie in der Anbaupause stand, kommen zuletzt. „Alle ersten Vorschläge übernehmen“ verteilt die Sätze in einem Rutsch.
- **Ziel ändern** passt die noch nicht gesäten Sätze an (Termine, Größe), Beet und Lage bleiben. Begonnene Sätze (gesät, gepflanzt oder bonitiert) bleiben, wie sie sind. Löschen nimmt die nicht begonnenen Sätze mit.
- Für Frühjahr, Sommer und Herbst lohnen eigene Ziele mit passender Sorte (schossfeste Sommersalate).

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
- Zeitleiste: Balken antippen markiert ihn, nochmal antippen (oder „Details“ in der Leiste unten) öffnet die Übersicht. Den Zeitraum wählst du über die Auswahl neben + und −. Ziehen von Balken geht mit Maus oder Stift.

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
| Karte | Satz anklicken und ziehen verschiebt ihn im Beet, die vier Griffe ändern Länge und Breite. Pfeiltasten verschieben um 10 cm (mit Umschalt 1 m), Entf löscht, Eingabe öffnet den Dialog. Die Seitenleiste zeigt die Übersicht des gewählten Beets oder Satzes; Kultur und Sorten darin führen zu ihren Übersichten. |
| Karte | Gestrichelte Flächen: schraffiert sind Sätze, die in den nächsten drei Wochen ins Beet kommen; blass mit „bis 14. Jun“ sind Sätze, die in diesem Jahr schon abgeerntet sind – dort stand schon etwas, und dort lässt sich neu säen. Jungpflanzen in Anzucht stehen in der Seitenleiste. |
| Karte | Ebenen-Symbol links blendet das Luftbild ein oder aus. Darunter zeigt der Pfeil nach Norden. |
| Karte | **+** unten rechts: Art der Fläche wählen (Beet, Hochbeet, Gewächshaus, Weg, Sonstiges) und auf der Karte aufziehen; Antippen legt eine Fläche in Standardgröße an. Mehrere nacheinander möglich, „Fertig“ beendet. |
| Karte | Sätze ohne Beet (z. B. aus der Zeitleiste ohne Beet angelegt) zeigt ein Hinweis oben rechts. In der Seitenleiste lassen sie sich auf ein Beet ziehen oder antippen und dann aufs Beet tippen; beim Antippen springt der Stichtag zur Aussaat bzw. Pflanzung des Satzes. Tippst oder ziehst du in eine abgeerntete Fläche, übernimmt der Satz genau deren Lage. |
| Karte | **Folgesatz:** Bei Sätzen eines Ernteziels heißt der Knopf „Nächster Satz (2/7)“: Er wählt den nächsten geplanten Satz des Ziels, springt zu seiner Aussaat bzw. Pflanzung und wartet, bis du ihn aufs Beet tippst – so legst du alle Sätze nacheinander ab, ohne Kopien neben dem Ziel. Bei anderen Sätzen legt „Folgesatz“ eine Kopie 14 Tage später an, der Stichtag springt mit. |
| Zeitleiste | Balken waagerecht ziehen verschiebt alle Termine, senkrecht in eine andere Zeile wechselt das Beet. Rechte Kante ändert das Ernteende, linke Kante den Aussaattermin. |
| Zeitleiste | Klick auf eine freie Stelle legt dort einen neuen Satz an; ist gerade etwas markiert, hebt der Klick nur die Markierung auf. Klick in den Kopf setzt den Stichtag. |
| Zeitleiste | **Erster Klick markiert** einen Satz (oder eine Satzfolge), unten erscheint eine Leiste mit Name, Beet und Stand. **Zweiter Klick** auf denselben Balken – oder „Details“ – öffnet die Übersicht. Esc oder × hebt die Markierung auf. |
| Zeitleiste | „1 Jahr / 1½ Jahre / 2 Jahre“ legt fest, wie weit die Zeitleiste reicht; sie beginnt immer im Januar des Stichtag-Jahres, der Januar des Folgejahres trägt die Jahreszahl. Wetterband und Frostschattierung laufen über den Jahreswechsel weiter. Die Wahl bleibt gespeichert. |
| Zeitleiste | Klick auf den Beetnamen links zeigt rechts die Übersicht des Beets (Art, Größe, Notizen, Belegung, Fruchtfolge); „Bearbeiten“ öffnet das Formular. Esc oder × schließt. |
| Überall | **Erst Übersicht, dann Bearbeiten:** Ein Klick auf eine Kultur, ein Beet, eine Sorte, einen Satz oder eine Anzucht zeigt eine Übersicht zum Lesen; geändert wird erst nach „Bearbeiten“ bzw. „Stand eintragen“. Unterstrichene Namen in einer Übersicht (Kultur, Sorte, Beet, Satz) öffnen deren Übersicht darüber, „Schließen“ oder Esc führt zurück. Nach dem Speichern zeigen offene Übersichten gleich den neuen Stand. |
| Überall | `[` und `]` springen eine Woche zurück oder vor, Strg+Z macht die letzte Änderung rückgängig. |

### Begriffe

- **Satz**: eine Pflanzung einer Kultur und Sorte an einer Stelle, mit Aussaat, ggf. Pflanzung, Erntebeginn und Ernteende.
- **Bis zur Ernte** (Kultur): Tage ab Pflanzung, bei Direktsaat ab Aussaat.
- **Breite leer** im Satz heißt: reicht bis zum Beetrand.
- **Reihen leer** heißt: automatisch berechnet. Reihen laufen immer entlang der längeren Seite der Fläche (ein 1 × 20 m Beet mit 50 × 50 cm hat 2 Reihen à 40 Pflanzen).
- **Reihe und Platz** im Mischsatz werden ab der gewählten Startecke gezählt.

## Schnittstelle

Die REST-API ist unter `/api/docs` dokumentiert. Wichtige Endpunkte:

- `GET /api/data` liefert Einstellungen, Beete, Kulturen, Sätze, Sorten sowie Gefäße, Anzuchtplätze, Freunde und ihre Wünsche.
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
- `GET/POST/PATCH/DELETE /api/varieties` Sortenliste, `POST /api/varieties/collect` übernimmt Sorten aus den Sätzen
- `GET /api/varieties/{id}/profile` Merkmale einer Sorte mit Herkunft (Bonitur, Internet, eigene Angabe), `GET /api/varieties/profiles` die Kurzfassung für alle
- `POST /api/research/variety` recherchiert eine Sorte (`{"name", "crop_id", "hint", "image"}`), `POST /api/research/batch` (`{"ids": [...]}`) mehrere im Hintergrund, `GET /api/research/batch` zeigt den Stand, `POST /api/photos/from-url` holt ein Bild
- `GET /api/nursery?year=2027` Anzuchten, Wochenaufgaben und Belegung; `PATCH /api/nursery` (`{"key", "sown_done", "seeds_sown", "plants_raised", …}`) hält fest, was passiert ist
- `POST/PATCH/DELETE /api/containers`, `/api/places`, `/api/people`, `/api/handovers` für Gefäße, Anzuchtplätze, Freunde und ihre Wünsche
- `POST /api/goals/preview` rechnet ein Ernteziel durch, ohne zu speichern; `POST/PATCH/DELETE /api/goals` legt die Folgesätze an, passt sie an oder löscht sie (`?keep=true` behält die Sätze); `GET /api/goals/suggest?crop_id=` schlägt Einheit und Ertrag vor
- `GET /api/baserow` Zustand des Abgleichs, `POST /api/baserow/sync` gleicht sofort ab, `POST /api/baserow/setup` bzw. `/connect` richten ein, `DELETE /api/baserow` trennt

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
- `app/goals.py`: Ernteziele – Folgesätze rückwärts aus der Menge je Woche, Kulturdauer nach Wärmesumme
- `app/nursery.py`: Anzucht – Rechnung aus Sätzen und Wünschen, Wochenaufgaben, Belegung, Gefäße, Plätze, Freunde
- `app/varieties.py`, `app/profile.py` und `app/research.py`: Sortenliste, Sortenprofil aus Bonitur und Recherche, Recherche mit Claude (`tests/fakeclaude.py` ist eine künstliche Claude-Schnittstelle samt Commons und Shop für Tests: `python tests/fakeclaude.py 8794`, Schlüssel `sk-test`)
- `app/baserow.py`: Einrichtung und Abgleich mit Baserow (`tests/fakebaserow.py` ist ein künstliches Baserow für Tests: `python tests/fakebaserow.py 8793`, Anmeldung `garten@example.org` / `geheim`)
- `app/static/`: Oberfläche ohne Build-Schritt, reines JavaScript mit ES-Modulen (`map.js` Beetkarte, `timeline.js` Zeitleiste, `plantings.js` Sätze und Aufgaben, `editor.js` Dialoge, `geosetup.js` Grundstück auf dem Luftbild, `bonitur.js` Bonitur mit `bstore.js` und `bwidgets.js`, `store.js` Zustand und Rückgängig)
- `docker-entrypoint.py`: übergibt den Datenordner an PUID/PGID und startet ohne root
- `unraid/beetwerk.xml`: Vorlage für Unraid
- `.github/workflows/image.yml`: Tests und Image-Build

Schrift: Barlow (SIL Open Font License) und Kartenbibliothek Leaflet 1.9.4 (BSD-2-Clause) sind lokal eingebunden, damit die Oberfläche ohne Internet läuft.

Für Tests mit Luftbild gibt es einen kleinen Fake-Kartendienst: `python tests/fakemap.py 8790` liefert unter `http://127.0.0.1:8790/wms` (Layer beliebig) bzw. `/tiles/{z}/{x}/{y}.jpg` ein künstliches Grundstück bei 48,0° N / 11,0° O, dazu `/map/…` als Straßenkarte und `/label/…` als Beschriftung.
