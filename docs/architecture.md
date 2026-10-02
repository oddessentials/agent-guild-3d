# Architecture

```
 ┌──────────────┐   HTTP + WebSocket (127.0.0.1, token)   ┌──────────────────────────┐
 │  Web page    │ ◀─────────────────────────────────────▶ │     Session manager      │
 └──────────────┘                                          │                          │
 ┌──────────────┐                                          │  SessionManager          │
 │ Future: UE5  │ ◀─────────────── same API ─────────────▶ │   └ Session × N          │
 │ or desktop UI│                                          │      ├ node-pty process  │──▶ claude / codex / gemini / grok / shell / npm install
 └──────────────┘                                          │      ├ headless xterm    │
                                                           │      └ agents, model     │◀── agent-guild-report, OSC 7777
                                                           │  ProviderRegistry        │──▶ tool --version, npm registry
                                                           │  UsageMonitor            │──▶ vendor usage endpoints
                                                           │  SessionHistory          │──▶ the tools' own session files
                                                           │  ModelStats              │──▶ OpenRouter model list (benchmarks)
                                                           │  NewsFeed                │──▶ news, release and research feeds
                                                           │  Changelog, SelfUpdate   │──▶ GitHub releases, npm registry
                                                           └──────────────────────────┘
```

## Components

* **Session manager** (`src/manager`). A Node.js process that owns every
  terminal. It keeps running when the page closes. `agent-guild open` starts
  it in the background if it is not already running.
* **Session** (`session.mjs`). One node-pty process plus a headless xterm.js
  terminal that mirrors its screen. When a client attaches, the manager
  serializes that mirror into a snapshot, so the client sees the current
  screen even for full-screen TUIs. It does not replay a raw byte log, which
  would break on truncation. The mirror is also the terminal of record: it
  answers the program's terminal queries exactly once, so tools that ask for
  the cursor position work with no page open and get no duplicate replies
  with several pages open.
* **Stopping a session.** On macOS and Linux the process gets a hang-up
  signal, then a forced kill after a grace period. On Windows the process
  tree is ended at once, as node-pty's own Windows kill does; there is no
  gentler signal for console programs there.
* **Provider registry** (`providers.mjs`). Built-in providers plus the user's
  `providers.json`. Finds each tool on PATH. On macOS and Linux it first reads
  the login shell's PATH, because apps started from Finder or the Dock do not
  get it. On Windows it runs `.cmd` and `.ps1` shims through `cmd.exe` or
  PowerShell, because ConPTY can only start real executables. It also checks
  each tool's installed and latest versions, and builds the `npm install -g`
  session that installs a tool.
* **Usage monitor** (`usage.mjs`). Reads each tool's own sign-in and asks the
  vendor's usage endpoint for the remaining rate-limit windows. Tokens stay
  in the manager.
* **Session history** (`session-history.mjs`). Lists each tool's earlier
  sessions from the transcripts the tool keeps in its home folder, reading
  only their heads, so one can be resumed from the page.
* **Model stats** (`model-stats.mjs`). Reads OpenRouter's public model list
  for Artificial Analysis and Design Arena results, picks each provider's
  models with its `modelPattern`, and grades every model against the models
  of all configured tools. Cached for 6 hours.
* **News feed** (`news.mjs`). Reads a fixed list of RSS, Atom, Hacker News
  and GitHub release feeds when a client asks and a feed is due, and keeps
  the last 30 days. Hacker News, Slashdot and arXiv are filtered to agentic
  and local-model topics.
* **Changelog and self-update** (`changelog.mjs`, `self-update.mjs`). Read
  Agent Guild's own releases from GitHub for the What's new panel, check npm
  for a newer version, and run the upgrade as a session.
* **API server** (`server.mjs`). REST for control, one WebSocket for
  lifecycle events, one WebSocket per attached terminal. See [api.md](api.md).
* **Web page** (`web/`). Plain HTML, CSS and JavaScript with xterm.js, served
  by the manager. No build step. The card page is the default. The yard view
  (`web/yard.js`) is a second presentation of the same objects: each provider
  is a hall on an isometric courtyard and each session is a hero. It invokes
  the card controls, so there is one copy of the behaviour.
* **Launcher** (`bin/agent-guild.mjs`). Starts, stops, restarts and opens.
  Starting a detached manager lives in `launch.mjs`, which the manager also
  uses to start its successor on a restart.

## Lifetimes

| Event | Effect on sessions |
| --- | --- |
| Close or reload the page | None. Reopening reconnects and redraws. |
| An unexpected error inside the manager | Logged to `manager.log`; sessions keep running. |
| `agent-guild stop`, the page's **Stop manager** button, or quitting the manager | All sessions end. The button asks first while any session is running; the manager enforces that for every client. |
| `agent-guild restart` or the page's **Restart manager** button | All sessions end, with the same guard. The manager then starts a new manager from the package on disk and exits; clients reconnect to the new one. An upgrade's files are picked up this way. |
| Computer restart or logout | All sessions end. Nothing is restored. |

## Toward a game interface

The manager exposes sessions and agents as data, not as UI. An Unreal Engine
client would:

1. Read `manager.json` and `auth-token` to find the manager.
2. Subscribe to `/api/v1/events` and spawn one provider character per session,
   plus one worker per entry in `session.agents`.
3. Use `activity` and agent `status` to drive animation states.
4. Open `/api/v1/sessions/:id/terminal` when the player opens a character's
   terminal, and render it with any VT-compatible terminal widget.

Both front ends can run at the same time against the same sessions.
