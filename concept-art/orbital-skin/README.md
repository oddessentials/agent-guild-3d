# Orbital skin art

Sources for `web/skins/orbital/`: a crew of little robots, one per provider, and the props around them. Everything is generated with the local image studio (`E:/projects/local-image-studio`, ComfyUI on port 8188).

| Step | Command | Writes |
| --- | --- | --- |
| Robots | `python source/edits.py [provider[:state] ...]` | `raw/<provider>-<state>/`: the idle robot from `characters.json` (`qwen-image`), then its working and locked states edited from it (`qwen-edit`), so all three are the same figure in the same framing |
| Props | `python source/props.py [name ...]` | `raw/<name>/`: helper drones, the empty-state robot and the page backgrounds from `props.json` |
| Web art | `python source/build.py [--masks]` | `web/skins/orbital/`: cut-outs, icons, drones, backgrounds and the SVG badges |

`raw/` is not committed. Copy the picks into `characters/<provider>/<state>.png`, `familiars/`, `ui/` and `backgrounds/` before building; `--masks` recomputes the `*-mask.png` cut-out masks with BiRefNet.
