#!/usr/bin/env python3
"""Turn an AI-generated hand on a white background into a TinyHand source PNG.

Removes the white background (including white gaps enclosed by the hand, such
as the loop between thumb and finger), keeps soft anti-aliased edges, and fits
the result to the 1024x1536 canvas used by the upstream hand images.

Usage: tools/cutout-white.py <input image> <output png>
Requires Pillow, NumPy and SciPy.
"""

import sys

import numpy as np
from PIL import Image
from scipy import ndimage

OUT_SIZE = (1024, 1536)
WHITE = 244          # every channel at or above this counts as background
MIN_REGION = 1500    # smaller white areas are highlights on the hand, not background
EDGE = 200           # edge pixels fade from opaque (at EDGE) to clear (at 255)


def cutout(img):
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    lo = rgb.min(axis=2)
    white = lo >= WHITE

    labels, count = ndimage.label(white)
    sizes = ndimage.sum(white, labels, range(1, count + 1))
    background = np.isin(labels, 1 + np.flatnonzero(sizes >= MIN_REGION))

    # Soft edge: a thin band around the background gets alpha from how far it is from white.
    band = ndimage.binary_dilation(background, iterations=3) & ~background
    alpha = np.where(background, 0.0, 1.0)
    fade = np.clip((255 - lo) / (255 - EDGE), 0, 1)
    alpha = np.where(band, fade, alpha)

    # Remove the white the edge pixels were blended with.
    a = np.maximum(alpha, 1e-3)[..., None]
    colour = np.clip((rgb - 255 * (1 - a)) / a, 0, 255)
    out = np.dstack([colour, alpha * 255]).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def fit(img):
    w, h = OUT_SIZE
    scale = h / img.height
    resized = img.resize((round(img.width * scale), h), Image.LANCZOS)
    canvas = Image.new("RGBA", OUT_SIZE, (0, 0, 0, 0))
    canvas.paste(resized, ((w - resized.width) // 2, 0))
    return canvas


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    fit(cutout(Image.open(sys.argv[1]))).save(sys.argv[2], optimize=True)


if __name__ == "__main__":
    main()
