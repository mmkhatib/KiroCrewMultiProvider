# kirocrew-acp-harnesses

A Kiro Crew app that makes any **ACP-speaking coding agent** selectable as the
backend — Claude Code, Gemini CLI, Codex CLI — running your own local installs.

Kiro Crew ships `ACP_BACKEND_CLAUDE` fully wired but withheld from the
*selectable* set, and has no id at all for other harnesses. So a persisted
`agent.acp_backend = "claude"` is coerced back to kiro-cli on every config load:

```
Ignoring agent.acp_backend 'claude' (not selectable in this build)
```

The usual workaround is editing `kiro_crew/acp/types.py` inside the install
directory — which every Kiro Crew update wipes. This app instead registers the
harnesses **at gateway startup, in-process**, so nothing on disk is patched and
an update cannot remove it.

## Install

**From a registry (recommended, both machines):** add this repo's URL under
**Settings → Apps → External Registries → Add Registry**. It needs no
`app-registry.json` — Kiro Crew scans `apps/*/app.json` and builds the index
itself. The repo must be **public**: registry installs clone credential-free as
a confused-deputy defense, so private repos cannot be reached this way.

**From a local path (development):**

```
kirocrew app install <path>/apps/acp-harnesses
```

On the desktop app the CLI is not on `PATH`. Use the bundled one — and note the
sibling `Scripts\kirocrew.exe` is broken standalone (exits 1, no output):

```
…\KiroCrew\resources\backend-dist\kirocrew-backend\bin\kirocrew.cmd
```

Then, on each machine:

1. **Enable** the app.
2. **Trust** it — narrow, per-app: `agent.apps_trusted` → `["acp-harnesses"]`.
   Do **not** set `agent.apps_allow_third_party=true`, which admits every
   third-party app. An app cannot grant itself trust; that gate is the point.
3. **Restart** Kiro Crew so the startup hook runs.
4. Pick a backend in **Settings → `agent.acp_backend`**.

## Configuring harnesses

`app.json` carries the table. Each row:

| field | meaning |
|---|---|
| `id` | the `agent.acp_backend` value |
| `label` | display name |
| `command` / `args` | the local binary to spawn (empty for `claude` — Kiro Crew resolves the adapter itself) |
| `dialect` | `claude`, `standard`, or `native` |
| `enabled` | include this row |

**Dialects.** `claude` is claude-agent-acp: protocol version 1, and models are a
`configOptions` entry set with `set_config_option`. `standard` is a
spec-compliant agent (Gemini `--experimental-acp`, codex-acp): protocol version
1, models from `session/new` → `models.availableModels`, set with
`session/set_model`. `native` is kiro-cli/KAS and is left untouched.

Adding Codex means installing an ACP adapter (e.g. `codex-acp`) and adding a
`standard` row pointing at it.

## Models

Accepted values differ per harness. For **claude-agent-acp v0.70.0**, verified by
handshake — `session/new` returns *no* `models` key, and the `model`
configOption accepts exactly:

```
default | sonnet | claude-fable-5[1m] | opus | haiku
```

`opus` is Opus 5. Note `claude-opus-5` is a Claude Code **CLI** `--model` name and
is rejected here with `-32603 Invalid value for config option model`.

**Known limitation:** Kiro Crew's `/api/models` endpoint hardcodes
`kiro-cli chat --list-models`, so the model *picker* keeps showing kiro-cli's
catalogue whatever backend is active. This app captures the correct per-session
list, but does not yet reroute that endpoint — set `agent.model` by hand for now.

## Prerequisites

- The harness binary on `PATH` (`gemini`, `codex-acp`, …)
- For Claude: `npm i -g @agentclientprotocol/claude-agent-acp` **and** a local
  `claude` binary (or `CLAUDE_CODE_EXECUTABLE` set)
- **Windows:** `agent.sandbox_allow_unsandboxed_exec = true`. Windows has no
  OS-level sandbox backend, so Kiro Crew otherwise refuses to spawn any harness
  subprocess. The app deliberately does not set this — it lowers a real security
  boundary and should be your explicit choice.

Missing prerequisites are logged as warnings at startup, not fatal errors.

## Safety

The app rebinds **private** Kiro Crew internals — none of this is a documented
extension point. `assert_symbols()` verifies every symbol it depends on and
**refuses the whole registration** if any moved, logging what is missing. A
missing option is visible and recoverable; a half-patched client fails at session
start. It never writes `config.json` and never changes the sandbox setting.

It also restores Kiro Crew's MCP tools on the Claude backend: the public core
returns `[]` from `_claude_session_mcp_servers()` and the adapter does not read
`kirocrew.mcp.json` itself, so a Claude session otherwise has **zero** Crew tools
(no cron, spawn or monitor). Disable with `inject_mcp_servers: false`.

## Status

Written against Kiro Crew 0.5.0-insider.1. The ACP findings above were verified
by direct handshake against the adapter; the app's own patching is **not yet
verified end-to-end** — check `~/.kiro/crew/gateway.log` after restart for:

```
acp-harnesses: registered 'claude', 'gemini' — selectable in Settings …
```

## Licence

MIT — see [LICENSE](LICENSE).
