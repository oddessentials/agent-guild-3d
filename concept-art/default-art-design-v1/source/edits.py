import subprocess, sys, glob, shutil, json
from pathlib import Path
G = "E:/projects/local-image-studio/scripts/gen.py"
BG = " Keep the same camera framing and scale: three-quarter figure from knees up, filling the frame. Replace the entire background with a flat pure pitch-black void."
LOCK = ("Turn {who} into cold grey weathered stone, petrified like an old statue, same pose and silhouette, wrapped in heavy rusted "
        "iron chains with one large iron padlock hanging on the chest, thick black iron prison bars in front, fully desaturated, "
        "dim cold light, dormant and sealed." + BG)
jobs = {
  "anthropic": ("raw/anthropic-idle-a",
     "Keep the man, his pose, face, robes and the floating runes exactly the same. Replace the entire background with a pure "
     "pitch-black void with a faint smoky vignette and a few tiny drifting embers.",
     "Keep the exact same man, face, beard, hood and robes. Change his pose: he is now actively casting a powerful spell, both hands "
     "thrust forward conjuring two blazing orange-gold arcane glyph circles, streams of glowing amber runic symbols swirling around him, "
     "robes billowing, bright sparks. Keep the pitch-black background.",
     "Turn this exact same man into a cold grey weathered stone statue, petrified, same pose and silhouette, wrapped in heavy rusted "
     "iron chains with a large iron padlock on his chest, thick black iron prison bars in front of him, desaturated, dim cold light. "
     "Keep the pitch-black background."),
  "openai": ("raw/openai-idle-a",
     "Keep the knight, armor, helm, cloak and pose exactly the same, keep the glowing emerald seams and visor." + BG,
     "Keep the exact same knight, armor and helm. Change his pose: he now swings the massive greatsword in a dynamic combat stance, "
     "the blade blazing with emerald-green energy, bright green sparks and streams of glowing green code particles trailing the swing, cloak flaring." + BG,
     LOCK.format(who="this exact same knight")),
  "google": ("raw/google-idle-a",
     "Keep both mages, their faces, blue robes, pose and the glowing star exactly the same." + BG,
     "Keep the exact same twin mages and robes. Change the pose: both raise one hand together, channeling a brilliant blue-white starburst "
     "between them, glowing constellation lines and orbiting star sparks swirling around them, robes stirring in a magical wind." + BG,
     LOCK.format(who="these exact same twin mages")),
  "xai": ("raw/xai-idle-b",
     "Keep the young man, his face, hair, glowing cyan eyes, coat and pose exactly the same." + BG,
     "Keep the exact same young man, face, hair and coat. Change his pose: he thrusts one hand forward summoning crackling electric-cyan "
     "lightning and floating holographic glyphs, coat flaring, the cyan circuit sigils on his coat blazing bright." + BG,
     LOCK.format(who="this exact same young man, still wearing his long high-collared coat,")),
  "shell": ("raw/shell-idle-a",
     "Keep the violet smoke wraith, hood and pose exactly the same. Remove the symbol on the chest. Inside the dark empty hood, where a face "
     "would be, place one single glowing bright violet '>' chevron symbol." + BG,
     "Keep the exact same violet smoke wraith and hood with the glowing '>' chevron inside the hood. Change it: the wraith now swirls "
     "into a powerful vortex of violet energy, streams of glowing violet terminal-glyph particles spiraling around it, the chevron blazing bright." + BG,
     LOCK.format(who="this exact same hooded wraith")),
}
FROM_RAW = {"anthropic"}
CHARACTERS = json.loads((Path(__file__).parent / "characters.json").read_text())
only = set(sys.argv[1:])
pick = {a.split(":")[0]: a.split(":")[1] for a in only if ":" in a}
only = {a.split(":")[0] for a in only}
for pid, (src, idle, working, locked) in jobs.items():
    if only and pid not in only: continue
    if not glob.glob(src + "/*.png"):
        spec = CHARACTERS[Path(src).name]
        subprocess.run([sys.executable, G, spec["prompt"] + " " + spec.get("style", CHARACTERS["_style"]), "--workflow", "hidream-o1",
                        "--seed", str(spec["seed"]), "--width", str(spec["w"]), "--height", str(spec["h"]), "--out", src], check=True)
    srcf = glob.glob(src + "/*.png")[0]
    for state, prompt, inp in (("idle", idle, srcf), ("working", working, None), ("locked", locked, None)):
        if pid in pick and pick[pid] != state: continue
        out = f"raw/{pid}-{state}-edit"
        shutil.rmtree(out, ignore_errors=True)
        inp = inp or (srcf if pid in FROM_RAW else glob.glob(f"raw/{pid}-idle-edit/*.png")[0])
        r = subprocess.run([sys.executable, G, prompt, "--workflow", "qwen-edit", "--input", inp, "--seed", "7", "--out", out],
                           capture_output=True, text=True)
        print(pid, state, (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1], flush=True)
