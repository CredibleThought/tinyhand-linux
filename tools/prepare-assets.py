#!/usr/bin/env python3
"""Generate the extension's assets from an upstream TinyHand checkout.

For every built-in hand this slices the 1024x1536 source PNG into the hand
part and the rod part, downscales them, renders a square toolbar thumbnail,
and records the geometry the arm math needs in hands.json. The measurement
mirrors HandAsset.measure() in upstream PointerStyle.swift.

Usage: tools/prepare-assets.py <path-to-upstream-tinyhand> <extension-dir>
Requires Pillow.
"""

import json
import shutil
import sys
from pathlib import Path

from PIL import Image

# (id, title, ink colour) in upstream order; see PointerStyle.swift.
PURPLE = "#8754F2"
RED = "#FF291F"
HANDS = [
    ("lavender", "Lavender toy", PURPLE),
    ("glove", "Cursor glove", PURPLE),
    ("coral", "Coral vinyl", RED),
    ("plush", "Plush", "#2F86F0"),
    ("robot", "Robot", "#16A87A"),
    ("pink", "Bubblegum", "#EE4F98"),
    ("blue", "Sky", "#2F86F0"),
    ("mint", "Mint", "#16A87A"),
    ("lemon", "Lemon", "#F2B705"),
    ("black", "Midnight", "#1D1D21"),
    ("chrome", "Chrome", "#6B7380"),
    ("holo", "Holo", PURPLE),
    ("fuzzy", "Fuzzy", PURPLE),
    ("wood", "Wood", "#9A5E2C"),
    ("marble", "Marble", "#6B7380"),
    ("terrazzo", "Terrazzo", "#F0561D"),
    ("glass", "Glass", "#1597E5"),
    ("jelly", "Jelly", "#A33FE6"),
    ("pastel", "Pastel", "#EE4F98"),
    ("pixel", "Pixel", "#1D1D21"),
    ("lowpoly", "Low poly", PURPLE),
    ("knit", "Knit", PURPLE),
    ("skeleton", "Skeleton", "#9A5E2C"),
    ("astro", "Astronaut", "#2F86F0"),
    ("space", "Space", RED),
    ("monster", "Monster", "#3E9E2E"),
    ("water", "Water", "#1597E5"),
    ("lava", "Lava", "#F0561D"),
    ("grass", "Grass", "#3E9E2E"),
    ("cactus", "Cactus", "#3E9E2E"),
    ("choco", "Chocolate", "#9A5E2C"),
    ("cloud", "Cloud", "#2F86F0"),
    ("mech", "Mech", "#F0561D"),
    ("neon", "Neon", "#E0309A"),
    ("leaf", "Leaf", "#3E9E2E"),
    ("cookie", "Gingerbread", "#9A5E2C"),
]

SOUNDS = ["thock", "click", "pop", "wood", "boop", "squeak"]

# Output width of the hand/rod slices. The hand is drawn at most ~20% of the
# screen height, so 512 px wide keeps it sharp on HiDPI without shipping 62 MB.
OUT_WIDTH = 512
THUMB = 96


def measure(img):
    w, h = img.size
    alpha = img.getchannel("A").load()

    def row(y):
        return [x for x in range(w) if alpha[x, y] > 128]

    rows = [row(y) for y in range(h)]
    counts = [len(r) for r in rows]

    def center(y):
        r = rows[y]
        return 0.5 if not r else (r[0] + r[-1]) / 2 / w

    top = next(y for y in range(h) if counts[y] > 0)
    search_end = min(h, top + int(0.45 * h))
    max_w = max(counts[top:search_end])
    fist = next(y for y in range(top, h) if counts[y] > 0.6 * max_w)
    wrist = next(y for y in range(fist, h) if counts[y] < 0.35 * max_w)
    rod_w = counts[min(h - 1, wrist + h // 50)]
    last_row = max(y for y in range(h) if counts[y] > 0)
    start = min(h - 1, wrist + h // 33)
    handle = next((y for y in range(start, h) if counts[y] > 1.8 * rod_w), None)
    rod_end = handle if handle is not None else last_row

    min_x, max_x = w, 0
    for y in range(top, wrist):
        if rows[y]:
            min_x = min(min_x, rows[y][0])
            max_x = max(max_x, rows[y][-1])

    return {
        "aspect": w / h,
        "handTop": max(0.0, top - 0.004 * h) / h,
        "tip": top / h,
        "wrist": wrist / h,
        "rodEnd": rod_end / h,
        "tipX": center(min(h - 1, top + h // 200)),
        "rodX": center((wrist + rod_end) // 2),
        "handMinX": min_x / w,
        "handMaxX": max_x / w,
    }


def slice_rows(img, y0, y1):
    w, h = img.size
    part = img.crop((0, int(round(y0 * h)), w, int(round(y1 * h))))
    scale = OUT_WIDTH / w
    size = (OUT_WIDTH, max(1, int(round(part.height * scale))))
    return part.resize(size, Image.LANCZOS)


def thumbnail(img, m):
    w, h = img.size
    hand_w = (m["handMaxX"] - m["handMinX"]) * w
    hand_h = (m["wrist"] - m["handTop"]) * h
    side = max(hand_w, hand_h) * 1.06
    cx = (m["handMinX"] + m["handMaxX"]) / 2 * w
    cy = (m["handTop"] + m["wrist"]) / 2 * h
    box = (
        max(0, int(cx - side / 2)),
        max(0, int(cy - side / 2)),
        min(w, int(cx + side / 2)),
        min(h, int(cy + side / 2)),
    )
    crop = img.crop(box)
    canvas = Image.new("RGBA", (THUMB, THUMB), (0, 0, 0, 0))
    crop.thumbnail((THUMB, THUMB), Image.LANCZOS)
    canvas.paste(crop, ((THUMB - crop.width) // 2, (THUMB - crop.height) // 2))
    return canvas


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    upstream = Path(sys.argv[1]) / "assets"
    out = Path(sys.argv[2]) / "assets"
    hands_dir = out / "hands"
    hands_dir.mkdir(parents=True, exist_ok=True)

    hands = []
    for hand_id, title, ink in HANDS:
        img = Image.open(upstream / f"hand_{hand_id}.png").convert("RGBA")
        m = measure(img)
        slice_rows(img, m["handTop"], m["wrist"]).save(hands_dir / f"{hand_id}_hand.png", optimize=True)
        slice_rows(img, m["wrist"], m["rodEnd"]).save(hands_dir / f"{hand_id}_rod.png", optimize=True)
        thumbnail(img, m).save(hands_dir / f"{hand_id}_thumb.png", optimize=True)
        hands.append({"id": hand_id, "title": title, "ink": ink, **{k: round(v, 5) for k, v in m.items()}})
        print(f"{hand_id:10s} wrist={m['wrist']:.3f} rodEnd={m['rodEnd']:.3f} rodX={m['rodX']:.3f}")

    (out / "hands.json").write_text(json.dumps(hands, indent=1) + "\n")

    sounds_dir = out / "sounds"
    sounds_dir.mkdir(exist_ok=True)
    for name in SOUNDS:
        shutil.copy(upstream / "sounds" / f"tap_{name}.wav", sounds_dir / f"tap_{name}.wav")

    icons_dir = out / "icons"
    icons_dir.mkdir(exist_ok=True)
    for name in ["menubar-on", "menubar-off"]:
        svg = (upstream / "icon" / f"{name}.svg").read_text()
        # Symbolic icons are recoloured by GNOME Shell when they have no fill of their own.
        (icons_dir / f"tinyhand-{name}-symbolic.svg").write_text(svg)


if __name__ == "__main__":
    main()
