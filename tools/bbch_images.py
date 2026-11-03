"""Verkleinert die BBCH-Zeichnungen für die Bonitur-Seite.

Originale liegen in assets/bbch/<kultur>/ und heißen ...BBCH<code>.png
(z. B. SoLy-BBCH61.png). Daraus entstehen kleine WebP-Bilder in
app/static/img/bbch/<kultur>-<code>.webp und eine Übersicht index.json,
welche Stadien es je Kultur als Bild gibt.

Aufruf:  python tools/bbch_images.py
"""
import json
import re
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "bbch"
OUT = ROOT / "app" / "static" / "img" / "bbch"
SIZE = 320  # Pixel; in der App etwa 110 px breit, also scharf bis dreifache Pixeldichte


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index: dict[str, list[int]] = {}
    for folder in sorted(p for p in SRC.iterdir() if p.is_dir()):
        codes = []
        for f in sorted(folder.iterdir()):
            m = re.search(r"BBCH[-_ ]?(\d{2})", f.name, re.I)
            if not m or f.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            code = int(m.group(1))
            img = ImageOps.exif_transpose(Image.open(f)).convert("L")
            img.thumbnail((SIZE, SIZE), Image.LANCZOS)
            target = OUT / f"{folder.name}-{code:02d}.webp"
            img.save(target, "WEBP", quality=72, method=6)
            codes.append(code)
            print(f"{f.relative_to(ROOT)} -> {target.relative_to(ROOT)} ({target.stat().st_size // 1024} KB)")
        if codes:
            index[folder.name] = sorted(codes)
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
