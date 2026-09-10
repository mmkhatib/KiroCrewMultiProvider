# kirocrew-acp-harnesses

A Kiro Crew app that makes any **ACP-speaking coding agent** usable as the
backend — Claude Code, Gemini CLI, Codex CLI — running your own local installs,
and adds the **provider + model switcher the dashboard doesn't ship**.

Kiro Crew wires `ACP_BACKEND_CLAUDE` fully but withholds it from the *selectable*
set, and has no id at all for other harnesses, so a persisted
`agent.acp_backend = "claude"` is coerced back to kiro-cli on every config load:

```
Ignoring agent.acp_backend 'claude' (not selectable in this build)
```

The usual workaround is editing `kiro_crew/acp/types.py` inside the install
directory — which every Kiro Crew update wipes. This app instead patches
**in-process at gateway startup**, so nothing on disk changes and an update
cannot remove it.

## What you get

| | |
|---|---|
| Provider switcher | pinned bottom-right, on every screen — chat and Settings alike |
| Model switcher | the active backend's real models |
| In-chat model picker | corrected to stop listing kiro-cli's catalogue |
| Harnesses | Claude Code, Gemini CLI, Codex CLI (adapter), KAS |
| MCP tools on Claude | restored (cron, spawn, monitor) |

## Install

**From a registry (recommended):** add this repo's URL under **Settings → Apps →
External Registries → Add Registry**. It needs no `app-registry.json` — Kiro Crew
scans `apps/*/app.json` and builds the index itself. The repo must be **public**:
registry installs clone credential-free as a confused-deputy defense.

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
3. **Fully quit and relaunch** Kiro Crew — not a window reload. `on_startup`
   fires once per gateway process, so the PID has to change.
4. The switcher appears bottom-right on the next page load.

Confirm it ran — this line is logged at WARNING so the shipped
`agent.log_level` actually records it:

```
acp-harnesses: registered 'claude', 'gemini' — selectable as agent.acp_backend.
```

## How the UI gets there

Kiro Crew has **no** native control for `agent.acp_backend` (the field is
hardcoded `enum=["", "kas"]` and the string appears nowhere in the compiled SPA
bundle), and a third-party `ui.pages` entry renders the **"Agent-only app — no
visual interface"** placeholder, because `entryPoint`/`mountFunction` are
manifest fields the shipped bundle never reads. Both were verified against the
running build, not inferred.

So the switcher is injected into the SPA shell instead.
`dashboard/handlers/core.py` serves it as:

```python
html = await loop.run_in_executor(discovery_executor(), _resolve_index_html)
```

`_resolve_index_html` is a **module global looked up per request**, so rebinding
it at startup covers every path that serves the shell — the root route, the
deep-link `spa_fallback` middleware, and the auth middleware's cold-start
`spa_shell_handler`. Patching a route handler would *not* work: aiohttp captures
the function object at `add_get` time and app hooks run afterwards. The injected
tag is a same-origin `<script src>`, which the dashboard CSP
(`script-src 'self' 'unsafe-inline' …`) admits.

The switcher lives in a **shadow root**, not grafted into React's tree: injected
nodes are destroyed on the next reconciliation, and the class names to anchor to
are build-hashed and change on every Kiro Crew update.

**On the shell's security contract.** `core.index` says explicitly: do not inject
server/user/session state, because the shell is served *unauthenticated* on the
cold-start path. This patch honours that reason — the injected bytes are static,
secret-free, and identical for every request and user. Everything dynamic is
fetched by the script from gated `/api/apps/acp-harnesses/*` routes. It is still
a patch to the one response the codebase asks you not to touch; that is a
deliberate, documented tradeoff, not an oversight.

## The model picker

`GET /api/models` runs `kiro-cli chat --list-models --format json`
unconditionally — there is no provider branch — so the picker lists kiro-cli's
catalogue whatever backend is live, and a Claude model reads as *"isn't offered
right now"*.

An app **cannot** override that route: every app route dispatches through one
catch-all at `/api/apps/{app_name}/{path:.*}`, and `AppContext` exposes no
aiohttp application. But it does not need to. The response is a bare JSON array
the SPA reads as `model_id || model_name`, so the injected script wraps
`window.fetch` and rewrites it **in the client that consumes it**.

## Configuring harnesses

`app.json` carries the table. Each row: `id` (the `agent.acp_backend` value),
`label`, `command`/`args` (empty for `claude` — Kiro Crew resolves the adapter
itself), `dialect`, `enabled`, `models`.

**Dialects.** `claude` is claude-agent-acp: protocol version 1, models are a
`configOptions` entry set with `set_config_option`. `standard` is a
spec-compliant agent (Gemini `--experimental-acp`, codex-acp): protocol version
1, models from `session/new` → `models.availableModels`, set with
`session/set_model`. `native` is kiro-cli/KAS and is left untouched.

| harness | id | ships | needs |
|---|---|---|---|
| Claude Code | `claude` | **on** | `claude-agent-acp` + a local `claude` |
| Gemini CLI | `gemini` | **on** | `gemini` on PATH |
| Codex CLI | `codex` | off | an ACP adapter on PATH — see below |
| KAS | `kas` | off | nothing; kiro-cli/KAS already work natively |

**Codex** does not speak ACP natively. Install an adapter — e.g.
[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
— so `codex-acp` is on PATH, then flip its row to `"enabled": true`.

### Models

For **claude-agent-acp v0.70.0**, verified by handshake: `session/new` returns
*no* `models` key, and the `model` configOption accepts exactly
`default | sonnet | claude-fable-5[1m] | opus | haiku`. `opus` is Opus 5. Note
`claude-opus-5` is a Claude Code **CLI** name and is rejected here with
`-32603 Invalid value for config option model`.

## Known limits

- **Switching backend needs a restart.** The ACP client is built from config at
  startup and pooled per backend, so a running gateway keeps the old one. The
  switcher says so when you change provider. Changing *model* does not.
- **No true per-chat-tab provider.** Chat slots carry no backend field and the
  client is pooled per backend, so the switcher is global — it applies to new
  sessions. Per-tab *model* selection already works natively.
- **Windows:** `agent.sandbox_allow_unsandboxed_exec = true` is required.
  Windows has no OS-level sandbox backend, so Kiro Crew otherwise refuses to
  spawn any harness subprocess. The app deliberately does not set this — it
  lowers a real security boundary and should be your explicit choice.

## Safety

The app rebinds **private** Kiro Crew internals — none of it is a documented
extension point. `assert_symbols()` verifies every symbol it depends on and
**refuses the whole registration** if any moved, logging what is missing. The UI
injection is failure-isolated from the ACP patching: if the shell seam moves, the
harnesses still register and stay usable via `config.json`.

Config writes go through `update_config_locked` — the sanctioned atomic writer
with an advisory sidecar lock — so a concurrent Settings save cannot interleave.
The app never changes the sandbox setting.

It also restores Kiro Crew's MCP tools on the Claude backend: the public core
returns `[]` from `_claude_session_mcp_servers()` and the adapter does not read
`kirocrew.mcp.json` itself, so a Claude session otherwise has **zero** Crew tools.
Disable with `inject_mcp_servers: false`. Disable the UI with `inject_ui: false`.

## Status

Written against Kiro Crew 0.5.0-insider.1. Every seam above was read from the
installed build and the ACP values verified by direct handshake. **Not yet
verified against a live gateway** — check `gateway.log` after restart for the
registration line.

## Licence

MIT — see [LICENSE](LICENSE).
