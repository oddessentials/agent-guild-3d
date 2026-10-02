# Grove skin art

Sources for `web/skins/grove/`: a cast of gentle nature spirits, one per provider, in a moss garden of water and quiet skies. The images are generated with the local image studio (`E:/projects/local-image-studio`, ComfyUI on port 8188); the level stone is rendered with Blender.

| Provider | Spirit |
| --- | --- |
| Anthropic | Fox spirit in a maple-leaf cloak with a paper lantern |
| OpenAI | Moss deer with driftwood antlers sprouting ferns |
| Google | Water spirit with a lily-pad hat and a koi |
| xAI | Ink-and-mist heron |
| Shell | Mossy stone lantern spirit hung with wisteria |

Idle is calm, working is awake and glowing, and locked is the same spirit turned to a sleeping, moss-grown stone statue.

| Step | Command | Writes |
| --- | --- | --- |
| Spirits | `python source/edits.py [provider[:state] ...]` | `raw/<provider>-<state>/`: the idle spirit from `characters.json` (`qwen-image`), then its working and locked states edited from it (`qwen-edit`), so all three are the same figure in the same framing |
| Props | `python source/props.py [name ...]` | `raw/<name>/`: familiars and the empty-state garden (`qwen-image`), card backdrops and page backgrounds (`hidream-o1`) from `props.json` |
| Level stone | `blender -b -P source/stone.py -- ui/stone.png` | `ui/stone.png` |
| Web art | `python source/build.py [--masks]` | `web/skins/grove/`: cut-outs, icons, familiars, backdrops, backgrounds and the SVG badges |

`raw/` is not committed. Copy the picks into `characters/<provider>/<state>.png`, `familiars/`, `ui/` and `backgrounds/` before building; `--masks` recomputes the `*-mask.png` cut-out masks with BiRefNet.
