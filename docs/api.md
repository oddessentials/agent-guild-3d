# Session manager API (v1)

The session manager is the only component that owns terminal processes. The
web page is one client of this API. Any other front end, such as a future
Unreal Engine interface, can use the same API to list, start, watch and drive
the same sessions at the same time.

## Discovery and authentication

The manager listens on `127.0.0.1` only. Its default port is 47821, and
`AGENT_GUILD_PORT` overrides it.

A client finds a running manager through two files in the per-user data
directory:

| Platform | Data directory |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |
| Linux | `$XDG_CONFIG_HOME/agent-guild` (default `~/.config/agent-guild`) |

* `manager.json` exists while a manager runs. It holds `pid`, `port`, `url`,
  `version` and `startedAt`.
* `auth-token` holds the API token. It persists across restarts. Delete it to
  rotate the token.

Every endpoint except `GET /api/v1/health` requires the token:

```
Authorization: Bearer <token>
```

WebSocket clients that cannot set headers, such as browsers, pass
`?token=<token>` in the URL instead.

The manager also rejects requests whose `Host` header is not a loopback name
for its port, and browser requests whose `Origin` is not the manager's own
page. That blocks DNS-rebinding and cross-site attacks. Native clients that
send no `Origin` header are unaffected. `AGENT_GUILD_ALLOWED_ORIGINS` adds
extra comma-separated origins, for example a UI dev server.

Errors use one shape:

```json
{ "error": { "code": "provider_unavailable", "message": "Codex CLI (\"codex\") was not found on PATH. ..." } }
```

## Objects

### Provider

```json
{
  "id": "anthropic",
  "vendor": "Anthropic",
  "tool": "Claude Code",
  "command": "claude",
  "package": "@anthropic-ai/claude-code",
  "args": [],
  "resumable": true,
  "installable": true,
  "installedVersion": "2.1.285",
  "latestVersion": "2.1.290",
  "updateAvailable": true,
  "usageSource": "claude",
  "historySource": "claude",
  "accounts": [{ "id": "default", "label": "Default" }, { "id": "work", "label": "Work" }],
  "color": "#D97757",
  "monogram": "A",
  "iconUrl": null,
  "install": "npm install -g @anthropic-ai/claude-code",
  "docs": "https://docs.anthropic.com/en/docs/claude-code",
  "usageUrl": "https://claude.ai/settings/usage",
  "billingUrl": "https://claude.ai/settings/billing",
  "available": true,
  "resolvedPath": "/usr/local/bin/claude"
}
```

`available` is false when the command is not installed. A client should show
the provider as disabled and offer `POST /providers/:id/install` when
`installable` is true (the provider names an npm `package` and npm is on
PATH), or the `install` hint otherwise. `resumable` is true when the provider
has `resumeArgs`, so one of the tool's own earlier sessions can be resumed by
id.

`installedVersion` comes from running the tool with its `versionArgs`, and
`latestVersion` from npm's configured registry, which installs use too
(`AGENT_GUILD_NPM_REGISTRY` overrides it for both, `AGENT_GUILD_NO_UPDATE_CHECK=1`
skips the lookup). Both are null until the first check finishes; a
`providers.updated` event follows.
`updateAvailable` is true when the latest version is newer, and
`POST /providers/:id/install` performs the update when `updateCommand` is not null.

`usageSource` is `claude`, `codex`, `gemini`, `command` or null, and says
whether `GET /usage` reports the provider. `historySource` is `claude`,
`codex`, `gemini`, `grok`, `command` or null, and says whether
`GET /providers/:id/history` can list the tool's earlier sessions.
`accounts` lists the sign-ins the tool can run under: `default` is the
tool's own, and each further one has its own home folder, so it keeps its
own sign-in and usage. `POST /sessions` takes an account id. For a tool
whose agent reporting is turned on per account (`reporting` is `gemini`),
each account also has `reportingEnabled`.
`usageUrl` and `billingUrl` are `https://` links to the vendor's usage and
billing pages, or null when none is configured. A usage snapshot's `plan` is
the subscription tier.

### Usage

```json
{
  "providerId": "anthropic",
  "accountId": "default",
  "plan": "max",
  "signedIn": true,
  "windows": [
    { "label": "5-hour", "usedPercent": 42.5, "resetsAt": "2026-09-30T08:00:00.000Z" },
    { "label": "7-day", "usedPercent": 12, "resetsAt": "2026-10-03T05:00:00.000Z" },
    { "label": "7-day Fable 5.1", "usedPercent": 48, "resetsAt": "2026-10-03T05:00:00.000Z" }
  ],
  "credits": null,
  "fetchedAt": "2026-09-30T03:12:01.120Z",
  "error": null
}
```

Each window is one rate limit of the provider's subscription: the plan's
own windows first, then the further limits the vendor lists (every
per-model weekly window Claude reports, such as Fable; each window of
Codex's additional limits, labelled with the model or feature they meter),
then Claude's "Extra usage" share of the monthly spend limit when extra
usage is enabled, whose `resetsAt` is the end of the spend period when the
vendor reports it. `credits` is a prepaid credit balance
(Codex), or null when the account has none, it is unlimited, or it is
unknown. When the provider is not signed in or the lookup failed,
`windows` is empty and `error` says why; `signedIn` is false when no
sign-in was found for that account, true when one was read, and null when
that is unknown. One snapshot is reported per account. The manager reads the tool's own sign-in (Claude Code's
credentials file or macOS keychain item, Codex CLI's `auth.json`, Gemini
CLI's keychain item, encrypted credentials file or `oauth_creds.json`) and
asks the vendor's usage
endpoint; a `command` source runs a program that prints
`{ plan?, windows: [{ label, usedPercent | remainingPercent, resetsAt? }] }`.
A window whose share is not a number (missing, null or blank) is left out
rather than shown as unused. Snapshots are cached for a minute.

### History

```json
{
  "providerId": "anthropic",
  "accountId": "default",
  "sessions": [
    { "id": "581893e5-a93d-5e49-968b-1c1c277d3255", "title": "Fix the login bug", "cwd": "/Users/me/src/app", "startedAt": "2026-10-01T13:26:53.713Z", "updatedAt": "2026-10-01T13:49:28.000Z" }
  ],
  "total": 42,
  "fetchedAt": "2026-10-01T14:00:00.000Z",
  "error": null
}
```

The tool's own earlier sessions, newest first, read from where the tool
keeps them under the account's home folder: Claude Code's
`projects/<folder>/<id>.jsonl` transcripts, Codex CLI's
`sessions/<date>/rollout-*.jsonl` files, Gemini CLI's
`tmp/<project>/chats/session-*.jsonl` files and Grok Build's
`sessions/<folder>/<id>/summary.json`. Sub-agent sessions are left out.
`id` is what the tool resumes by (`POST /sessions` with `resume`); `title` is
the session's name or first prompt, or null; `cwd` is the folder the session
ran in, or null when the tool did not record it. Claude Code and Gemini CLI
find a session only from its own folder, so a client should resume with that
`cwd`. `updatedAt` is when the transcript last changed. `sessions` holds at
most `limit` entries of the `total` found. Only the head of each transcript
is read, and a transcript is read again only when it changed; the list is
cached for a few seconds. `error` says why nothing could be listed; a tool
that has never run lists no sessions and no error.

### Session

```json
{
  "id": "b45b6822d158",
  "name": "Claude Code",
  "provider": { "id": "anthropic", "vendor": "Anthropic", "tool": "Claude Code", "color": "#D97757", "monogram": "A", "iconUrl": null },
  "cwd": "/Users/me/src/app",
  "resume": null,
  "task": null,
  "account": { "id": "default", "label": "Default" },
  "clone": null,
  "pid": 3518,
  "status": "running",
  "exitCode": null,
  "signal": null,
  "activity": "active",
  "lastOutputAt": "2026-09-30T03:12:01.120Z",
  "createdAt": "2026-09-30T03:10:44.001Z",
  "exitedAt": null,
  "cols": 120,
  "rows": 32,
  "attachedClients": 1,
  "model": { "name": "claude-opus-4-5", "displayName": "Opus 4.5", "source": "report" },
  "toolSessionId": "581893e5-a93d-5e49-968b-1c1c277d3255",
  "reporting": { "state": "active", "reason": null },
  "agents": [ /* Agent */ ],
  "shells": [{ "id": "shell-3" }]
}
```

* `status` is `running` or `exited`. Exited sessions stay listed, with their
  final screen, until a client removes them.
* `exitedAt` is null while running, then an ISO 8601 timestamp recorded when
  the manager observes the process exit. It stays fixed and is included in
  session responses, updates, and reconnect snapshots. Use it with `createdAt`
  for completed session duration; `lastOutputAt` only records terminal output.
* `pid` is null while the process is still starting (Windows connects the
  console asynchronously) and after it exits. A `session.updated` event
  carries it with the first output.
* `activity` is `active` while the terminal is producing output and `quiet`
  after a short pause.
* `resume` is the id of the tool's own session that was resumed, or null.
* `task` is `install` for a session that runs npm to install or update the
  provider's tool, `upgrade` for the session that runs npm to upgrade the
  manager itself (its `provider` is a stand-in with id `agent-guild`),
  `clone` for a session that runs `git clone` for a GitHub repository (its
  `provider` is a stand-in with id `github`), and null for a session that
  runs the tool itself.
* `clone` is `{ repo, path, accountId }` for a clone session: the
  repository as owner/name, the folder it is cloned into and the GitHub
  account id. Null otherwise.
* `account` is the provider account the tool runs under, or null for an
  install or upgrade session.
* `model` is the main model the tool is using, or null while unknown.
  `source` is `report` when the tool said so (see
  [agent-reporting.md](agent-reporting.md)), `screen` when the name was
  matched on the terminal screen by the provider's `modelPattern`, or `args`
  when it came from a `--model` argument. Reports win over the screen, which
  wins over arguments.
* `toolSessionId` is the id the tool gave its own session, reported by its
  hooks (see [agent-reporting.md](agent-reporting.md)), or null. It names
  the session in `GET /providers/:id/history` and resumes it later; it stays
  after the session exits.
* `reporting` says whether the tool's agent reporting hooks work, or is null
  for a tool Agent Guild supplies no hooks to. `state` is `pending` until the
  hooks announce themselves, `active` once any hook report arrives,
  `unavailable` when none has arrived some time after the first prompt or
  the tool refused the hooks, `setup_required` when the user has to turn
  reporting on first (Gemini CLI), and `unsupported` when the installed tool
  cannot take hooks for one session. `reason` explains every state but `active`.
* `shells` lists the shell commands the tool is running for the model, as
  its hooks report them, once each has run for about 600 ms; each leaves
  the list when it ends. Every running command is listed; the page draws 16
  and counts the rest. Nothing about the command itself is included.

### Upgrade

The manager's own version check, in `GET /info`, the `hello` message and
`manager.upgrade` events.

```json
{
  "version": "1.2.0",
  "latestVersion": "1.3.0",
  "available": true,
  "command": "/usr/local/bin/npm install -g @oddessentials/agent-guild@1.3.0",
  "guidance": null,
  "pendingVersion": null,
  "installing": false,
  "lastInstall": null
}
```

`version` is the running manager. `latestVersion` comes from the same npm
registry as the provider checks, about once an hour, and is null until the
first check finishes or while the manager is a development build
(`0.0.0-development`), which is never offered an upgrade. `available` is true
when a newer release exists that is not yet installed; `command` is then
what `POST /upgrade` runs, or null with `guidance` when npm is not on PATH.
`pendingVersion` is a newer version whose files are already on disk: the
manager runs from the package npm replaces in place, so after an upgrade the
running process is still the old version until it is restarted
(`POST /shutdown` with `restart`, or `agent-guild restart`). `lastInstall` describes the
last upgrade session: `{ outcome, exitCode, version, installedVersion, at }`
with `outcome` `installed`, `failed`, or `unchanged` when npm exited cleanly
but did not replace the files the manager runs from. It is dropped once a
newer release appears or the files on disk change. After a `failed`
upgrade the files on disk are not trusted, since npm may have replaced
`package.json` before it was stopped: `pendingVersion` is null and
`available` stays true for the same release, so it can be run again. That
holds even once a newer release has replaced the `failed` record, until an
upgrade completes or the files on disk change. A check that fails keeps
the release already known. `installing` is true from the start of an upgrade
session until its npm process has exited, even if the session was removed
meanwhile; `available` and `pendingVersion` are withheld during that time,
because the files on disk are mid-replacement, and `POST /upgrade` answers
409 `upgrade_in_progress`.

### GitHub

The GitHub accounts signed in to Agent Guild, in `GET /github` and
`github.updated` events. Tokens never leave the manager.

```json
{
  "scopes": ["repo", "write:public_key"],
  "appUrl": "https://github.com/settings/connections/applications/Ov23lif6qqYKtXZTb130",
  "keysUrl": "https://github.com/settings/keys",
  "newKeyUrl": "https://github.com/settings/ssh/new",
  "tools": { "git": true, "ssh": true, "sshKeygen": true },
  "signIn": { "status": "pending", "userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device", "expiresAt": "2026-10-01T14:15:00.000Z", "accountId": null, "again": false, "error": null },
  "accounts": [
    {
      "id": 4242, "login": "octo-cat", "name": "Octo Cat", "avatar": "data:image/png;base64,...", "scopes": ["repo", "write:public_key"],
      "needsSignIn": false, "addedAt": "2026-10-01T14:00:00.000Z",
      "ssh": { "status": "ready", "key": "/home/me/.config/agent-guild/github/keys/agent-guild-github-4242", "publicKey": "ssh-ed25519 AAAA... agent-guild github octo-cat (4242)", "verifiedAt": "2026-10-01T14:01:00.000Z", "settingUp": false, "error": null }
    }
  ]
}
```

Sign-in uses GitHub's device flow: `signIn` is `pending` while the user
enters `userCode` at `verificationUri`, then `done` (with `accountId`, and
`again` when that GitHub user was already signed in), `expired`, `denied` or
`failed`; null when none was started or it was cancelled. Accounts are keyed
by GitHub's numeric user id; `login` is display only. `needsSignIn` is true
once GitHub refuses the account's token and its refresh. `ssh.status` is
`none` (no key yet), `unverified` or `ready` (GitHub signed the key in as this
account). `ssh.error` is `{ code, message, manual }`, with `manual` true when
the user must add `publicKey` on GitHub themselves.

### Agent

An agent is a worker that the coding tool reports inside a session, such as a
Claude Code sub-agent. See [agent-reporting.md](agent-reporting.md).

```json
{
  "id": "hook-task-c9df2e9f7dd4e090",
  "name": "codebase_investigator",
  "kind": "subagent",
  "status": "working",
  "detail": "Map the auth flow",
  "foreground": true,
  "startedAt": "2026-09-30T03:11:02.000Z",
  "updatedAt": "2026-09-30T03:11:02.000Z",
  "source": "api"
}
```

`status` is one of `working`, `waiting`, `idle` or `done`. An agent reported
as `done` stays visible for about 15 seconds and is then removed. A session
holds at most 64 agents; a new one displaces the done agent that has
lingered longest. All agents are cleared when their session exits.
`foreground` is true when the tool
waits for the agent; while such an agent is `working`, model reports are
taken to be the agent's and leave the session's `model` unchanged.

## HTTP endpoints

All paths are under `/api/v1`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, name, version, pid }`. No token needed. |
| GET | `/info` | | Manager version, platform, start time, provider config warnings, `upgrade` (an Upgrade object), and `launcher`: the path of the double-click launcher for this platform when the install carries one (a checkout of the repository), else null. |
| POST | `/upgrade` | | `201 { session }`: a session with `task` `upgrade` running the Upgrade `command`. 400 `not_updatable` when no newer release is known, it is already installed on disk, the manager is a development build, or version checks are off. 409 `npm_unavailable` without npm on PATH. 409 `upgrade_in_progress` while one is running. Sessions keep running; the new version is used after the manager restarts. |
| GET | `/providers` | | `{ providers: Provider[] }` |
| POST | `/providers/reload` | | Re-reads `providers.json`. |
| POST | `/providers/:id/reporting` | `{ enabled, account? }` | `{ provider }`: turns agent reporting on or off for one account of a tool that needs it, by running the tool's own `extensions link` or `extensions uninstall`. A link left by an earlier Agent Guild data folder is replaced. 400 `not_applicable` for any other tool, 409 `extension_conflict` when another extension has the same name, 502 `reporting_setup_failed` when the tool's command fails. |
| POST | `/providers/:id/install` | `{ force? }` | `201 { session }`: a session running `npm install -g <package>@<version>`, or `updateCommand` when the tool is installed. 400 `not_updatable` when an installed tool has no `updateCommand`. 503 `release_unresolved` or 409 `release_incomplete` when the release cannot be read or its platform build is not published; nothing is run. 409 `install_in_progress` while one is already running. 409 `provider_in_use` (with `running`, the session count) while the provider's sessions are running, unless `force` is true. |
| GET | `/usage` | | `{ usage: Usage[] }`, one per account of every provider with a `usageSource`. |
| GET | `/model-stats` | | Benchmarks for the models of every provider with a `modelPattern`, from OpenRouter's public model list (Artificial Analysis and Design Arena results), cached for 6 hours. `{ retrievedAt, stale, error, stats, pool, providers, models, sessions }`: `stats` describes each benchmark; `providers[id]` is `{ featured, models }`, a provider's model ids newest first; `models[id]` holds a model's name, context and price, and in `stats`, per benchmark, its `value`, `rank`, `level` (0-100, its standing among the models of all configured tools) and `tier` (S 90+, A 75+, B 50+, C 25+, D below); `sessions[id]` is the model id a session's reported model matched, or null. |
| GET | `/news` | | `{ refreshedAt, refreshing, sources, items }`. `items` are the last 30 days of the built-in feeds, newest first, each `{ id, title, url, discussion, summary, source, sourceId, category, publishedAt }` with `category` `news`, `releases` or `research`. A coding tool's own release feed is included only while that tool is installed. `sources` lists each feed with its `error` and the time it last answered. Feeds that are due are re-read in the background; a `news.updated` event follows. |
| GET | `/changelog` | | `{ refreshing, okAt, error, releases }`: Agent Guild's own releases from GitHub, newest first, each `{ version, url, publishedAt, sections: [{ title, changes }] }`, where a change is a list of text runs. Re-read hourly in the background; a `changelog.updated` event follows. |
| GET | `/providers/:id/history?account=&limit=` | | `{ history }`: a History object for one account (default `default`; 404 `unknown_account`), with at most `limit` sessions (default 100, at most 500). 400 `history_unsupported` when the provider has no `historySource`. |
| GET | `/github` | | `{ github }`: a GitHub object. |
| POST | `/github/sign-in` | | `202 { github }`: starts a device-flow sign-in; the manager polls GitHub and announces the result in `github.updated`. |
| DELETE | `/github/sign-in` | | `{ github }`: cancels it. |
| DELETE | `/github/accounts/:id` | | `{ github }`: forgets the account's sign-in. Its key stays in the data folder and on GitHub. |
| GET | `/github/accounts/:id/repos?parent=&refresh=1` | | `{ repos: { accountId, fetchedAt, truncated, owners, parent, repos } }`: the account's repositories, most recently pushed first, each `{ fullName, owner, ownerType, name, private, fork, archived, description, language, pushedAt, url, target, local }`. `owners` is the account's login, then the organizations among the repositories' owners: where a new repository can be created. With `parent` (a folder; 400 `bad_cwd` when it does not exist), `target` is `<parent>/<name>` and `local` is `absent`, `cloned` (a Git repository whose origin is this repository) or `conflict`. Cached for 5 minutes unless `refresh=1`. |
| POST | `/github/accounts/:id/repos` | `{ owner, name, description?, private?, readme? }` | `201 { repo }`: creates a repository under the account or the organization `owner`, private unless `private` is false, with a README unless `readme` is false. 409 `repo_exists`, 403 `repo_forbidden` when GitHub refuses the owner. |
| POST | `/github/accounts/:id/ssh` | | `{ account }`: makes the account's SSH key if it has none, adds it to the account, and checks that GitHub signs it in as this account. A failure is reported in `account.ssh.error`. |
| POST | `/github/clone` | `{ account, repo, parent }` | `201 { session }`: a session with `task` `clone` running `git clone` for `repo` (owner/name) into `<parent>/<name>` over SSH with the account's key. 409 `ssh_not_ready`, `git_unavailable`, `clone_exists` or `folder_conflict` (both with `target`), or `clone_in_progress`. |
| GET | `/sessions` | | `{ sessions: Session[] }` |
| POST | `/sessions` | `{ providerId, account?, cwd?, cols?, rows?, name?, args?, resume? }` | `201 { session }` |
| GET | `/sessions/:id` | | `{ session }` |
| PATCH | `/sessions/:id` | `{ name }` | `{ session }`. `name` must be a non-empty string; it is trimmed to 80 characters. |
| POST | `/sessions/:id/stop` | | Ends the process. The session stays listed as exited. |
| DELETE | `/sessions/:id` | | Ends the process if needed and removes the session. |
| POST | `/sessions/:id/agents` | Agent report | `{ agent }`, or `{ agent: null }` after a removal, for a `done` report about an agent that was never reported, or for `{ finishForeground: true }`, which marks every foreground agent still working as done. |
| POST | `/sessions/:id/model` | `{ model, displayName? }` | `{ model }`. Sets the session's model with source `report`, unless a foreground agent is working; then the current model is returned unchanged. |
| POST | `/sessions/:id/tool-session` | `{ toolSessionId }` | `{ toolSessionId }`. Records the id the tool gave its own session: one printable line of at most 200 characters. 409 once the session has exited. |
| POST | `/sessions/:id/reporting` | | `{ reporting }`: the tool's hooks announce themselves, which makes `reporting.state` `active`. |
| POST | `/sessions/:id/shells` | `{ shell, key \| bucket \| task, match?, agentId?, persist?, pids?, endsWithAgent?, tasks? }` | `{ ok }`. `shell` is `start`, `end`, `background` (with the tool's `task` id, or the `pids` of the processes it left running), `waiting` (a permission request, which hides the command), `asked` (one that ends the command with its turn), `running` (`tasks` lists the background tasks still running; any other ends) or `reset` (every command ends). `key` is the tool's call id; without one, `bucket` groups identical calls, which end in the order they started. `match` is a hash of the command, which pairs a permission request with it; `persist` keeps a command past the end of its turn, and `endsWithAgent` ends a background one with its sub-agent. |
| POST | `/shutdown` | `{ force?, restart? }` | `202 { ok, running, restart }`: stops the manager and every session. 409 `sessions_running` (with `running`, the session count) while any session is running, unless `force` is true. From the 202 on, `POST /sessions` and `POST /providers/:id/install` answer 503 `manager_stopping`. Events clients get `manager.stopping` first and `manager.stopped` last, after the sessions have ended and before the API closes. With `restart` true, the manager then starts a new manager from the package on disk, on the same port and with the same token, before it exits; the new one runs whatever version is installed, so this is how an upgrade's `pendingVersion` is put to use. Clients reconnect to it as to any manager; its `hello` is the new source of truth. |

`cwd` defaults to the user's home folder and must be an existing folder. A
leading `~` is expanded. `args` are appended to the provider's configured
arguments. `resume` is an id or name of one of the tool's own sessions; it is
substituted for `{id}` in the provider's `resumeArgs` (400 `resume_unsupported`
when the provider has none). `account` is one of the provider's account ids
(404 `unknown_account` otherwise) and defaults to `default`; the account's
home folder is created before its first session.

`POST /sessions/:id/agents`, `POST /sessions/:id/model`,
`POST /sessions/:id/tool-session`, `POST /sessions/:id/reporting` and `POST /sessions/:id/shells` also accept the
per-session report token instead of the API token, in an
`X-Agent-Guild-Report-Token` header. The manager gives that token only to the
processes inside that session. Without the API token, an unknown session id
and a wrong report token both return 401.

Request bodies are limited to 64 KB (413 above that). WebSocket messages are
limited to 1 MB.

## WebSockets

Messages in both directions are JSON text frames.

### `GET /api/v1/events`

This socket pushes changes to every session. It is server-to-client only.

| Message | Meaning |
| --- | --- |
| `{ type: "hello", version, pid, launcher, upgrade, sessions }` | Sent first. The manager's version and pid, its `launcher` path (as in `/info`), the full session list and the manager's Upgrade object. |
| `{ type: "session.created", session }` | A session was started by any client. |
| `{ type: "session.updated", session }` | Status, activity, agents, name or size changed. |
| `{ type: "session.removed", sessionId }` | A session was removed. |
| `{ type: "providers.updated", providers }` | The provider list changed: a version check finished, `providers.json` was reloaded, or an install session ended. |
| `{ type: "news.updated" }` | A news refresh finished; fetch `/news` again. |
| `{ type: "changelog.updated" }` | A refresh of the release list finished; fetch `/changelog` again. |
| `{ type: "github.updated" }` | A GitHub sign-in, account or SSH setup changed; fetch `/github` again. |
| `{ type: "manager.upgrade", upgrade }` | The manager's own version check changed: a newer release was found, or an upgrade session ended. |
| `{ type: "manager.stopping", running, restart }` | A client asked the manager to stop. `running` sessions are being ended. A client should show that the manager was stopped on purpose, not that it is unreachable. `restart` is true when a new manager will take over; a client should then say it is waiting for that one rather than tell the user how to start one. |
| `{ type: "manager.stopped", remaining, restart }` | The last event before the socket closes. `remaining` is how many session processes had not confirmed their exit when the manager gave up waiting (about five seconds); 0 means every session has ended. `restart` is as in `manager.stopping`. A socket that closes after `manager.stopping` without this event means the manager went away before it could confirm. |

After a reconnect, treat `hello` as the new source of truth.

### `GET /api/v1/sessions/:id/terminal`

This socket is the interactive terminal for one session. Any number of
clients may attach to the same session.

Server to client:

| Message | Meaning |
| --- | --- |
| `{ type: "snapshot", data, cols, rows, session }` | Always first. `data` is a VT escape sequence stream that redraws the current screen and scrollback. Reset the terminal and write it. |
| `{ type: "data", data }` | Terminal output, in order, directly after the snapshot. |
| `{ type: "resize", cols, rows }` | Another client changed the terminal size. |
| `{ type: "exit", exitCode, signal }` | The process ended. Also sent after the snapshot when attaching to an exited session. |
| `{ type: "removed" }` | The session was removed. The socket then closes with code 4410. |

Client to server:

| Message | Meaning |
| --- | --- |
| `{ type: "input", data }` | Keystrokes or pasted text, exactly as a terminal would send them. |
| `{ type: "resize", cols, rows }` | Resize the terminal. The last client to resize wins. |

### Terminal queries: clients must not answer

Programs ask the terminal questions by writing escape sequences, for
example "where is the cursor?" (`CSI 6 n`). The manager answers these once
per session from its own copy of the screen, whether zero or many clients
are attached. A client that renders the terminal must therefore not answer
them itself, or the program receives duplicate replies as keyboard input.

The manager answers cursor position and status reports (`CSI n`), device
attributes (`CSI c`, `CSI > c`, `CSI = c`), mode reports (`CSI $ p`,
`CSI ? $ p`), setting reports (`DCS $ q`) and colour queries for OSC 10, 11
and 12. It reports the web page's theme colours: foreground `#e6e9ef`,
background `#0f1115`. A client built on xterm.js can copy
`suppressQueryReplies` from `web/app.js`.

Close codes: `4404` means the session does not exist, `4410` means it was
removed, and `4008` means the client fell too far behind. After a `4008` or a
network drop, reconnect and the snapshot brings the client up to date.
