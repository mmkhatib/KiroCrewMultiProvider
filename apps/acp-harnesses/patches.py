"""Runtime patches that make external ACP harnesses selectable in Kiro Crew.

Everything here rebinds PRIVATE Kiro Crew internals. None of it is a documented
extension point, so :func:`assert_symbols` runs first and refuses the whole
registration if anything moved — a half-applied patch yields a backend that dies
at session start, which is far worse than an option that never appears.

The five things a harness needs
------------------------------
1. membership in ``ACP_BACKENDS_KNOWN``   — else provider construction raises
2. membership in the selectable set       — else config load coerces it to kiro
3. the right argv at spawn                — else it silently spawns kiro-cli
4. the right ACP dialect                  — protocol version + how models are set
5. MCP servers on the session             — else the harness has zero Crew tools

Dialects
--------
``claude``   claude-agent-acp. Protocol version 1. Advertises NO ``models`` at
             ``session/new``; model selection is a ``configOptions`` entry set
             via ``set_config_option("model", …)``. Accepted values (adapter
             v0.70.0): default | sonnet | claude-fable-5[1m] | opus | haiku.
``standard`` A spec-compliant ACP agent (Gemini CLI ``--experimental-acp``,
             codex-acp). Protocol version 1, but models come from
             ``session/new`` → ``models.availableModels`` and are set with the
             standard ``session/set_model``.
``native``   kiro-cli / KAS. Left entirely alone.

Both external dialects ride Kiro Crew's ``_is_claude`` branch, because that is
the branch carrying protocol version 1 (``PROTOCOL_VERSION_CLAUDE``); the kiro
branch uses the date-stamped ``"2025-08-22"`` that only kiro-cli speaks. Where
``standard`` diverges from claude — model setting — it is re-patched below.
"""

from __future__ import annotations

import asyncio
from typing import Any

# Serializes spawns that read the module-global claude argv cache. That cache is
# process-wide with no per-client key, so two harnesses starting concurrently
# would otherwise race and one could spawn the other's binary.
_spawn_lock = asyncio.Lock()

_HARNESSES: dict[str, dict] = {}
_originals: dict[str, Any] = {}


def assert_symbols() -> list[str]:
    """Return a list of missing internals. Empty means safe to patch."""
    missing: list[str] = []
    try:
        from kiro_crew.acp import client as C
        from kiro_crew.acp import types as T
    except Exception as exc:  # noqa: BLE001
        return [f"cannot import kiro_crew.acp ({exc})"]

    for mod, name in (
        (T, "ACP_BACKENDS_KNOWN"),
        (T, "ACP_BACKEND_CLAUDE"),
        (C, "AcpClient"),
        (C, "PROTOCOL_VERSION_CLAUDE"),
        (C, "_resolve_claude_acp_bin"),
        (C, "_claude_acp_argv_cache"),
        (C, "METHOD_SET_MODEL"),
    ):
        if not hasattr(mod, name):
            missing.append(f"{mod.__name__}.{name}")

    for attr in ("_spawn", "_is_claude", "set_model", "_apply_startup_model",
                 "_capture_available_models", "_claude_session_mcp_servers"):
        if not hasattr(C.AcpClient, attr):
            missing.append(f"AcpClient.{attr}")

    # The selectable set lives in one of two places depending on build vintage.
    try:
        import kiro_crew.acp_backends  # noqa: F401
    except ImportError:
        if not hasattr(T, "ACP_BACKENDS_SELECTABLE"):
            missing.append("ACP_BACKENDS_SELECTABLE / acp_backends registry")
    return missing


def _widen_known(ids: list[str]) -> None:
    """Add ids to ``ACP_BACKENDS_KNOWN`` — the provider-construction gate."""
    from kiro_crew.acp import types as T

    T.ACP_BACKENDS_KNOWN = frozenset(set(T.ACP_BACKENDS_KNOWN) | set(ids))
    try:  # newer builds own the constant here and re-export it
        from kiro_crew import acp_backends as B

        B.ACP_BACKENDS_KNOWN = frozenset(set(B.ACP_BACKENDS_KNOWN) | set(ids))
    except ImportError:
        pass


def _make_selectable(ids: list[str], log) -> None:
    """Make ids choosable in ``agent.acp_backend``.

    Newer builds expose the sanctioned ``register_selectable_backend``. Older
    ones keep a frozen ``ACP_BACKENDS_SELECTABLE``; rebinding the MODULE
    attribute works there because ``config.loader._normalize_acp_backend``
    re-imports the name from the module on every call (a deferred, function-local
    import that dodges an ``acp`` package cycle) rather than caching it.
    """
    try:
        from kiro_crew.acp_backends import register_selectable_backend

        for i in ids:
            register_selectable_backend(i)
        log.info("acp-harnesses: registered via acp_backends registry")
        return
    except ImportError:
        pass

    from kiro_crew.acp import types as T

    T.ACP_BACKENDS_SELECTABLE = frozenset(set(T.ACP_BACKENDS_SELECTABLE) | set(ids))
    log.info("acp-harnesses: registered by widening ACP_BACKENDS_SELECTABLE")


def _patch_client(log, inject_mcp: bool) -> None:
    from kiro_crew.acp import client as C

    AcpClient = C.AcpClient
    _originals["_spawn"] = AcpClient._spawn
    _originals["set_model"] = AcpClient.set_model
    _originals["_apply_startup_model"] = AcpClient._apply_startup_model
    _originals["_capture_available_models"] = AcpClient._capture_available_models
    _originals["_is_claude"] = AcpClient._is_claude

    def _harness(self):
        return _HARNESSES.get(getattr(self, "_acp_backend", "") or "")

    # ── 1. dialect routing ────────────────────────────────────────────────
    # External harnesses ride the claude branch for protocol version 1.
    @property  # type: ignore[misc]
    def _is_claude(self) -> bool:
        b = getattr(self, "_acp_backend", "") or ""
        h = _HARNESSES.get(b)
        return b == C.ACP_BACKEND_CLAUDE or (h is not None and h["dialect"] != "native")

    AcpClient._is_claude = _is_claude

    # ── 2. argv at spawn ──────────────────────────────────────────────────
    async def _spawn(self) -> None:
        h = _harness(self)
        if h is None or h["dialect"] == "native":
            return await _originals["_spawn"](self)

        argv = h.get("_argv")
        if not argv:
            # claude keeps Kiro Crew's own multi-step resolution (mise, vendored
            # node_modules, augmented PATH); external harnesses use their command.
            argv = await asyncio.to_thread(C._resolve_claude_acp_bin)
            if not argv:
                raise C.AcpError(
                    "acp-harnesses: could not resolve the claude-agent-acp entry "
                    "script. Install it with 'npm i -g "
                    "@agentclientprotocol/claude-agent-acp'."
                )

        # The cache is a module GLOBAL with no per-client key, so hold the lock
        # across the whole spawn and restore afterwards.
        async with _spawn_lock:
            saved = C._claude_acp_argv_cache
            C._claude_acp_argv_cache = list(argv)
            try:
                return await _originals["_spawn"](self)
            finally:
                C._claude_acp_argv_cache = saved

    AcpClient._spawn = _spawn

    # ── 3. model setting ──────────────────────────────────────────────────
    # claude-agent-acp has no session/set_model; it exposes a `model`
    # configOption. Spec-compliant agents are the opposite.
    async def set_model(self, model_id: str) -> None:
        h = _harness(self)
        if h is not None and h["dialect"] == "standard":
            await self._send_request(
                C.METHOD_SET_MODEL,
                {"sessionId": self._session_id, "modelId": model_id},
            )
            self._model = model_id
            self._resolved_model_id = model_id
            return
        return await _originals["set_model"](self, model_id)

    async def _apply_startup_model(self) -> None:
        h = _harness(self)
        if h is not None and h["dialect"] == "standard":
            if not self._model or self._model == C.DEFAULT_MODEL:
                return
            await self._send_request(
                C.METHOD_SET_MODEL,
                {"sessionId": self._session_id, "modelId": self._model},
            )
            return
        return await _originals["_apply_startup_model"](self)

    AcpClient.set_model = set_model
    AcpClient._apply_startup_model = _apply_startup_model

    # ── 4. model LIST ─────────────────────────────────────────────────────
    # claude-agent-acp returns no `models` key at all (verified v0.70.0:
    # session/new yields sessionId, modes, configOptions). Its model list is the
    # `model` configOption's options, so surface those in the same shape the
    # dashboard already understands.
    def _capture_available_models(self, session_resp: dict) -> None:
        _originals["_capture_available_models"](self, session_resp)
        if getattr(self, "_available_models", None):
            return
        try:
            for opt in session_resp.get("configOptions") or []:
                if opt.get("id") != "model":
                    continue
                captured = [
                    {
                        "modelId": str(o.get("value")),
                        "name": str(o.get("name") or o.get("value")),
                        "description": str(o.get("description") or ""),
                    }
                    for o in opt.get("options") or []
                    if o.get("value")
                ]
                if captured:
                    self._available_models = captured
                    cur = opt.get("currentValue")
                    if isinstance(cur, str) and cur:
                        self._resolved_model_id = cur
                break
        except Exception:  # noqa: BLE001 - never break session init over a list
            log.debug("acp-harnesses: configOptions model capture failed", exc_info=True)

    AcpClient._capture_available_models = _capture_available_models

    # ── 5. MCP servers ────────────────────────────────────────────────────
    # The public core returns [] here, and the claude adapter does not read
    # kirocrew.mcp.json itself — so a claude session otherwise has ZERO Kiro Crew
    # tools (no cron, no spawn, no monitor). Falls back to [] on any error, which
    # is exactly the stock behaviour.
    if inject_mcp:
        def _claude_session_mcp_servers(self) -> list:
            try:
                return self._pooled_mcp_servers() or []
            except Exception:  # noqa: BLE001
                log.debug("acp-harnesses: MCP injection failed", exc_info=True)
                return []

        AcpClient._claude_session_mcp_servers = _claude_session_mcp_servers


def apply(harnesses: list[dict], *, inject_mcp: bool, log) -> list[str]:
    """Register *harnesses* and patch the client. Returns the ids registered."""
    missing = assert_symbols()
    if missing:
        raise RuntimeError(
            "Kiro Crew internals moved; refusing to patch. Missing: "
            + ", ".join(missing)
        )

    from kiro_crew.acp import types as T

    ids: list[str] = []
    for h in harnesses:
        hid = str(h.get("id") or "").strip()
        if not hid or not h.get("enabled", True):
            continue
        dialect = str(h.get("dialect") or "standard")
        if dialect == "native":
            continue  # kiro-cli / KAS already work; nothing to do
        entry = {
            "id": hid,
            "label": str(h.get("label") or hid),
            "dialect": dialect,
            "_argv": ([str(h["command"])] + [str(a) for a in h.get("args") or []])
            if h.get("command")
            else None,
        }
        if dialect != "claude" and not entry["_argv"]:
            log.warning("acp-harnesses: %r has no command; skipping", hid)
            continue
        _HARNESSES[hid] = entry
        ids.append(hid)

    if not ids:
        return []

    external = [i for i in ids if i != T.ACP_BACKEND_CLAUDE]
    if external:
        _widen_known(external)
    _make_selectable(ids, log)
    _patch_client(log, inject_mcp)
    return ids
