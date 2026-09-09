"""Startup hook: register the configured ACP harnesses.

Runs in-process at gateway startup (Kiro Crew apps execute with full gateway
privileges), which is the only place early enough for the config load path, the
Settings dropdown and the PATCH allowlist to all see the registration.

Deliberately does NOT write config.json. Registering makes a harness
*selectable*; choosing one stays an explicit action in Settings. It also never
touches agent.sandbox_allow_unsandboxed_exec — that lowers a real security
boundary and is the operator's call.
"""

from __future__ import annotations

import shutil
from typing import Any

DEFAULT_HARNESSES = [
    {"id": "claude", "label": "Claude Code", "command": "", "args": [],
     "dialect": "claude", "enabled": True},
]


def _harnesses(ctx: Any) -> list[dict]:
    cfg = getattr(ctx, "config", None) or {}
    rows = cfg.get("harnesses")
    if isinstance(rows, list) and rows:
        return [r for r in rows if isinstance(r, dict)]
    return DEFAULT_HARNESSES


def _preflight(ids: list[str], harnesses: list[dict], log) -> None:
    """Warn about anything that will make a REGISTERED harness fail to start.

    Non-fatal on purpose: the option should still appear, because a missing
    binary is a fixable local condition and a visible-but-failing entry is
    easier to diagnose than a silently absent one.
    """
    by_id = {h.get("id"): h for h in harnesses}
    for hid in ids:
        h = by_id.get(hid) or {}
        cmd = h.get("command") or ("claude-agent-acp" if hid == "claude" else "")
        if cmd and shutil.which(cmd) is None:
            log.warning(
                "acp-harnesses: %r registered but %r is not on PATH — selecting "
                "this backend will fail to spawn until it is installed.", hid, cmd
            )
    if "claude" in ids and shutil.which("claude") is None:
        log.warning(
            "acp-harnesses: the 'claude' binary is not on PATH; claude-agent-acp "
            "needs it. Install Claude Code or set CLAUDE_CODE_EXECUTABLE."
        )

    try:
        from kiro_crew import platform_compat
        from kiro_crew.config.loader import KiroCrewConfig

        agent = KiroCrewConfig.load().agent
        if platform_compat.IS_WINDOWS and not getattr(
            agent, "sandbox_allow_unsandboxed_exec", False
        ):
            log.warning(
                "acp-harnesses: agent.sandbox_allow_unsandboxed_exec is not set. "
                "Windows has no OS-level sandbox backend, so Kiro Crew will refuse "
                "to spawn any of these harnesses until it is true."
            )
    except Exception:  # noqa: BLE001
        log.debug("acp-harnesses: precondition check skipped", exc_info=True)


async def on_startup(ctx: Any) -> None:
    log = ctx.logger
    try:
        from patches import apply  # same app dir; loaded under a namespaced key
    except ImportError:
        from . import patches  # type: ignore[import-not-found]

        apply = patches.apply

    harnesses = _harnesses(ctx)
    inject_mcp = bool((getattr(ctx, "config", None) or {}).get("inject_mcp_servers", True))

    try:
        ids = apply(harnesses, inject_mcp=inject_mcp, log=log)
    except Exception:
        # Refuse loudly rather than half-apply. An absent option is visible and
        # recoverable; a partially patched client fails at session start.
        log.exception(
            "acp-harnesses: registration FAILED — no harnesses were added. Kiro "
            "Crew behaves exactly as it does without this app."
        )
        return

    if not ids:
        log.warning("acp-harnesses: no harnesses enabled in app config; nothing registered.")
        return

    log.info(
        "acp-harnesses: registered %s — selectable in Settings as agent.acp_backend "
        "(restart not needed for the option to appear; a backend CHANGE needs one).",
        ", ".join(repr(i) for i in ids),
    )
    _preflight(ids, harnesses, log)
