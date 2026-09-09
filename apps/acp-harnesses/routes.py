"""HTTP API behind the ACP Harnesses page.

Two endpoints, both under ``/api/apps/acp-harnesses`` (which the manifest's
``permissions.api`` allowlists):

    GET  /state    what is registered, what is installed, what is active
    POST /select   set agent.acp_backend

Writes go through ``config.loader.update_config_locked``, the sanctioned atomic
read-modify-write: it holds an advisory lock on a sidecar lockfile for the whole
cycle, so a concurrent writer cannot land between our read and our write. Never
hand-roll a config.json write — ``write_config_atomically`` replaces the inode,
so a lock on the file's own fd would not serialize against the rename.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from aiohttp import web

_BASE = "/api/apps/acp-harnesses"
_APP_NAME = "acp-harnesses"


def _app_dir() -> Path:
    from kiro_crew.apps.registry import apps_dir  # deferred: import cycle

    return apps_dir() / _APP_NAME


def _manifest() -> dict[str, Any]:
    try:
        return json.loads((_app_dir() / "app.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _agent_cfg() -> Any:
    from kiro_crew.config.loader import KiroCrewConfig

    return KiroCrewConfig.load().agent


async def _handle_state(request: web.Request) -> web.Response:
    """Everything the page renders, in one round trip."""
    manifest = _manifest()
    agent = _agent_cfg()
    active = getattr(agent, "acp_backend", "") or ""

    rows = []
    for h in manifest.get("harnesses") or []:
        hid = h.get("id") or ""
        if not hid:
            continue
        cmd = h.get("command") or ("claude-agent-acp" if hid == "claude" else "")
        # A row can be enabled in the manifest yet unusable because its binary is
        # absent — the page shows those states separately so "why is it not
        # working" is answerable without reading a log.
        resolved = shutil.which(cmd) if cmd else None
        rows.append(
            {
                "id": hid,
                "label": h.get("label") or hid,
                "dialect": h.get("dialect") or "standard",
                "enabled": bool(h.get("enabled", True)),
                "command": cmd,
                "binary": resolved or "",
                "installed": bool(resolved) or not cmd,
                "active": hid == active,
                "note": h.get("_note") or "",
            }
        )

    # kiro-cli is spelled as the empty string and is always available; it is not a
    # row in our table, but the page must be able to switch back to it.
    rows.insert(
        0,
        {
            "id": "",
            "label": "kiro-cli (built in)",
            "dialect": "native",
            "enabled": True,
            "command": "kiro-cli",
            "binary": shutil.which("kiro-cli") or "",
            "installed": True,
            "active": active == "",
            "note": "Kiro Crew's default backend.",
        },
    )

    return web.json_response(
        {
            "active": active,
            "model": getattr(agent, "model", "") or "",
            "sandboxOk": bool(getattr(agent, "sandbox_allow_unsandboxed_exec", False)),
            "harnesses": rows,
            "version": manifest.get("version", ""),
        }
    )


async def _handle_select(request: web.Request) -> web.Response:
    """Persist agent.acp_backend. Takes effect for sessions started afterwards."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    backend = body.get("backend")
    if not isinstance(backend, str):
        return web.json_response({"error": "'backend' must be a string"}, status=400)

    # Only ids this app registered (plus kiro-cli) may be set. Without this the
    # endpoint would be a general-purpose writer for an arbitrary backend id,
    # and an unregistered value is coerced away at config load anyway — which
    # would look like the button silently doing nothing.
    valid = {""} | {
        h.get("id")
        for h in (_manifest().get("harnesses") or [])
        if h.get("id") and h.get("enabled", True)
    }
    if backend not in valid:
        return web.json_response(
            {"error": f"unknown or disabled backend {backend!r}", "valid": sorted(valid)},
            status=400,
        )

    def _mutate(data: dict) -> dict:
        data.setdefault("agent", {})["acp_backend"] = backend
        return data

    try:
        from kiro_crew.config.loader import update_config_locked

        update_config_locked(mutate=_mutate)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"config write failed: {exc}"}, status=500)

    return web.json_response(
        {
            "ok": True,
            "active": backend,
            "restartRequired": True,
        }
    )


def register_routes(app: web.Application) -> None:
    """Register on the gateway's aiohttp Application (single-arg convention)."""
    app.router.add_get(f"{_BASE}/state", _handle_state)
    app.router.add_post(f"{_BASE}/select", _handle_select)
