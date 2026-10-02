# Configuration

Agent Guild works with no configuration. This page covers changing or adding
providers, signing in with more than one account, and the environment
variables the manager reads.

## Data folder

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |
| Linux | `$XDG_CONFIG_HOME/agent-guild` (default `~/.config/agent-guild`) |

`AGENT_GUILD_HOME` moves it. The folder holds the access token
(`auth-token`), the running manager's address (`manager.json`), its log
(`manager.log`), extra accounts' home folders (`accounts/`), GitHub sign-ins
and SSH keys (`github/`) and your `providers.json`.

## providers.json

Create `providers.json` in the data folder to change or add providers. It is
either `{ "providers": [ … ] }` or a bare array. See
[examples/providers.json](../examples/providers.json).

Entries are merged with the built-in ones by `id`:

* A new `id` adds a provider.
* `"enabled": false` hides one.
* Any field can be overridden for one platform under a `win32`, `darwin` or
  `linux` key.

```json
{
  "providers": [
    { "id": "anthropic", "args": ["--model", "opus"] },
    { "id": "aider", "vendor": "Aider", "tool": "Aider", "command": "aider", "color": "#14B8A6", "monogram": "Ai" },
    { "id": "shell", "enabled": false }
  ]
}
```

The manager reads the file when it starts, and again on
`POST /api/v1/providers/reload`. Problems with it, such as a field of the
wrong type or an invalid account, are written to `manager.log` and reported
by `GET /api/v1/info`.

### Fields

| Field | Meaning |
| --- | --- |
| `id` | Lowercase identifier. |
| `vendor`, `tool` | Names shown on the card. |
| `command`, `args` | What to run. `command` is looked up on PATH. `@shell` means the user's default shell. |
| `package` | The tool's npm package, e.g. `@openai/codex`. Enables the **Install** button and the version check. |
| `npmNote` | A sentence added to the **Install** button's tooltip, e.g. what npm installs. |
| `channels` | How an installed copy is recognised, so **Update** runs that installation's own updater. A copy installed by npm needs no entry. `brew.names` lists the tool's own Homebrew formula or cask names, e.g. `{ "brew": { "names": ["gemini-cli"] } }`, and `winget.id` is its WinGet package id. A provider you add must set these for its Homebrew or WinGet copy to get an **Update** button or a removal command; without them that copy shows as an unknown install with guidance only. `native.paths` are the launcher and folders the vendor's own installer uses, and `native.update` the arguments that make the tool update itself, e.g. `["update"]`. |
| `versionArgs` | Arguments that make the command print its version, used instead of `args`, e.g. `["--version"]`. |
| `usage` | Where the usage meters come from: `"claude"`, `"codex"`, `"gemini"`, `{ "command", "args" }` for a program that prints `{ "plan", "windows": [{ "label", "usedPercent", "resetsAt" }] }` (`plan` optional; `remainingPercent` may stand in for `usedPercent`), or `null` for none. |
| `modelPattern` | Regular expression that finds the model name on the tool's screen when the tool does not report it. It also picks the tool's models from the benchmark catalog. |
| `resumeArgs` | Arguments that resume the tool's own session, with `{id}` standing for the id, e.g. `["--resume", "{id}"]`. Without it the card has no **Existing…** button. |
| `history` | Where the list of earlier sessions comes from: `"claude"`, `"codex"`, `"gemini"`, `"grok"` (the tool's own session files under its home folder), `{ "command", "args" }` for a program that prints `{ "sessions": [{ "id", "title", "cwd", "startedAt", "updatedAt" }] }`, or `null` for none, in which case **Existing…** asks for an id. |
| `env` | Extra environment variables for the tool. |
| `accounts` | Further sign-ins of the tool. See [Accounts](#accounts). Needs `homeVar`. |
| `homeVar` | The environment variable that moves the tool's home folder, e.g. `CLAUDE_CONFIG_DIR`. Set for Claude Code, Codex CLI, Gemini CLI and Grok Build by default. |
| `accountEnv` | Further variables set for every account other than the default, with `{dir}` standing for the account's folder. By default Claude Code's secure-storage folder follows the account, and Gemini CLI keeps the account's sign-in in a file rather than the shared OS keychain. |
| `reporting` | How sessions get the agent reporting hooks: `"claude"`, `"codex"`, `"gemini"` or `"grok"` (see [agent-reporting.md](agent-reporting.md)), or unset for none. |
| `hooks` | `{ "path", "example" }`: the hooks file inside the home folder that earlier versions copied from `examples/` into a new account. An untouched Codex CLI copy is removed when the session gets the same hooks from Agent Guild; Claude Code's copy stays, since it also sets the status line. |
| `color`, `monogram`, `icon` | Icon appearance. `icon` is a URL path; you can also drop `<id>.svg` into `web/icons/`. |
| `install`, `docs` | Help shown when the tool is not installed. |
| `usageUrl`, `billingUrl` | `https://` links to the vendor's usage and billing pages, shown on the card. The defaults point at the subscription pages; set your API console instead, or `null` to hide a link. Google's usage link opens AI Studio, which counts API-key usage only, not the Gemini CLI sign-in quota the card's meters show. |

## Accounts

Each extra account is a separate sign-in of the same tool, kept in its own
home folder, so a personal and a work subscription can run side by side:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "accounts": [
        { "id": "default", "label": "Personal" },
        { "id": "work", "label": "Work", "dir": "~/.claude-work" }
      ]
    }
  ]
}
```

* The card shows one chip per account, each with its own usage meters. A new
  session starts under the chip picked.
* Without `dir`, the folder is `accounts/<provider>/<account>` in the data
  folder.
* The tool signs in from inside the first session of a new account. While
  the usage check finds no sign-in, the card's button reads **Sign in**.
* An entry with id `default` renames the tool's own sign-in.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_GUILD_PORT` | Port of the local API and page (default 47821). |
| `AGENT_GUILD_HOME` | Data folder (see above). |
| `AGENT_GUILD_NPM_REGISTRY` | npm registry for version checks and installs. Defaults to the registry in npm's global configuration, the one `npm install -g` uses. |
| `AGENT_GUILD_NO_UPDATE_CHECK` | `1` skips version checks, for the tools and for Agent Guild itself. Otherwise they run about once an hour. |
| `AGENT_GUILD_ALLOWED_ORIGINS` | Extra comma-separated origins allowed to call the API, e.g. a UI dev server. |
| `AGENT_GUILD_SKIP_SHELL_ENV` | `1` skips reading the login shell's PATH on macOS and Linux. |

Inside every session the manager sets `AGENT_GUILD_SESSION_ID`,
`AGENT_GUILD_PROVIDER`, `AGENT_GUILD_URL` and `AGENT_GUILD_REPORT_TOKEN`, which
`agent-guild-report` uses. See [agent-reporting.md](agent-reporting.md).
