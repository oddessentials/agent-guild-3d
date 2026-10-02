# Generates the Grove spirits with the local image studio: each idle spirit from
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
LOCKED = ("Turn this exact same spirit into a dormant, weathered grey stone statue of itself, asleep with its eyes closed: every glow, "
          "light and colour gone, its whole body carved from cold, cracked, lichen-spotted grey granite, thickly overgrown with soft "
          "green moss, a few tiny ferns and creeping ivy tendrils wrapped around it. Same pose and silhouette, still and sleeping." + KEEP)
WORKING = {
    "anthropic": "Keep the exact same fox spirit, fur, maple-leaf cloak and moss, still sitting in exactly the same seated pose, same size and same position in the frame. Change only this: its eyes are now open and glowing warm amber, the paper lantern in its paws blazes with bright golden light, and a ring of glowing red and amber maple leaves and warm sparks swirls around its body, its cloak lifting in a gentle wind.",
    "openai": "Keep the exact same moss deer spirit and driftwood antlers. Change it: its eyes glow bright green, the ferns on its antlers unfurl and burst into bloom with glowing white flowers, a rising swirl of glowing green spores, tiny leaves and fireflies spirals around it, soft green light radiating from the moss of its body.",
    "google": "Keep the exact same water spirit, lily pad hat, lotus and koi. Change it: it raises both hands and the water of its body swirls upward into graceful glowing spiral ribbons of clear blue water and spray around it, the koi leaping in an arc above its hands, droplets sparkling, its eyes glowing bright blue, the lotus open and glowing.",
    "xai": "Keep the exact same ink-wash night heron spirit. Change it: it spreads its wings wide while staying the same size and filling the frame, swirls of pale mist and flowing black ink trails spiral around it, its teal-cyan feather tips glowing bright cyan, glowing cyan motes drifting in the mist, its eyes bright gold.",
    "shell": "Keep the exact same mossy stone lantern spirit with wisteria. Change it: its window blazes with bright violet light, the wisteria blossoms glowing, a swarm of glowing violet and gold fireflies spiraling around it, ribbons of violet spirit-smoke curling upward, its eyes bright and happy.",
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
        print(pid, "idle", flush=True)
    idle = glob.glob(str(idle_dir / "*.png"))[0]
    for state, prompt in (("working", WORKING[pid] + KEEP), ("locked", LOCKED)):
        if state not in states:
            continue
        out = RAW / f"{pid}-{state}"
        shutil.rmtree(out, ignore_errors=True)
        r = subprocess.run([sys.executable, G, prompt, "--workflow", "qwen-edit", "--input", idle, "--seed", str(spec.get("edit_seeds", {}).get(state, 7)), "--out", str(out)],
                           capture_output=True, text=True)
        print(pid, state, (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1], flush=True)
