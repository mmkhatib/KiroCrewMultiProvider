"""Namespaced HTTP routes backing the injected provider switcher.

Contract (``apps/route_registry.py``): the manifest points
``backend.hooks.routes`` at ``routes:register_routes``; the registry calls
``register_fn(ctx) -> list[AppRoute]`` and dispatches every declared path under
``/api/apps/acp-harnesses/…`` through one catch-all. Handlers take
``(request, ctx)`` — this is NOT the ``(app: web.Application)`` signature Kiro
Crew's own builtins use, which is a separate and more privileged convention.

These routes sit behind the dashboard's normal auth middleware, which is what
keeps the config write below from being reachable unauthenticated.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aiohttp import web

from kiro_crew.apps.route_registry import AppRoute

_APP_DIR = Path(__file__).resolve().parent

# Backends this app did not add. "" is kiro-cli (the stock default) and "kas" is
# the one alternative the public build already ships; both are offered in the
# switcher so it is a complete control rather than a bolt-on.
_NATIVE = [
    {"id": "", "label": "Kiro CLI (default)", "dialect": "native"},
    {"id": "kas", "label": "KAS", "dialect": "native"},
]


def _manifest() -> dict:
    try:
        return json.loads((_APP_DIR / "app.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _harnesses(ctx: Any) -> list[dict]:
    """Harness rows from the hook context, falling back to app.json on disk."""
    cfg = getattr(ctx, "config", None) or {}
    rows = cfg.get("harnesses")
    if not (isinstance(rows, list) and rows):
        rows = _manifest().get("harnesses") or []
    return [r for r in rows if isinstance(r, dict) and r.get("enabled", True)]


def _agent_config() -> dict:
    from kiro_crew.config.loader import KiroCrewConfig

    agent = KiroCrewConfig.load().agent
    return {
        "backend": getattr(agent, "acp_backend", "") or "",
        "model": getattr(agent, "model", "") or "",
    }


async def _ui_js(request: web.Request, ctx: Any) -> web.Response:
    """Serve the injected switcher. Same-origin, so the CSP admits it."""
    try:
        body = (_APP_DIR / "ui" / "panel.js").read_text(encoding="utf-8")
    except OSError:
        # Fail quiet: a broken asset must not throw a console error on every
        # page load of the whole dashboard.
        body = "/* acp-harnesses: panel.js missing */"
    return web.Response(
        text=body,
        content_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


async def _state(request: web.Request, ctx: Any) -> web.Response:
    """Everything the switcher needs to render, in one round trip."""
    current = _agent_config()
    providers = list(_NATIVE) + [
        {
            "id": str(h.get("id") or ""),
            "label": str(h.get("label") or h.get("id") or ""),
            "dialect": str(h.get("dialect") or "standard"),
            "models": [str(m) for m in (h.get("models") or [])],
        }
        for h in _harnesses(ctx)
        if str(h.get("dialect") or "") != "native"
    ]
    return web.json_response(
        {
            "current": current["backend"],
            "model": current["model"],
            "providers": providers,
        },
        headers={"Cache-Control": "no-store"},
    )


async def _set_provider(request: web.Request, ctx: Any) -> web.Response:
    """Persist agent.acp_backend and/or agent.model.

    Writes through ``update_config_locked`` — the sanctioned atomic writer with
    an advisory sidecar lock — rather than touching config.json directly, so a
    concurrent Settings save cannot interleave with this one.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON"}, status=400)

    backend = body.get("backend")
    model = body.get("model")

    known = {p["id"] for p in _NATIVE} | {
        str(h.get("id") or "") for h in _harnesses(ctx)
    }
    if backend is not None:
        if not isinstance(backend, str) or backend not in known:
            return web.json_response(
                {"error": f"unknown backend {backend!r}"}, status=400
            )
    if model is not None and not isinstance(model, str):
        return web.json_response({"error": "model must be a string"}, status=400)
    if backend is None and model is None:
        return web.json_response({"error": "nothing to set"}, status=400)

    def mutate(cfg: dict) -> dict:
        agent = cfg.setdefault("agent", {})
        if backend is not None:
            agent["acp_backend"] = backend
        if model is not None:
            agent["model"] = model
        return cfg

    try:
        from kiro_crew.config.loader import update_config_locked

        update_config_locked(mutate=mutate)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"config write failed: {exc}"}, status=500)

    # A backend change only takes effect on a fresh gateway process: the ACP
    # client is constructed from config at startup and pooled per backend. Say so
    # rather than letting the UI imply it switched live.
    return web.json_response(
        {
            "ok": True,
            "backend": backend,
            "model": model,
            "restart_required": backend is not None,
        }
    )


def register_routes(ctx: Any) -> list[AppRoute]:
    return [
        AppRoute(method="GET", path="/ui.js", handler=_ui_js),
        AppRoute(method="GET", path="/state", handler=_state),
        AppRoute(method="POST", path="/provider", handler=_set_provider),
    ]
