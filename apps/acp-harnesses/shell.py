"""Inject the provider switcher into the dashboard SPA shell.

Why this works when a ``ui.pages`` entry does not
-------------------------------------------------
Kiro Crew serves the SPA shell from ``dashboard/handlers/core.py``::

    async def index(request):
        html = await loop.run_in_executor(discovery_executor(), _resolve_index_html)
        return web.Response(text=html, content_type="text/html")

``_resolve_index_html`` is looked up as a MODULE GLOBAL on every request, so
rebinding ``core._resolve_index_html`` takes effect immediately and covers every
path that serves the shell:

* ``routes/realtime.py``  ``add_get("/", handlers.index)``       — the root load
* ``server.py`` (spa_fallback middleware)                        — deep links
* ``server.py`` (token_auth ``spa_shell_handler=handlers.index``) — cold start

All three call ``index()``, and ``index()`` resolves the HTML through that one
name. Patching a route handler would NOT work — aiohttp captures the function
object at ``add_get`` time, and app startup hooks run afterwards
(``app.on_startup.append(_hooks_startup)``).

The injected tag is a same-origin ``<script src>``. The dashboard CSP is
``script-src 'self' 'unsafe-inline' …``, so it loads; the script itself is served
from this app's own namespaced route, which stays behind the normal auth
middleware.

On the shell's security contract
--------------------------------
``core.index`` carries an explicit contract: do NOT inject server/user/session
state, because the shell is served UNAUTHENTICATED on the cold-start path. This
patch honours the *reason* for that rule — the injected bytes are a static,
secret-free script tag, identical for every request and every user, carrying no
per-request state. Everything dynamic (current backend, model lists) is fetched
by the script from gated ``/api/apps/acp-harnesses/*`` routes.
"""

from __future__ import annotations

from typing import Any

_TAG = '<script src="/api/apps/acp-harnesses/ui.js" defer></script>'

_originals: dict[str, Any] = {}


def assert_symbols() -> list[str]:
    """Return missing internals. Empty means safe to patch."""
    try:
        from kiro_crew.dashboard.handlers import core
    except Exception as exc:  # noqa: BLE001
        return [f"cannot import dashboard.handlers.core ({exc})"]
    if not callable(getattr(core, "_resolve_index_html", None)):
        return ["dashboard.handlers.core._resolve_index_html"]
    return []


def install(log) -> None:
    """Rebind ``core._resolve_index_html`` to append the script tag.

    Idempotent: a second call is a no-op, so a re-enable without a gateway
    restart cannot stack wrappers.
    """
    from kiro_crew.dashboard.handlers import core

    original = core._resolve_index_html
    if getattr(original, "_acp_harnesses", False):
        return

    # _resolve_index_html has its own mtime cache, so it returns the same string
    # object until the bundle changes. Cache the injected result against that
    # source so a page load costs one identity check, not a string rebuild.
    cache: dict[str, str] = {}

    def _resolve_index_html() -> str:
        html = original()
        if not isinstance(html, str):  # pragma: no cover - defensive
            return html
        hit = cache.get("src")
        if hit is not None and hit is html:
            return cache["out"]
        if _TAG in html:
            out = html
        elif "</body>" in html:
            out = html.replace("</body>", f"  {_TAG}\n</body>", 1)
        else:
            # No </body> means the static "dashboard not built" guidance page.
            # Appending would put a script after </html>; leave it alone — there
            # is no SPA to decorate in that state anyway.
            out = html
        cache["src"] = html
        cache["out"] = out
        return out

    _resolve_index_html._acp_harnesses = True  # type: ignore[attr-defined]
    _originals["_resolve_index_html"] = original
    core._resolve_index_html = _resolve_index_html
    log.info("acp-harnesses: SPA shell patched — provider switcher will load on next page load")
