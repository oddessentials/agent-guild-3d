# Generates the Grove props and backgrounds from props.json with the local image studio.
#   python source/props.py [name ...]
import json, shutil, subprocess, sys
from pathlib import Path

G = "E:/projects/local-image-studio/scripts/gen.py"
HERE = Path(__file__).resolve().parent
RAW = HERE.parent / "raw"
P = json.loads((HERE / "props.json").read_text())
for name, spec in P.items():
    if name.startswith("_") or (sys.argv[1:] and name not in sys.argv[1:]):
        continue
    out = RAW / name.replace("/", "-")
    shutil.rmtree(out, ignore_errors=True)
    prompt = (spec["prompt"] + " " + spec.get("style", P["_style"])).strip()
    r = subprocess.run([sys.executable, G, prompt, "--workflow", spec["workflow"], "--seed", str(spec["seed"]),
                        "--width", str(spec["w"]), "--height", str(spec["h"]), "--out", str(out)], capture_output=True, text=True)
    print(name, (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1], flush=True)
