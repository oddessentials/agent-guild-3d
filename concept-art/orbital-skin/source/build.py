# Builds the Orbital skin's art into web/skins/orbital/ from the chosen sources in this pack.
#   python source/build.py [--masks]
# --masks recomputes the BiRefNet cut-out masks with the local image studio (ComfyUI must be running).
import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "orbital"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = {"anthropic": "#e0835f", "openai": "#1fd08f", "google": "#5b9cff", "xai": "#38d6e8", "shell": "#a67cf6"}
STATES = ["idle", "working", "locked"]
CHARACTER_WIDTH = 640
# The square around each provider's head in its idle art (1056×1408), for the provider icon.
HEADS = {"anthropic": (262, 100, 530), "openai": (310, 84, 484), "google": (140, 140, 780), "xai": (286, 70, 474), "shell": (236, 106, 596)}
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


def filled(shape, gap=15):
    """The shape with its gaps closed and every hole inside it filled."""
    im = Image.fromarray((shape * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(gap))
    pad = Image.new("L", (im.width + 2, im.height + 2))
    pad.paste(im, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    inside = np.asarray(pad, dtype=np.uint8)[1:-1, 1:-1] != 128
    out = Image.fromarray((inside * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(gap))
    return np.asarray(out.filter(ImageFilter.GaussianBlur(1)), dtype=np.float32) / 255


def cutout(src, mask, solid_below=None):
    """The subject over transparency. Glows outside the mask stay, with the dark backdrop subtracted and un-premultiplied away.
    `solid_below` (a fraction of the height) also keeps whatever stands out of the backdrop below that line opaque, for a dark
    part the mask misses; it is judged on a brightened copy, where shadowed surfaces still clear the backdrop."""
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    glow = np.clip(rgb - backdrop(rgb, m), 0, 1)
    if solid_below is not None:
        lifted = rgb ** (1 / 2.4)
        part = np.clip((np.clip(lifted - backdrop(lifted, m), 0, 1).max(axis=2) - 0.06) * 10, 0, 1)
        part[: int(rgb.shape[0] * solid_below)] = 0
        body = filled(np.maximum(m, part) > 0.5) * (np.arange(rgb.shape[0])[:, None] >= rgb.shape[0] * solid_below)
        # Drop specks such as stars; keep the solid body.
        body = Image.fromarray((body * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(21)).filter(ImageFilter.MaxFilter(21))
        m = np.maximum(m, np.asarray(body, dtype=np.float32) / 255)
    g = np.clip((glow.max(axis=2) - 0.03) * 1.7, 0, 1)
    a = np.maximum(m, g)
    color = m[..., None] * rgb + (1 - m[..., None]) * glow
    color = np.clip(color / np.maximum(a[..., None], 1e-3), 0, 1)
    return Image.fromarray((np.dstack([color, a]) * 255 + 0.5).astype(np.uint8), "RGBA")


def source(rel, masks, solid_below=None):
    src, mask = PACK / f"{rel}.png", PACK / f"{rel}-mask.png"
    if masks or not mask.exists():
        remask(src, mask)
    return cutout(src, mask, solid_below)


def hex_rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def icon(art, box, color, size=128):
    """The provider's head on a deep-space tile lit in its colour."""
    x, y, side = box
    head = art.crop((x, y, x + side, y + side)).resize((size, size), Image.LANCZOS)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    glow = np.clip(1 - np.hypot(xx - 0.5, yy - 0.42) / 0.75, 0, 1) ** 1.6
    base = np.array([7, 10, 20], dtype=np.float32)
    rgb = base + (np.array(hex_rgb(color), dtype=np.float32) * 0.55 - base) * glow[..., None]
    tile = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    rng = np.random.default_rng(size)
    stars = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(stars)
    for sx, sy, r in zip(rng.integers(0, size, 18), rng.integers(0, size, 18), rng.uniform(0.3, 0.9, 18)):
        draw.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(255, 255, 255, int(120 + 100 * r)))
    tile.alpha_composite(stars)
    tile.alpha_composite(head)
    return tile.convert("RGB")


def familiar(src):
    im = Image.open(src).convert("RGB")
    side = min(im.size)
    im = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2))
    return im.resize((FAMILIAR_SIZE, FAMILIAR_SIZE), Image.LANCZOS)


def write(rel, svg):
    file = WEB / rel
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("".join(line.strip() for line in svg.strip().splitlines()) + "\n", encoding="utf-8", newline="\n")


# The level badge: a dark planet with a ring orbiting it; the level number sits on the planet.
LEVEL = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="p" cx="40%" cy="34%" r="70%"><stop offset="0" stop-color="#22345c"/><stop offset="0.7" stop-color="#0b1222"/><stop offset="1" stop-color="#05080f"/></radialGradient>
    <linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9ecff"/><stop offset="1" stop-color="#5b6cff"/></linearGradient>
    <filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter>
  </defs>
  <g transform="rotate(-22 32 32)"><ellipse cx="32" cy="32" rx="30" ry="10" fill="none" stroke="url(#r)" stroke-width="1.6" stroke-opacity="0.55"/></g>
  <circle cx="32" cy="32" r="21" fill="url(#p)"/>
  <circle cx="32" cy="32" r="20.2" fill="none" stroke="url(#r)" stroke-width="1.6"/>
  <circle cx="32" cy="32" r="17" fill="none" stroke="#9fd8ff" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="1.2 3.2"/>
  <g transform="rotate(-22 32 32)">
    <path d="M2 32A30 10 0 0 0 62 32" fill="none" stroke="url(#r)" stroke-width="2"/>
    <circle cx="55" cy="38.4" r="3.4" fill="#d6f4ff" filter="url(#g)"/>
    <circle cx="55" cy="38.4" r="2.2" fill="#ffffff"/>
  </g>
</svg>"""

# The locked badge: a hexagonal plate with a padlock and a strip of hazard stripes.
LOCK = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 44">
  <defs>
    <pattern id="h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#ffc53d"/><rect x="3" width="3" height="6" fill="#141821"/></pattern>
    <clipPath id="c"><path d="M20 2l17 9.5v21L20 42 3 32.5v-21z"/></clipPath>
  </defs>
  <path d="M20 2l17 9.5v21L20 42 3 32.5v-21z" fill="#0b1020" fill-opacity="0.86"/>
  <rect x="0" y="33" width="40" height="11" fill="url(#h)" clip-path="url(#c)"/>
  <path d="M20 2l17 9.5v21L20 42 3 32.5v-21z" fill="none" stroke="#ffc53d" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M15.5 19v-3a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="#e8eefc" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="13" y="19" width="14" height="10.5" rx="2.2" fill="#e8eefc"/>
  <circle cx="20" cy="23.6" r="1.6" fill="#0b1020"/><rect x="19.3" y="24" width="1.4" height="3" rx="0.7" fill="#0b1020"/>
</svg>"""

# Usage meter markers: a power cell for the first window, a plasma crystal for the second.
POWER = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8dffc8"/><stop offset="1" stop-color="#14b46f"/></linearGradient></defs>
  <rect x="6" y="0.8" width="4" height="2" rx="0.6" fill="#9fb2c8"/>
  <rect x="3.2" y="2.4" width="9.6" height="12.8" rx="2" fill="#0d1526" stroke="#9fb2c8" stroke-width="1"/>
  <rect x="4.8" y="4" width="6.4" height="9.6" rx="1" fill="url(#f)"/>
  <path d="M8.8 4.9L6.2 9.3h2l-1 3.8 2.6-4.6h-2z" fill="#0d1526" fill-opacity="0.75"/>
</svg>"""
PLASMA = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9e6ff"/><stop offset="0.5" stop-color="#5ba6ff"/><stop offset="1" stop-color="#3a3fd6"/></linearGradient></defs>
  <path d="M8 0.6l5.6 7.4L8 15.4 2.4 8z" fill="url(#f)" stroke="#d8ecff" stroke-width="0.8" stroke-linejoin="round"/>
  <path d="M8 0.6v14.8M2.4 8h11.2" stroke="#ffffff" stroke-opacity="0.35" stroke-width="0.6"/>
  <path d="M8 2.4L5 6.6l3-1z" fill="#ffffff" fill-opacity="0.6"/>
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

    # The mask leaves out the asteroid the robot sits on, in the lower third.
    empty = source("ui/empty-state", args.masks, solid_below=0.66)
    encode(shrink(empty.crop(empty.getbbox()), 420), WEB / "ui" / "empty-state", avif=60)
    # The generator leaves a dark seam down the left edge.
    encode(Image.open(PACK / "backgrounds" / "page.png").convert("RGB").crop((8, 0, 1912, 1088)), WEB / "page", avif=80, webp=85)
    light = Image.open(PACK / "backgrounds" / "page-light.png").convert("RGB").crop((8, 0, 1912, 1088))
    encode(Image.blend(light, Image.new("RGB", light.size, (238, 242, 250)), 0.3), WEB / "page-light", avif=88, webp=90)

    write("ui/level.svg", LEVEL)
    write("ui/lock.svg", LOCK)
    write("ui/power.svg", POWER)
    write("ui/plasma.svg", PLASMA)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB / "familiars")], check=True)


if __name__ == "__main__":
    main()
