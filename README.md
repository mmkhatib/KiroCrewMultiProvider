# kirocrew-acp-harnesses

A Kiro Crew app that makes any **ACP-speaking coding agent** usable as the
backend — Claude Code, Gemini CLI, Codex CLI — running your own local installs,
and lets you **hot-swap provider and model from the chat's own model picker**,
mid-conversation, without a restart.

## Where Kiro Crew stands, by version

| | 0.5.x | 0.6.0+ (native) | with this app |
|---|---|---|---|
| Claude Code / Codex selectable | no — coerced back to kiro-cli | yes, Developer → Agent Backend | yes |
| Gemini CLI | no | no id at all | yes |
| Where you switch | — | Developer tab, behind Developer Mode | the chat model picker |
| Switch takes effect | — | after a gateway restart | immediately, in the open chat |
| Provider + model in one pick | — | no (two separate controls) | yes — `Gemini CLI › gemini-2.5-pro` |
| Chat picker lists the live backend's models | no (always kiro-cli's) | no (always kiro-cli's) | yes |
| Kiro Crew MCP tools on Claude | none | native | native on 0.7, restored on 0.5 |

On 0.5.x a persisted `agent.acp_backend = "claude"` was rejected on every config
load (`Ignoring agent.acp_backend 'claude' (not selectable in this build)`), and
the workaround was editing `kiro_crew/acp/types.py` inside the install, which
every update wipes. This app patches **in-process at gateway startup** instead,
so nothing on disk changes and an update cannot remove it. On 0.6+ the
registration half overlaps the native one and is harmless; the in-chat
hot-swap, Gemini and the merged picker are what the app still adds.

## What you get

| | |
|---|---|
| Provider + model switching | one list, in the dashboard's **own** chat model picker |
| How a pick reads | `Claude Code › opus`, `Gemini CLI › gemini-2.5-pro` |
| Switching cost | applied in-process — **no restart** |
| Existing chats | switch too: the session is relaunched on the new harness |
| In-chat model picker | corrected to stop listing only kiro-cli's catalogue |
| Harnesses | Claude Code, Gemini CLI, Codex CLI (adapter), KAS |

Selecting `Gemini CLI › gemini-2.5-pro` sets the backend *and* the model in one
click. There is no separate control to find — the app adds no UI of its own.

### Hot-swapping in an open chat

Picking a row from another provider, in a chat that is already running:

1. persists `agent.acp_backend` (and `agent.member_acp_backend`) and rebuilds
   the provider factory in-process (`reload_provider_factory`);
2. reloads **that chat's** session (`POST /api/chat/slots/{slot}/reload`), which
   relaunches it on the new harness with the conversation kept — without this
   the open chat would keep running the provider it started on;
3. sets the model on the new session.

A pick within the same provider skips steps 1–2 and is an ordinary model switch.

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
4. Open the chat model picker — every harness is now listed as `Provider › model`.
   This first relaunch is the only one you need; switching between harnesses
   afterwards takes effect immediately.

After **updating** the app, fully relaunch again: the startup patches and the
shell injection only change on a new gateway process.

Confirm it ran — this line is logged at WARNING so the shipped
`agent.log_level` actually records it:

```
acp-harnesses: registered 'claude', 'gemini' — selectable as agent.acp_backend.
```

## How the UI gets there

On 0.5.x Kiro Crew had **no** native control for `agent.acp_backend` (the field
was hardcoded `enum=["", "kas"]`); 0.6+ has one, but only in the Developer tab
and restart-based. Either way a third-party `ui.pages` entry renders the
**"Agent-only app — no visual interface"** placeholder, because
`entryPoint`/`mountFunction` are manifest fields the shipped bundle never reads,
so an app cannot add a page of its own.

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

The injected script **touches no DOM at all**. Grafting nodes into React's tree
gets them destroyed on the next reconciliation, and the class names to anchor to
are build-hashed and change on every Kiro Crew update — so 2.0.0 put a pill in a
shadow root, and 2.1.0 dropped even that. It intercepts the **data layer**
instead, which React has no opinion about: `window.fetch` is wrapped once, and
the harnesses reach the user through the dashboard's own picker.

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
aiohttp application. But it does not need to — the injected script wraps
`window.fetch` and rewrites the response **in the client that consumes it**.

What it intercepts — the slot-model POST is what makes one merged picker
possible, the rest keep the picker's display consistent with it:

| call | what happens |
|---|---|
| `GET /api/models` | kiro's live rows are kept as the `Kiro CLI` group; one group per registered harness is appended. Each entry is `Provider › model`. |
| `POST /api/chat/slots/{slot}/model` (and `/slots/model`) | the composite is split back into `(backend, model)`. If the backend changed it is switched and the chat's session reloaded first; then the request is forwarded carrying a **plain** model id, and the response's model is renamed back to the composite. |
| `GET /api/agents/resolved-model` | plain id → composite, for a slot that has no model of its own yet. |
| `GET /api/chat/slots[/{slot}]` | each slot's stored `model` → composite. |
| WebSocket `/api/ws`, `slots` frame | same, for the live slots push. |

The composite therefore never reaches the server — the core only ever sees a
model string it already accepts.

**Why the slots feeds are rewritten too.** The composer chip does not show the
pick it sent; it shows `slot.model` from the store, matched by *name* against
the list (`displayModel`). The store is written by the WebSocket `slots` push
and `GET /api/chat/slots`, both carrying the server's plain id (`opus`), which
matches no composite row — so the chip fell back to `auto` on the next push and
after every reload. Both feeds are rewritten to the composite the list uses.
That is also why the script is a synchronous `<head>` tag rather than a
deferred `<body>` one: `window.WebSocket` has to be wrapped before the SPA
opens `/api/ws`. Until `/state` answers, intercepted calls and socket frames
wait (bounded at 5 s) instead of passing through, so the picker's first
`/api/models` call — which react-query never refetches once it holds a live
list — cannot cache the stock kiro-only list.

**Why the composite lives in `model_name`.** The chat picker maps the array with
`{name: e.model_name}` and ignores `model_id` entirely (`providers-*.js`
`fetchAvailableModels`), so `model_name` is *both* the label and the value posted
back. `model_id` is left as the plain id for the Settings/Mochi selector, which
uses `{value: model_id || model_name, label: model_name}` and so needs no
interception at all.

**Why the plain ids pass the guard.** `_model_rejected_reason` rejects only
*top-level canonical registry keys* (`model_registry.json`: `fable-5-1m`,
`opus-4.8-1m`, `sonnet-4.5`, `haiku-4.5`, `auto`, …). `opus`, `sonnet`, `haiku`
and the `gemini-2.5-*` ids are aliases or absent, not keys, so every id this app
forwards passes.

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

- **No true per-chat-tab provider.** Chat slots carry no backend field, and the
  factory closure reads one global `agent.acp_backend` for every session it
  builds, so a switch is global: it applies to all sessions, not just the tab you
  picked in. Per-tab *model* selection already works natively. (This is not a
  hard ceiling — providers *are* constructed per session, so an app-supplied
  factory wrapper consulting a per-slot override could lift it. Not attempted
  here.)
- **A backend switch resets sessions.** `reload_provider_factory()` clears every
  session and drains the warm pool — that is what applying the switch in-process
  means. The open chat's conversation is carried over by the session reload, but
  in-flight turns are not preserved, so switch between turns.
- **Cross-provider context is the least-verified path.** Switching models inside
  one provider is routine. Carrying a conversation from, say, Claude Code to
  Gemini CLI relies on Kiro Crew re-seeding the new harness's session; the code
  path exists but has not been exercised live for every pair. If the new
  provider seems to have forgotten the chat, that is where to look.
- **The Settings default-model selector sets the model only**, not the provider.
  Use the chat picker to switch providers.
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

It also covers Kiro Crew's MCP tools on the Claude backend. On 0.5.x the core
returns `[]` from `_claude_session_mcp_servers()` and the adapter does not read
`kirocrew.mcp.json` itself, so a Claude session has **zero** Crew tools; the app
supplies the pooled list. 0.7.0 fills that seam natively, so the core's own list
is used whenever it is non-empty and the app's is only the fallback. Disable with
`inject_mcp_servers: false`. Disable the UI with `inject_ui: false`.

## Status

First written against Kiro Crew 0.5.0-insider.1; checked against **0.7.0**
source:

- Startup registration, every `assert_symbols()` seam and the shell injection
  verified on a 0.7.0 gateway (`registered 'claude', 'gemini'` logged).
- The picker fixes in 2.5.0 verified against the 0.7.0 dashboard's own data
  flow and chip-matching rule, and in a real browser for the WebSocket rewrite.
- End-to-end chat turns per harness were tested by hand on Claude Code only.

## Licence

MIT — see [LICENSE](LICENSE).
