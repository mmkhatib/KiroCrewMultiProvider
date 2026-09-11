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
        # Crew-member DM sessions (kiro_crew.members.select_provider_backend)
        # route through THIS field instead of acp_backend, defaulting to
        # "kas" -- entirely independent of the switcher unless we also set
        # it. Tracked here so _set_provider can tell whether either one
        # actually changed.
        "member_backend": getattr(agent, "member_acp_backend", "") or "",
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


async def _reload_factory(request: web.Request) -> str:
    """Rebuild the provider factory in-process. Returns "" on success, else why not.

    Why this is needed at all: ``dashboard/handlers/core.py`` hot-reloads config
    on exactly two branches — ``agent.provider`` (calls
    ``sessions.reload_provider_factory()``) and ``agent.model`` /
    ``agent.reasoning_effort`` (calls ``sessions.refresh_defaults()``).
    ``agent.acp_backend`` matches NEITHER, so a plain config write leaves the
    running gateway holding the factory closure built at startup, which captured
    the OLD backend (``config/loader.py``: ``acp_backend=self.agent.acp_backend``).
    That — not anything architectural — is the entire reason v2.0.0 had to tell
    the user to restart.

    ``reload_provider_factory`` is the very call the core makes for a provider
    switch: reloads config, rebuilds the factory, drains the warm pool, shuts
    down stale sessions. App route handlers receive the REAL aiohttp request
    (``route_registry.dispatch`` calls ``route.handler(request, ctx)``), so
    ``request.app["state"]`` is the live DashboardState.

    Only ever called when the backend actually CHANGED — it clears every session,
    which is right for a harness switch and far too heavy for a model pick.
    """
    try:
        state = request.app["state"]
    except (KeyError, AttributeError):
        return "dashboard state unavailable"
    sessions = getattr(state, "sessions", None)
    reload_fn = getattr(sessions, "reload_provider_factory", None)
    if not callable(reload_fn):
        return "sessions.reload_provider_factory missing"
    try:
        await reload_fn()
    except Exception as exc:  # noqa: BLE001
        return f"factory reload failed: {exc}"
    return ""


async def _set_provider(request: web.Request, ctx: Any) -> web.Response:
    """Persist agent.acp_backend and/or agent.model, then apply it live.

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
        # `known` is the STATIC harness list from app.json -- it says nothing
        # about whether Kiro Crew's own registry actually accepted this id as
        # selectable. That registration happens once, in the on_startup hook;
        # if it never ran or never completed (observed: no gateway restart
        # since enabling, or the hook itself failing/timing out), writing
        # agent.acp_backend here would silently succeed while
        # resolve_selected_backend degrades every session back to kiro-cli --
        # the "I picked Gemini and it's quietly running kiro-cli instead" bug.
        # Cross-checking the live registry turns that into a clear error
        # instead of a pick that looks like it worked but never did.
        if backend not in ("", "kas"):
            try:
                from kiro_crew.acp_backends import selectable_backends

                if backend not in selectable_backends():
                    return web.json_response(
                        {
                            "error": (
                                f"{backend!r} is not registered as selectable yet "
                                "(acp-harnesses' startup hook may not have "
                                "finished, or Kiro Crew was never fully "
                                "restarted after installing/updating this app). "
                                "Fully quit and relaunch Kiro Crew, then try "
                                "again."
                            )
                        },
                        status=409,
                    )
            except ImportError:
                pass  # older build without the registry; nothing to cross-check
    if model is not None and not isinstance(model, str):
        return web.json_response({"error": "model must be a string"}, status=400)
    if backend is None and model is None:
        return web.json_response({"error": "nothing to set"}, status=400)

    def mutate(cfg: dict) -> dict:
        agent = cfg.setdefault("agent", {})
        if backend is not None:
            agent["acp_backend"] = backend
            # Crew-member DM sessions read member_acp_backend instead of
            # acp_backend (kiro_crew.members.select_provider_backend) and
            # default to "kas", entirely independent of this switcher unless
            # we also set it here. Mirrored rather than left alone: a user
            # picking a harness in the one switcher this app exposes means
            # "use this everywhere", not "use this for the default session
            # only, leave every crew-member DM on kas".
            agent["member_acp_backend"] = backend
        if model is not None:
            agent["model"] = model
        return cfg

    # Read the live backend(s) BEFORE writing, so the reload below fires only
    # on a real change rather than on every model pick that rides this same
    # route -- and fires for a member-only change too, since member sessions
    # are built through the same pooled factory as the default one.
    previous = _agent_config()
    previous_backend = previous["backend"]
    previous_member_backend = previous["member_backend"]

    try:
        from kiro_crew.config.loader import update_config_locked

        update_config_locked(mutate=mutate)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"config write failed: {exc}"}, status=500)

    # A backend change needs the factory rebuilt or the running gateway keeps
    # spawning the old harness. Only a genuine change pays for it: the reload
    # clears every session and drains the warm pool.
    reload_error = ""
    if backend is not None and (
        backend != previous_backend or backend != previous_member_backend
    ):
        reload_error = await _reload_factory(request)

    return web.json_response(
        {
            "ok": True,
            "backend": backend,
            "model": model,
            # True only when the switch could NOT be applied in-process — the UI
            # reads this to decide whether to tell the user to restart, so it must
            # describe what actually happened rather than a blanket assumption.
            "restart_required": bool(reload_error),
            "reload_error": reload_error,
        }
    )


def register_routes(ctx: Any) -> list[AppRoute]:
    return [
        AppRoute(method="GET", path="/ui.js", handler=_ui_js),
        AppRoute(method="GET", path="/state", handler=_state),
        AppRoute(method="POST", path="/provider", handler=_set_provider),
    ]
