import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "guild"
BRAND = PACK.parent.parent / "web" / "brand"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = ["anthropic", "google", "openai", "shell", "xai"]
STATES = ["idle", "working", "locked"]
CHARACTER_WIDTH = 640
PROPS = {
    "ui/level-medallion.png": 128,
    "ui/gem-mana.png": 48,
    "ui/gem-vitality.png": 48,
    "ui/padlock.png": 120,
    "familiars/aether.png": 112,
    "familiars/flame.png": 112,
    "familiars/leaf.png": 112,
    "familiars/night.png": 112,
}


def quantize(im, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)


def encode(im, out, avif, webp=82):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out.with_suffix(".avif"), quality=avif, subsampling="4:4:4", speed=2)
    im.save(out.with_suffix(".webp"), quality=webp, method=6)


def shrink(im, width):
    return im.convert("RGBa").resize((width, round(im.height * width / im.width)), Image.LANCZOS).convert("RGBA")


def remask(src, mask):
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, str(GEN), "--workflow", "remove-bg", "--input", str(src), "--out", tmp],
                           capture_output=True, text=True, check=True)
        cut = next(line for line in r.stdout.splitlines() if line.endswith(".png"))
        Image.open(cut).getchannel("A").save(mask, optimize=True)


def cutout(src, mask):
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    a = np.maximum(m, np.clip(rgb.max(axis=2) * 1.6, 0, 1))
    rgb = np.clip(rgb / np.maximum(a[..., None], 1e-3), 0, 1)
    return Image.fromarray((np.dstack([rgb, a]) * 255 + 0.5).astype(np.uint8), "RGBA")


def masked(src, mask):
    im = Image.open(src).convert("RGBA")
    im.putalpha(Image.open(mask).convert("L"))
    return im.crop(im.getbbox())


def frame(src, out, origin=(40, 44), size=860, corner=168):
    nine_slice(Image.open(src).convert("RGBA").crop((*origin, origin[0] + size, origin[1] + size)).resize((corner, corner), Image.LANCZOS), out)


def diagonal(im):
    a = np.asarray(im).copy()
    upper = np.triu_indices(a.shape[0], 1)
    a[upper] = a.transpose(1, 0, 2)[upper]
    return Image.fromarray(a, "RGBA")


def nine_slice(tl, out):
    corner = tl.width
    im = Image.new("RGBA", (corner * 2 + 1, corner * 2 + 1))
    im.paste(tl, (0, 0))
    im.paste(tl.transpose(Image.FLIP_LEFT_RIGHT), (corner + 1, 0))
    im.paste(tl.transpose(Image.FLIP_TOP_BOTTOM), (0, corner + 1))
    im.paste(tl.transpose(Image.ROTATE_180), (corner + 1, corner + 1))
    im.paste(tl.crop((corner - 1, 0, corner, corner)), (corner, 0))
    im.paste(tl.crop((corner - 1, 0, corner, corner)).transpose(Image.FLIP_TOP_BOTTOM), (corner, corner + 1))
    im.paste(tl.crop((0, corner - 1, corner, corner)), (0, corner))
    im.paste(tl.crop((0, corner - 1, corner, corner)).transpose(Image.FLIP_LEFT_RIGHT), (corner + 1, corner))
    quantize(im, out)


def favicon(src, out, box=(110, 60, 395, 470), size=64):
    shield = Image.open(src).convert("RGBA").crop(box)
    side = max(shield.size)
    im = Image.new("RGBA", (side, side))
    im.paste(shield, ((side - shield.width) // 2, (side - shield.height) // 2))
    im.resize((size, size), Image.LANCZOS).save(out, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--masks", action="store_true", help="recompute the BiRefNet masks with the local image studio")
    args = ap.parse_args()

    for pid in PROVIDERS:
        for st in STATES:
            src = PACK / "characters" / pid / f"{st}.png"
            mask = PACK / "characters" / pid / f"{st}-mask.png"
            if args.masks:
                remask(src, mask)
            encode(shrink(cutout(src, mask), CHARACTER_WIDTH), WEB / "characters" / pid / st, avif=60)
        encode(Image.open(PACK / "icons" / f"{pid}.png").convert("RGB"), WEB / "icons" / pid, avif=70)

    for rel, height in PROPS.items():
        im = Image.open(PACK / rel).convert("RGBA")
        quantize(im.resize((round(im.width * height / im.height), height), Image.LANCZOS), WEB / rel)

    frame(PACK / "ui" / "frame-corner.png", WEB / "ui" / "frame.png")
    ornate = diagonal(Image.open(PACK / "ui" / "frame-ornate.png").convert("RGBA").crop((0, 0, 465, 465)))
    nine_slice(ornate.resize((232, 232), Image.LANCZOS), WEB / "ui" / "frame-ornate.png")
    crest = Image.open(PACK / "ui" / "guild-crest.png").convert("RGBA")
    quantize(crest.resize((round(crest.width * 160 / crest.height), 160), Image.LANCZOS), BRAND / "crest.png")
    favicon(PACK / "ui" / "guild-crest.png", BRAND / "favicon.png")
    encode(shrink(masked(PACK / "ui" / "empty-state.png", PACK / "ui" / "empty-state-mask.png"), 420), WEB / "ui" / "empty-state", avif=60)
    encode(Image.open(PACK / "backgrounds" / "page.png").convert("RGB"), WEB / "page", avif=80, webp=85)
    light = Image.open(PACK / "backgrounds" / "page-light.png").convert("RGB")
    encode(Image.blend(light, Image.new("RGB", light.size, (243, 238, 227)), 0.25), WEB / "page-light", avif=90, webp=90)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB), str(BRAND)], check=True)


if __name__ == "__main__":
    main()
