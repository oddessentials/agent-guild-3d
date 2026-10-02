# Generates the Orbital robots with the local image studio: each idle robot from
# characters.json (qwen-image), then its working and locked states edited from it
# (qwen-edit) so all three are the same figure in the same framing.
#   python source/edits.py [provider[:state] ...]
import glob, json, shutil, subprocess, sys
from pathlib import Path

G = "E:/projects/local-image-studio/scripts/gen.py"
HERE = Path(__file__).resolve().parent
RAW = HERE.parent / "raw"
C = json.loads((HERE / "characters.json").read_text())
KEEP = " Keep the exact same art style, rendering, camera framing, scale and the pure flat black background."
LOCKED = ("Power this exact same robot down: every light and glowing eye switched off and dark, its materials turned cold desaturated "
          "gunmetal grey, dusted with frost and small ice crystals, frozen in stasis, its body clamped by heavy yellow-and-black "
          "hazard-striped steel restraint clamps with one large steel padlock on its chest. Same pose and silhouette, dormant and sealed." + KEEP)
WORKING = {
    "anthropic": "Keep the exact same robot sorcerer, hood, robe and faceplate. Change its pose: it is now actively casting, both hands thrust forward conjuring two blazing orange-gold holographic glyph circles, streams of glowing amber rune symbols and code swirling around it, its amber eyes blazing bright, robe billowing, bright sparks.",
    "openai": "Keep the exact same knight robot, armor and helm. Change its pose: it now swings the greatsword in a dynamic stance while staying the same size, standing tall and filling the frame from head to feet, the blade blazing with emerald-green energy, bright green sparks and streams of glowing green code particles trailing the swing, every armor seam and the visor blazing bright, cape flaring.",
    "google": "Keep the exact same twin robots, robes and faces. Change the pose: both raise one hand together, channeling a brilliant blue-white starburst between them, glowing constellation lines and orbiting star sparks swirling around them, their eyes blazing bright, robes stirring.",
    "xai": "Keep the exact same robot, helmet, visor and coat. Change its pose: it thrusts one hand forward summoning crackling electric-cyan lightning and floating holographic code panels, coat flaring, the cyan circuit sigils and the visor blazing bright.",
    "shell": "Keep the exact same hooded violet hologram robot with the glowing '>' chevron in its hood. Change it: it now swirls into a powerful vortex of violet energy, streams of glowing violet terminal glyphs and code characters spiraling around it, the chevron blazing bright.",
}

only = [a.split(":") for a in sys.argv[1:]]
for pid, spec in C.items():
    if pid.startswith("_") or (only and pid not in [o[0] for o in only]):
        continue
    states = {o[1] for o in only if o[0] == pid and len(o) > 1} or {"idle", "working", "locked"}
    idle_dir = RAW / f"{pid}-idle"
    if "idle" in states or not glob.glob(str(idle_dir / "*.png")):
        shutil.rmtree(idle_dir, ignore_errors=True)
        subprocess.run([sys.executable, G, spec["prompt"] + " " + C["_style"], "--workflow", "qwen-image", "--seed", str(spec["seed"]),
                        "--width", str(spec["w"]), "--height", str(spec["h"]), "--out", str(idle_dir)], check=True, capture_output=True)
    idle = glob.glob(str(idle_dir / "*.png"))[0]
    for state, prompt in (("working", WORKING[pid] + KEEP), ("locked", LOCKED)):
        if state not in states:
            continue
        out = RAW / f"{pid}-{state}"
        shutil.rmtree(out, ignore_errors=True)
        r = subprocess.run([sys.executable, G, prompt, "--workflow", "qwen-edit", "--input", idle, "--seed", str(spec.get("edit_seeds", {}).get(state, 7)), "--out", str(out)],
                           capture_output=True, text=True)
        print(pid, state, (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1], flush=True)
