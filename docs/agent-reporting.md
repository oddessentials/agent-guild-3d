# Reporting agents and the model

A coding tool often starts helper agents inside one session. Agent Guild shows
each reported agent as a small icon on the session's card. Terminal output
alone cannot tell us reliably when an agent starts or stops, so the tool (or a
hook it runs) reports agents explicitly. The same channels report the main
model the tool is using, which the card shows next to the session's status,
and the id the tool gives its own session, which the card shows so the
session can be found in the tool's history and resumed later.

Every terminal the manager starts has these environment variables:

| Variable | Value |
| --- | --- |
| `AGENT_GUILD_SESSION_ID` | The session's id |
| `AGENT_GUILD_PROVIDER` | The provider id, for example `anthropic` |
| `AGENT_GUILD_URL` | The manager's base URL |
| `AGENT_GUILD_REPORT_TOKEN` | A token that can only report agents for this session |
| `AGENT_GUILD_REPORT_FILE` | An owner-only file holding the same token, removed when the session ends |
| `AGENT_GUILD_NODE` | The manager's Node.js binary, which the launcher below runs the reporter with |

There are three ways to report.

## 1. The `agent-guild-report` command

```sh
agent-guild-report explore-1 --name Explorer --status working --detail "Reading src/"
agent-guild-report explore-1 --status done
agent-guild-report explore-1 --remove
agent-guild-report --model gpt-5-codex
agent-guild-report --session 01a0f7a7-387f-7e11-b368-5335205ef1a6
```

Outside an Agent Guild terminal the command does nothing and exits 0, so it is
safe to leave in hooks that also run elsewhere.

Inside an Agent Guild terminal the command is always on PATH: at every start
the manager writes a launcher for it into `bin/` under its data folder and
puts that folder first on each session's PATH. The launcher runs the reporter
with the manager's own Node.js, so hooks need neither a global install nor
`node` on their PATH. Outside Agent Guild, `npm install -g .` or `npm link`
in the Agent Guild folder puts it on PATH; otherwise call it as
`node <agent-guild>/bin/agent-guild-report.mjs`.

## 2. Hooks in Claude Code, Codex CLI, Gemini CLI and Grok Build

`agent-guild-report --hook` reads one hook event as JSON from stdin and
reports what it carries: a sub-agent starting or stopping (`SubagentStart`
and `SubagentStop`, or Gemini CLI's `invoke_agent` tool call on `BeforeTool`
and `AfterTool`), and the main model when the event names it (`model`,
`modelId`, Gemini CLI's `llm_request.model`, or `to_model` on Claude Code's
`PostModelSwitch`), and the tool's own session id (`session_id`) from the
event that opens a session: `SessionStart`, or `BeforeAgent` in Gemini CLI
versions without it. `SessionStart` also tells the manager the hooks run. The
four tools spell these fields differently; all spellings are accepted. An
event that fires inside a sub-agent never sets the main model or the
session id. Each sub-agent appears on the card for as long as it runs,
labelled with its agent type, for example `Explore` or `Plan`.

Agent Guild supplies these hooks itself, for each session only, without
changing the tool's settings: Claude Code loads them as a plugin
(`--plugin-dir`), and Codex CLI takes them, already trusted, as `-c`
overrides, after Agent Guild has checked that the installed Codex accepts
them. Gemini CLI cannot take hooks for one session, so its card has an
**Agent reporting** switch that links an Agent Guild extension with
`gemini extensions link`; its hooks do nothing in sessions started outside
Agent Guild. Grok Build gets them with `--plugin-dir` once `grok --help`
lists that option; the versions released so far do not. To report from a
tool Agent Guild does not supply, or from Grok Build today, add the hooks
yourself:

| Tool | Put the hooks in | Example |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`, or `.claude/settings.json` in one project. Hooks and the status line run only after the workspace-trust prompt for the working folder is accepted | [claude-code-settings.json](../examples/claude-code-settings.json) |
| Codex CLI | `~/.codex/hooks.json`. Codex skips hooks until you trust them: choose "Trust all and continue" when it starts, or run `/hooks`; an edited command needs trusting again. `UserPromptSubmit` follows `/model` changes and shows a sub-agent re-tasked with `send_input` as working again; with the `multi_agent_v2` feature, `followup_task` fires no prompt event, so add `PreToolUse` (no matcher) to see the agent again at its first tool call. Codex starts sub-agents only when asked; `/review` and compaction use internal helpers it never reports | [codex-hooks.json](../examples/codex-hooks.json) |
| Gemini CLI | `~/.gemini/settings.json`. It has no sub-agent events; a sub-agent is the `invoke_agent` tool, so `BeforeTool` and `AfterTool` with `"matcher": "invoke_agent"` report it, labelled with its `agent_name`. A cancelled or denied call gets no `AfterTool`, so `BeforeAgent` and `AfterAgent` close what is left at the turn boundary. `BeforeModel` reports the model | [gemini-settings.json](../examples/gemini-settings.json) |
| Grok Build | `~/.grok/hooks/agent-guild.json`; it also reads `~/.claude/settings.json` hooks. A cancelled sub-agent never gets `SubagentStop`: the `SessionEnd` of its own session closes it (also after Ctrl+C in the parent), and `StopCancelled` closes one that hit its turn limit, made no progress or was refused a permission. Its events do not name the model, so the card uses the model seen on screen | [grok-hooks.json](../examples/grok-hooks.json) |

A `matcher` on the sub-agent events filters by agent type. Leave it out to
show every sub-agent.

The tools run a hook command through a shell that inherits the session's
environment: Claude Code through `sh` (on Windows Git Bash, or PowerShell
when Git Bash is missing), Codex CLI through the login shell (`cmd.exe` on
Windows), Gemini CLI through `bash` (PowerShell on Windows) and Grok Build
through `sh` (PowerShell on Windows). The manager's launcher folder holds an
`sh` script and a `.cmd`, and on purpose no `.ps1`: PowerShell would prefer
the `.ps1`, and its default execution policy refuses to run scripts, which
Gemini CLI and Grok Build do not bypass. If you rely on `npm link` instead
of the manager's launchers on Windows, run
`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` once. Codex CLI's
login shell runs your profile first: a profile that sets `PATH` from
scratch loses the launcher folder, so Codex hooks report "command not
found" while the other tools work. Prepend to `PATH` in the profile
instead, or fall back to `npm link` in the Agent Guild folder.

The hook must reach the manager at `127.0.0.1`. A Gemini CLI container
sandbox (`GEMINI_SANDBOX=docker` or `podman`) runs hooks inside the
container, where neither the command nor the manager is reachable; on Linux,
a Grok Build sandbox profile that restricts child networking blocks the
connection. Gemini CLI's environment-variable redaction (off by default)
removes `AGENT_GUILD_REPORT_TOKEN` because of its name; the reporter then
reads the token from `AGENT_GUILD_REPORT_FILE`. Its strict mode, when
`GITHUB_SHA` or `SURFACE=Github` is set, removes every Agent Guild variable,
so the card shows that the session is not reporting.

Gemini CLI also fires `BeforeModel` for a sub-agent's own requests, with the
sub-agent's model and nothing to tell them apart. A sub-agent reported from a
tool call is a *foreground* agent: its parent waits for it, so a model
reported while it works is taken to be the sub-agent's and the session's
model is left alone. A foreground agent whose end event never arrives, for
example after Esc during a Gemini sub-agent or a call refused in plan
mode, is closed at the next turn boundary of the main session
(`BeforeAgent` or `AfterAgent` in Gemini CLI; a main-thread
`UserPromptSubmit` or `Stop` elsewhere), because the parent cannot be there
while it still waits; until then, at most for the rest of that turn, the
model shown does not change. Two simultaneous `invoke_agent` calls with the
same agent and prompt share one icon, since Gemini's payload carries no
call id.

Some ends are not reported. A Codex CLI sub-agent that is interrupted or
closed while still working, or whose turn ends with an error, fires no
`SubagentStop`, so its icon stays until the session ends; one closed after
it has answered was already reported done. Claude Code
agent teams, which are experimental and off by default, report differently:
an in-process teammate appears each time it handles a message and leaves
the card between messages, and a split-pane teammate is a separate `claude`
process in a tmux pane outside the page that fires no sub-agent event and
whose status line may report its own model as the session's. A stop
reported for an agent that never started is ignored, because Claude Code
also runs internal helpers, for prompt suggestions and side questions,
that only ever fire `SubagentStop`.

Claude Code's status line command reports the model id and display name on
every update:

```json
{ "statusLine": { "type": "command", "command": "agent-guild-report --claude-statusline" } }
```

It prints a short status line (model, folder, context use). To keep your own
status line script, pipe through it: `agent-guild-report --claude-statusline
--passthrough | ~/.claude/statusline.sh`.

Older Claude Code versions without the sub-agent events can use `PreToolUse`
and `PostToolUse` with `"matcher": "Agent|Task"` and the same command. That
style shows the task description, but skips sub-agents launched in the
background, because their tool call returns before they finish. Current
Claude Code versions launch sub-agents in the background unless
`run_in_background` is `false`, so there `PostToolUse` no longer marks the
end of the agent; use `SubagentStart` and `SubagentStop`. With the tool-call
style, register `PostToolUseFailure` too, which is what Esc during the call
fires. Configure one style, not both, or each sub-agent appears twice.

Hook names and payloads belong to the tools and can change. See the hooks
reference of [Claude Code](https://code.claude.com/docs/en/hooks),
[Codex CLI](https://developers.openai.com/codex/hooks),
[Gemini CLI](https://geminicli.com/docs/hooks/reference/) or
[Grok Build](https://docs.x.ai/build/features/hooks) if agents stop
appearing. Each tool shows a failed hook run only on its own side: Claude
Code in the transcript (a failed `SubagentStop` only in `claude --debug`),
Codex CLI and Gemini CLI as a warning, Grok Build as one line in its
scrollback and in `/hooks`. Grok Build reads its hook
files when a session starts, so restart it (or press `r` in `/hooks`) after
adding one.

## 3. In-band escape sequence

A process in the terminal can print an OSC escape sequence. The manager reads
it and the terminal does not display it.

```
ESC ] 7777 ; agent-guild ; <json> BEL
```

For example, from a shell:

```sh
printf '\033]7777;agent-guild;{"agentId":"w1","name":"Worker","status":"working"}\007'
printf '\033]7777;agent-guild;{"model":"grok-4","displayName":"Grok 4"}\007'
printf '\033]7777;agent-guild;{"toolSessionId":"0199a000-0000-7000-8000-000000000000"}\007'
```

This works without network access or extra tools, which suits wrapper scripts.

## Report fields

| Field | Required | Meaning |
| --- | --- | --- |
| `agentId` | yes | Stable id within the session. Reports with the same id update one agent. |
| `name` | no | Label shown on hover. Its first letter is shown in the icon. |
| `status` | no | `working` (default), `waiting`, `idle` or `done`. A `done` for an agent that was never reported is ignored, so report `working` first. |
| `detail` | no | What the agent is doing. |
| `kind` | no | Free-form category, for example `subagent`. |
| `foreground` | no | `true` when the reporting tool waits for this agent. A model reported while a foreground agent works is not applied to the session. |
| `remove` | no | `true` removes the agent immediately. |
| `finishForeground` | no | `true`, sent without an `agentId`, marks every foreground agent still working as done. Send it when the tool is between turns. |

A report with `toolSessionId` instead of an `agentId` or `model` records the
id the tool gives its own session, as its `resume` argument expects it.

## Model without a report

When nothing reports the model, the manager looks for a model name on the
terminal screen using the provider's `modelPattern` (a regular expression;
the built-in providers match names like `claude-opus-4-5`, `gpt-5-codex`,
`gemini-2.5-pro`, `grok-build` and `grok-4`), and before that uses a
`--model` argument. A screen match is a guess: the card marks where the name
came from, and a report always wins.

## Other providers

Any other tool can report through the command or the escape sequence from its
own hook or extension mechanism, where one exists.
