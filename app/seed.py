"""Grundbestand an Kulturen und ein Beispielgarten.

Kulturdaten sind Richtwerte für Freiland in Süddeutschland. Sie lassen sich
in der App unter „Kulturen“ anpassen.
"""
import json
import sqlite3

# name, familie, farbe, methode, anzucht_tage, tage_bis_ernte, erntedauer, reihenabstand_cm, pflanzabstand_cm
CROPS = [
    ("Tomate", "Nachtschattengewächse", "#d64541", "transplant", 56, 70, 80, 80, 60),
    ("Paprika", "Nachtschattengewächse", "#e8743b", "transplant", 63, 75, 60, 50, 40),
    ("Chili", "Nachtschattengewächse", "#b8202c", "transplant", 70, 80, 70, 50, 40),
    ("Aubergine", "Nachtschattengewächse", "#6c3483", "transplant", 70, 75, 60, 60, 50),
    ("Kartoffel", "Nachtschattengewächse", "#b89b5e", "direct", 0, 100, 25, 70, 35),
    ("Kohlrabi", "Kreuzblütler", "#8fb8de", "transplant", 28, 50, 21, 30, 30),
    ("Brokkoli", "Kreuzblütler", "#3e7c59", "transplant", 35, 70, 21, 50, 45),
    ("Weißkohl", "Kreuzblütler", "#a9c9a4", "transplant", 35, 100, 30, 60, 50),
    ("Grünkohl", "Kreuzblütler", "#2f5d50", "transplant", 35, 95, 120, 50, 50),
    ("Radieschen", "Kreuzblütler", "#e05d8c", "direct", 0, 28, 14, 15, 3),
    ("Rucola", "Kreuzblütler", "#6a9b3c", "direct", 0, 35, 40, 20, 5),
    ("Möhre", "Doldenblütler", "#f0932b", "direct", 0, 90, 60, 25, 3),
    ("Pastinake", "Doldenblütler", "#e3cf9a", "direct", 0, 150, 90, 30, 8),
    ("Knollenfenchel", "Doldenblütler", "#cfe0a3", "transplant", 35, 70, 21, 40, 30),
    ("Knollensellerie", "Doldenblütler", "#bfc79a", "transplant", 70, 120, 30, 40, 40),
    ("Petersilie", "Doldenblütler", "#4e9a3a", "direct", 0, 70, 90, 25, 10),
    ("Gurke", "Kürbisgewächse", "#4c9f70", "transplant", 28, 50, 60, 100, 40),
    ("Zucchini", "Kürbisgewächse", "#7db84a", "transplant", 28, 50, 70, 100, 100),
    ("Kürbis", "Kürbisgewächse", "#f2b134", "transplant", 28, 100, 30, 150, 120),
    ("Buschbohne", "Hülsenfrüchtler", "#9ccc65", "direct", 0, 60, 30, 40, 10),
    ("Stangenbohne", "Hülsenfrüchtler", "#689f38", "direct", 0, 75, 50, 80, 15),
    ("Erbse", "Hülsenfrüchtler", "#aed581", "direct", 0, 75, 28, 40, 5),
    ("Dicke Bohne", "Hülsenfrüchtler", "#827717", "direct", 0, 90, 21, 40, 15),
    ("Rote Bete", "Fuchsschwanzgewächse", "#9b2245", "direct", 0, 80, 40, 30, 10),
    ("Mangold", "Fuchsschwanzgewächse", "#cc6b8e", "transplant", 28, 50, 120, 40, 30),
    ("Spinat", "Fuchsschwanzgewächse", "#2e8b57", "direct", 0, 45, 21, 25, 5),
    ("Kopfsalat", "Korbblütler", "#b5d96b", "transplant", 28, 42, 14, 30, 30),
    ("Pflücksalat", "Korbblütler", "#8db600", "transplant", 21, 30, 50, 30, 25),
    ("Endivie", "Korbblütler", "#d8e68b", "transplant", 42, 55, 35, 35, 35),
    ("Artischocke", "Korbblütler", "#8e9aaf", "transplant", 70, 75, 75, 100, 100),
    ("Zwiebel", "Lauchgewächse", "#b07cc6", "direct", 0, 110, 21, 25, 8),
    ("Lauch", "Lauchgewächse", "#6f8faf", "transplant", 70, 115, 150, 35, 15),
    ("Knoblauch", "Lauchgewächse", "#cdbfe3", "direct", 0, 245, 21, 25, 12),
    ("Feldsalat", "Baldriangewächse", "#4f7942", "direct", 0, 50, 110, 12, 5),
    ("Zuckermais", "Süßgräser", "#f4d35e", "transplant", 21, 80, 14, 70, 30),
    ("Basilikum", "Lippenblütler", "#3a7d44", "transplant", 42, 35, 80, 30, 25),
]


def seed_crops(conn: sqlite3.Connection) -> None:
    conn.executemany(
        """INSERT INTO crops(name, family, color, method, nursery_days, field_days,
                             harvest_days, row_spacing, plant_spacing)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        CROPS,
    )


# name, art, x, y, länge, breite, drehung
DEMO_BEDS = [
    ("Beet 1", "bed", 1.0, 1.0, 6.0, 1.2, 0),
    ("Beet 2", "bed", 1.0, 2.8, 6.0, 1.2, 0),
    ("Beet 3", "bed", 1.0, 4.6, 6.0, 1.2, 0),
    ("Beet 4", "bed", 1.0, 6.4, 6.0, 1.2, 0),
    ("Beet 5", "bed", 1.0, 8.2, 6.0, 1.2, 0),
    ("Hochbeet", "raised", 9.0, 1.0, 2.0, 1.0, 0),
    ("Folientunnel", "greenhouse", 9.0, 3.0, 4.0, 3.0, 0),
    ("Staudenbeet", "bed", 9.0, 7.6, 3.0, 1.2, 0),
    # Mittelweg: 9,6 m lang, 0,6 m breit, um 90° gedreht (Mitte bei x 7,9 / y 5,3)
    ("Mittelweg", "path", 3.1, 5.0, 9.6, 0.6, 90),
    ("Kompost", "other", 13.8, 8.4, 1.5, 1.5, 0),
]

# kultur, sorte, beet, methode, aussaat, pflanzung, ernte_von, ernte_bis, start, länge, rand, breite
DEMO_PLANTINGS = [
    # Vorjahr, damit die Fruchtfolge-Prüfung etwas zu sagen hat
    ("Zucchini", "Black Beauty", "Beet 1", "transplant", "2025-04-15", "2025-05-15", "2025-07-01", "2025-09-20", 0, 3, 0, None),
    ("Tomate", "Ochsenherz", "Beet 2", "transplant", "2025-03-15", "2025-05-15", "2025-07-20", "2025-10-05", 0, 6, 0, None),
    ("Kohlrabi", "Lanro", "Beet 3", "transplant", "2025-03-01", "2025-04-01", "2025-05-20", "2025-06-15", 0, 6, 0, None),
    ("Möhre", "Rodelika", "Beet 4", "direct", "2025-04-01", None, "2025-07-01", "2025-10-01", 0, 6, 0, None),
    # 2026
    ("Radieschen", "Sora", "Beet 1", "direct", "2026-03-25", None, "2026-04-25", "2026-05-10", 0, 2, 0, None),
    ("Spinat", "Matador", "Beet 1", "direct", "2026-03-20", None, "2026-05-05", "2026-05-25", 2, 4, 0, None),
    ("Buschbohne", "Saxa", "Beet 1", "direct", "2026-05-28", None, "2026-07-25", "2026-08-25", 0, 6, 0, None),
    ("Feldsalat", "Vit", "Beet 1", "direct", "2026-09-05", None, "2026-10-25", "2027-02-28", 0, 6, 0, None),
    ("Paprika", "Marconi Rosso", "Beet 2", "transplant", "2026-02-25", "2026-05-20", "2026-08-01", "2026-10-10", 0, 3, 0, None),
    ("Chili", "Lemon Drop", "Beet 2", "transplant", "2026-02-10", "2026-05-20", "2026-08-10", "2026-10-15", 3, 3, 0, None),
    ("Möhre", "Nantaise 2", "Beet 3", "direct", "2026-04-05", None, "2026-07-05", "2026-10-15", 0, 3, 0, None),
    ("Zwiebel", "Stuttgarter Riesen", "Beet 3", "direct", "2026-04-01", None, "2026-07-20", "2026-08-10", 3, 3, 0, None),
    ("Endivie", "Diva", "Beet 3", "transplant", "2026-07-01", "2026-08-15", "2026-10-10", "2026-11-15", 3, 3, 0, None),
    ("Knoblauch", "Thermidrome", "Beet 3", "direct", "2026-10-18", None, "2027-06-20", "2027-07-10", 0, 3, 0, None),
    ("Kohlrabi", "Lanro", "Beet 4", "transplant", "2026-03-01", "2026-04-01", "2026-05-20", "2026-06-10", 0, 2, 0, None),
    ("Kopfsalat", "Maikönig", "Beet 4", "transplant", "2026-03-01", "2026-04-05", "2026-05-15", "2026-06-01", 2, 2, 0, None),
    ("Grünkohl", "Halbhoher grüner Krauser", "Beet 4", "transplant", "2026-05-20", "2026-06-25", "2026-10-01", "2027-02-15", 0, 4, 0, None),
    ("Lauch", "Blauer Solaise", "Beet 4", "transplant", "2026-03-15", "2026-05-25", "2026-09-20", "2027-03-15", 4, 2, 0, None),
    ("Kartoffel", "Linda", "Beet 5", "direct", "2026-04-10", None, "2026-07-20", "2026-08-15", 0, 4, 0, None),
    ("Spinat", "Butterfly", "Beet 5", "direct", "2026-09-01", None, "2026-10-15", "2026-11-30", 0, 4, 0, None),
    ("Pastinake", "Halblange Weiße", "Beet 5", "direct", "2026-04-15", None, "2026-09-15", "2027-02-28", 4, 2, 0, None),
    ("Pflücksalat", "Lollo Rossa", "Hochbeet", "transplant", "2026-03-10", "2026-04-10", "2026-05-10", "2026-07-01", 0, 1, 0, None),
    ("Basilikum", "Genoveser", "Hochbeet", "transplant", "2026-04-01", "2026-05-20", "2026-06-25", "2026-09-15", 1, 1, 0, None),
    ("Rucola", "Wilde Rauke", "Hochbeet", "direct", "2026-09-20", None, "2026-10-25", "2026-12-15", 0, 2, 0, None),
    ("Tomate", "Ochsenherz", "Folientunnel", "transplant", "2026-03-10", "2026-05-01", "2026-07-10", "2026-10-15", 0, 4, 0, 1.2),
    ("Gurke", "Marketmore", "Folientunnel", "transplant", "2026-04-15", "2026-05-15", "2026-07-01", "2026-09-15", 0, 2, 1.8, 1.2),
    ("Aubergine", "Black Beauty", "Folientunnel", "transplant", "2026-02-20", "2026-05-10", "2026-07-25", "2026-10-01", 2, 2, 1.8, 1.2),
    ("Feldsalat", "Vit", "Folientunnel", "direct", "2026-10-18", None, "2026-12-05", "2027-03-15", 0, 4, 0, 1.2),
    ("Artischocke", "Green Globe", "Staudenbeet", "transplant", "2026-02-01", "2026-05-01", "2026-07-15", "2026-09-30", 0, 3, 0, None),
]

# Mischsätze im Beispiel: (kultur, beet, aussaat) -> Sorten, Abstände und Pflanzschema
DEMO_MIXED = {
    ("Tomate", "Folientunnel", "2026-03-10"): {
        "varieties": [("Ochsenherz", 4), ("Green Zebra", 3), ("Black Krim", 3), ("Matina", 2), ("Sungold", 3)],
        "row_spacing": 50, "plant_spacing": 50, "fill": "snake", "fill_start": "tl",
    },
    ("Chili", "Beet 2", "2026-02-10"): {
        "varieties": [("Lemon Drop", 4), ("Habanero Orange", 3), ("Jalapeño", 4), ("Aji Crystal", 3)],
        "row_spacing": 50, "plant_spacing": 40, "fill": "columns", "fill_start": "tl",
    },
}


def seed_demo(conn: sqlite3.Connection) -> None:
    bed_ids: dict[str, int] = {}
    for i, (name, kind, x, y, length, width, rot) in enumerate(DEMO_BEDS):
        cur = conn.execute(
            "INSERT INTO beds(name, kind, x, y, length, width, rotation, sort) VALUES (?,?,?,?,?,?,?,?)",
            (name, kind, x, y, length, width, rot, i),
        )
        bed_ids[name] = cur.lastrowid

    crop_ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM crops")}
    for (crop, variety, bed, method, sow, plant, hs, he, start, length, offset, span) in DEMO_PLANTINGS:
        if crop not in crop_ids:
            continue
        cur = conn.execute(
            """INSERT INTO plantings(crop_id, variety, bed_id, method, sow_date, plant_date,
                                     harvest_start, harvest_end, start, len, offset, span,
                                     sown_done, planted_done, harvest_done)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                crop_ids[crop], variety, bed_ids[bed], method, sow, plant, hs, he,
                start, length, offset, span,
                # Was vor dem 21.10.2026 lag, gilt im Beispiel als erledigt
                int(sow < "2026-10-01"),
                int(plant is not None and plant < "2026-10-01"),
                int(he < "2026-10-01"),
            ),
        )
        mixed = DEMO_MIXED.get((crop, bed, sow))
        if mixed:
            conn.execute(
                "UPDATE plantings SET variety = '', varieties = ?, row_spacing = ?, plant_spacing = ?, fill = ?, fill_start = ? WHERE id = ?",
                (
                    json.dumps([{"name": n, "count": c} for n, c in mixed["varieties"]], ensure_ascii=False, separators=(",", ":")),
                    mixed["row_spacing"], mixed["plant_spacing"], mixed["fill"], mixed["fill_start"], cur.lastrowid,
                ),
            )
    conn.execute("UPDATE settings SET value = 'Beispielgarten' WHERE key = 'garden_name'")
