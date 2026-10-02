# Builds the Grove skin's art into web/skins/grove/ from the chosen sources in this pack.
#   python source/build.py [--masks]
# --masks recomputes the BiRefNet cut-out masks with the local image studio (ComfyUI must be running).
import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "grove"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = {"anthropic": "#d97757", "openai": "#4caf6e", "google": "#4a9be8", "xai": "#2fb8c6", "shell": "#9a7ae0"}
STATES = ["idle", "working", "locked"]
CHARACTER_WIDTH = 640
# The square around each provider's head in its idle art (1056×1408), for the provider icon.
HEADS = {"anthropic": (190, 110, 650), "openai": (200, 260, 640), "google": (230, 120, 620), "xai": (225, 210, 520), "shell": (200, 150, 660)}
FAMILIAR_SIZE = 112


def encode(im, out, avif, webp=82):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out.with_suffix(".avif"), quality=avif, subsampling="4:4:4", speed=2)
    im.save(out.with_suffix(".webp"), quality=webp, method=6)


def quantize(im, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)


def shrink(im, width):
    return im.convert("RGBa").resize((width, round(im.height * width / im.width)), Image.LANCZOS).convert("RGBA")


def remask(src, mask):
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, str(GEN), "--workflow", "remove-bg", "--input", str(src), "--out", tmp],
                           capture_output=True, text=True, check=True)
        cut = next(line for line in r.stdout.splitlines() if line.endswith(".png"))
        Image.open(cut).getchannel("A").save(mask, optimize=True)


def backdrop(rgb, m, cell=40):
    """The dark studio backdrop behind the subject, smoothed and filled in where the subject hides it."""
    small = (rgb.shape[1] // cell, rgb.shape[0] // cell)
    keep = (m < 0.02).astype(np.float32)
    blur = lambda a: np.asarray(Image.fromarray(a).resize(small, Image.BOX).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR), dtype=np.float32)
    weight = blur(keep)
    plate = np.dstack([blur(rgb[..., c] * keep) for c in range(3)]) / np.maximum(weight[..., None], 1e-4)
    # The backdrop is the dim part of the plate; glows near the subject must not count as backdrop.
    return np.minimum(plate, np.percentile(rgb.max(axis=2)[keep > 0], 90))


def cutout(src, mask):
    """The subject over transparency. Glows outside the mask stay, with the dark backdrop subtracted and un-premultiplied away."""
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    glow = np.clip(rgb - backdrop(rgb, m), 0, 1)
    g = np.clip((glow.max(axis=2) - 0.03) * 1.7, 0, 1)
    a = np.maximum(m, g)
    color = m[..., None] * rgb + (1 - m[..., None]) * glow
    color = np.clip(color / np.maximum(a[..., None], 1e-3), 0, 1)
    return Image.fromarray((np.dstack([color, a]) * 255 + 0.5).astype(np.uint8), "RGBA")


def source(rel, masks):
    src, mask = PACK / f"{rel}.png", PACK / f"{rel}-mask.png"
    if masks or not mask.exists():
        remask(src, mask)
    return cutout(src, mask)


def hex_rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def icon(art, box, color, size=128):
    """The provider's head on a soft moss-green tile lit in its colour."""
    x, y, side = box
    head = art.crop((x, y, x + side, y + side)).resize((size, size), Image.LANCZOS)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    glow = np.clip(1 - np.hypot(xx - 0.5, yy - 0.42) / 0.75, 0, 1) ** 1.4
    base = np.array([16, 30, 24], dtype=np.float32)
    rgb = base + (np.array(hex_rgb(color), dtype=np.float32) * 0.6 - base) * glow[..., None]
    tile = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    tile.alpha_composite(head)
    return tile.convert("RGB")


def familiar(src):
    im = Image.open(src).convert("RGB")
    side = round(min(im.size) * 0.86)
    cx, cy = im.width // 2, round(im.height * 0.47)
    im = im.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    return im.resize((FAMILIAR_SIZE, FAMILIAR_SIZE), Image.LANCZOS)


def write(rel, svg):
    file = WEB / rel
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("".join(line.strip() for line in svg.strip().splitlines()) + "\n", encoding="utf-8", newline="\n")


# The locked badge: a small round river stone bound with a vine, a sleeping leaf padlock on it.
LOCK = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <defs>
    <radialGradient id="s" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#6d7672"/><stop offset="0.65" stop-color="#3a423f"/><stop offset="1" stop-color="#1f2523"/></radialGradient>
    <linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9ccf5a"/><stop offset="1" stop-color="#4f8a2c"/></linearGradient>
  </defs>
  <ellipse cx="20" cy="21" rx="17.5" ry="16" fill="url(#s)" stroke="#1a1f1d" stroke-opacity="0.5"/>
  <path d="M5 16c3-7 10-11 17-10.5 4 .3 7 1.8 9.4 4-4.4-1.6-9.6-1.2-14 .6S9.6 15 5 16z" fill="url(#m)"/>
  <path d="M15.6 19.5v-3a4.4 4.4 0 0 1 8.8 0v3" fill="none" stroke="#e9efe4" stroke-width="2.1" stroke-linecap="round"/>
  <rect x="13" y="19.2" width="14" height="10.4" rx="3" fill="#e9efe4"/>
  <path d="M20 21.6c-1.9 1.3-2.2 3.6-.1 5.6 2.1-2 1.8-4.3.1-5.6z" fill="#5b9a34"/>
  <path d="M20 22.6v4.4" stroke="#e9efe4" stroke-width="0.6"/>
  <path d="M3.5 27c5 3.5 10 2 13.5-1.5M36.5 24.5c-3.6 3.6-8.4 4.3-12 2.5" fill="none" stroke="#5b9a34" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M8 29.5c-1.6-.4-2.6-1.6-2.6-3 1.5 0 2.6 1.2 2.6 3zM31.5 28c1.4-.9 1.8-2.4 1.2-3.6-1.4.6-1.9 2.2-1.2 3.6z" fill="#7cb84a"/>
</svg>"""

# The card and dialog frame corner: a sprig of young leaves curling in from the top-right corner.
SPRIG = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f7d3a"/><stop offset="1" stop-color="#8cc75a"/></linearGradient></defs>
  <path d="M63 1C52 6 40 10 30 20 22 28 18 36 15 46" fill="none" stroke="#5a7d3a" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M49 7c-3-5-9-6-13-4 3 4 8 6 13 4z" fill="url(#g)"/>
  <path d="M41 13c1 6 6 9 11 9-1-5-6-9-11-9z" fill="url(#g)"/>
  <path d="M31 20c-4-4-10-4-14-1 4 3 10 4 14 1z" fill="url(#g)"/>
  <path d="M25 28c1 6 5 10 11 10-1-6-5-9-11-10z" fill="url(#g)"/>
  <path d="M19 37c-4-3-9-2-12 1 3 3 9 3 12-1z" fill="url(#g)"/>
  <path d="M15 46c-2 3-1.5 6 .5 8 1.5-2.5 1.2-5.6-.5-8z" fill="#9fd468"/>
</svg>"""

# Usage meter markers: a water drop for the first window, a leaf for the second.
DROP = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="f" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#bdeaff"/><stop offset="0.55" stop-color="#4aa6e8"/><stop offset="1" stop-color="#1f6fb8"/></linearGradient></defs>
  <path d="M8 1.2C8 1.2 3 7 3 10.2a5 5 0 0 0 10 0C13 7 8 1.2 8 1.2z" fill="url(#f)" stroke="#1a5f9c" stroke-opacity="0.45" stroke-width="0.6"/>
  <path d="M5.6 10.4a2.6 2.6 0 0 0 2 2.4" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="1.1" stroke-linecap="round"/>
</svg>"""
LEAF = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="f" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#2f7a3a"/><stop offset="0.6" stop-color="#5fb84e"/><stop offset="1" stop-color="#b6e27a"/></linearGradient></defs>
  <path d="M2.2 13.8C1.6 7.4 5.6 2.4 14 1.8c.4 8-4.6 12.4-11.8 12z" fill="url(#f)" stroke="#245e2c" stroke-opacity="0.5" stroke-width="0.6"/>
  <path d="M2.4 13.6C5.4 10 8.4 7 12.2 3.8M6.4 10.2l-.4-2.6M9 7.6l2.4.2" fill="none" stroke="#e8f6d2" stroke-opacity="0.8" stroke-width="0.8" stroke-linecap="round"/>
</svg>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--masks", action="store_true", help="recompute the BiRefNet masks with the local image studio")
    args = ap.parse_args()

    for pid, color in PROVIDERS.items():
        for st in STATES:
            art = source(f"characters/{pid}/{st}", args.masks)
            encode(shrink(art, CHARACTER_WIDTH), WEB / "characters" / pid / st, avif=60)
            if st == "idle":
                encode(icon(art, HEADS[pid], color), WEB / "icons" / pid, avif=70)

    for name in ("flame", "leaf", "night", "aether"):
        quantize(familiar(PACK / "familiars" / f"{name}.png"), WEB / "familiars" / f"{name}.png")

    empty = source("ui/empty-state", args.masks)
    encode(shrink(empty.crop(empty.getbbox()), 440), WEB / "ui" / "empty-state", avif=60)

    # The level badge: the Blender river stone (source/stone.py), trimmed to the stone.
    stone = Image.open(PACK / "ui" / "stone.png").convert("RGBA")
    stone = stone.crop(stone.getbbox())
    stone.resize((128, round(stone.height * 128 / stone.width)), Image.LANCZOS).save(WEB / "ui" / "stone.png", optimize=True)

    # Card backdrops behind the spirits, and the page backgrounds.
    for name in ("card", "card-light"):
        encode(Image.open(PACK / "backgrounds" / f"{name}.png").convert("RGB").resize((640, 640), Image.LANCZOS), WEB / "ui" / name, avif=60)
    # The generator leaves a blocky seam along the top edge.
    encode(Image.open(PACK / "backgrounds" / "page.png").convert("RGB").crop((0, 32, 1920, 1088)), WEB / "page", avif=80, webp=85)
    light = Image.open(PACK / "backgrounds" / "page-light.png").convert("RGB").crop((0, 32, 1920, 1088))
    encode(Image.blend(light, Image.new("RGB", light.size, (244, 242, 234)), 0.22), WEB / "page-light", avif=88, webp=90)

    write("ui/sprig.svg", SPRIG)
    write("ui/lock.svg", LOCK)
    write("ui/drop.svg", DROP)
    write("ui/leaf.svg", LEAF)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB / "familiars"), str(WEB / "ui" / "stone.png")], check=True)


if __name__ == "__main__":
    main()
