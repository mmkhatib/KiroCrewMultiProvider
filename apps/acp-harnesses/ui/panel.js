/* acp-harnesses — provider + model switcher injected into the dashboard SPA.
 *
 * Loaded by a <script src> that shell.py appends to the SPA shell HTML.
 *
 * Why a floating control instead of splicing into Settings / the chat header:
 * the dashboard is React with a hashed Vite bundle. Nodes grafted into its tree
 * are destroyed on the next reconciliation, and the class names to anchor to are
 * build-hashed, so they change on every Kiro Crew update. A self-owned element
 * in a shadow root survives re-renders, collides with no dashboard CSS, and is
 * reachable from every screen — chat and Settings alike.
 */
(function () {
  "use strict";
  if (window.__acpHarnesses) return;
  window.__acpHarnesses = true;

  var BASE = "/api/apps/acp-harnesses";
  var state = { current: "", model: "", providers: [] };

  function api(path, opts) {
    return fetch(BASE + path, Object.assign({ credentials: "same-origin" }, opts || {}));
  }

  function activeProvider() {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === state.current) return state.providers[i];
    }
    return null;
  }

  /* ---- /api/models rewrite -------------------------------------------------
   * GET /api/models unconditionally shells out to `kiro-cli chat --list-models`
   * with no provider branch, so the picker lists kiro-cli's catalogue whatever
   * backend is live. The response is a BARE ARRAY of objects the SPA reads as
   * `model_id || model_name` (verified against the compiled bundle).
   * Rewriting it here — in the client that consumes it — needs no core route
   * override, which is what makes this reachable from an app at all.
   */
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/models") === -1) return nativeFetch(input, init);

    var p = activeProvider();
    if (!p || !p.models || !p.models.length) return nativeFetch(input, init);

    var body = p.models.map(function (m) {
      return { model_id: m, model_name: m, provider: p.id };
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  };

  /* ---- UI ----------------------------------------------------------------- */
  var host = document.createElement("div");
  host.id = "acp-harnesses-root";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    ".pill{position:fixed;right:14px;bottom:14px;z-index:2147483000;" +
    "font:500 12px/1.4 ui-sans-serif,system-ui,sans-serif;" +
    "background:#1c1f26;color:#e6e8ee;border:1px solid #333a47;border-radius:999px;" +
    "padding:7px 13px;cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.36);" +
    "display:flex;align-items:center;gap:7px;user-select:none}" +
    ".pill:hover{border-color:#4d5768}" +
    ".dot{width:7px;height:7px;border-radius:50%;background:#3ecf8e;flex:none}" +
    ".menu{position:fixed;right:14px;bottom:56px;z-index:2147483000;width:252px;" +
    "background:#1c1f26;color:#e6e8ee;border:1px solid #333a47;border-radius:11px;" +
    "padding:9px;box-shadow:0 10px 34px rgba(0,0,0,.5);" +
    "font:400 12px/1.5 ui-sans-serif,system-ui,sans-serif}" +
    ".lbl{font-size:10px;letter-spacing:.09em;text-transform:uppercase;" +
    "color:#8a93a6;margin:7px 3px 4px}" +
    "select{width:100%;background:#12151b;color:#e6e8ee;border:1px solid #333a47;" +
    "border-radius:7px;padding:6px 7px;font:inherit;cursor:pointer}" +
    ".note{margin:9px 3px 2px;color:#8a93a6;font-size:11px}" +
    ".warn{color:#f0b849}" +
    ".hide{display:none}" +
    "</style>" +
    '<div class="pill" part="pill"><span class="dot"></span><span id="cur">…</span></div>' +
    '<div class="menu hide" id="menu">' +
    '<div class="lbl">Provider</div><select id="prov"></select>' +
    '<div class="lbl">Model</div><select id="mdl"></select>' +
    '<div class="note" id="note"></div>' +
    "</div>";

  var pill = root.querySelector(".pill");
  var menu = root.querySelector("#menu");
  var selProv = root.querySelector("#prov");
  var selMdl = root.querySelector("#mdl");
  var note = root.querySelector("#note");
  var curLabel = root.querySelector("#cur");

  pill.addEventListener("click", function () {
    menu.classList.toggle("hide");
  });
  document.addEventListener("click", function (e) {
    if (!host.contains(e.target)) menu.classList.add("hide");
  });

  function render() {
    var p = activeProvider();
    curLabel.textContent = p ? p.label : state.current || "Kiro CLI";

    selProv.innerHTML = "";
    state.providers.forEach(function (item) {
      var o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.label;
      if (item.id === state.current) o.selected = true;
      selProv.appendChild(o);
    });

    selMdl.innerHTML = "";
    var models = (p && p.models) || [];
    if (!models.length) {
      var d = document.createElement("option");
      d.value = "";
      d.textContent = "provider default";
      selMdl.appendChild(d);
    }
    models.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      if (m === state.model) o.selected = true;
      selMdl.appendChild(o);
    });
  }

  function save(patch, msg) {
    note.className = "note";
    note.textContent = "Saving…";
    api("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          note.className = "note warn";
          note.textContent = (res.j && res.j.error) || "Save failed.";
          return;
        }
        if (res.j.restart_required) {
          note.className = "note warn";
          note.textContent =
            "Saved. Quit and relaunch Kiro Crew — the ACP client is built at " +
            "startup and pooled per backend, so a running gateway keeps the old one.";
        } else {
          note.className = "note";
          note.textContent = msg || "Saved. Applies to new sessions.";
        }
      })
      .catch(function () {
        note.className = "note warn";
        note.textContent = "Save failed — gateway unreachable.";
      });
  }

  selProv.addEventListener("change", function () {
    state.current = selProv.value;
    state.model = "";
    render();
    save({ backend: selProv.value, model: "" });
  });
  selMdl.addEventListener("change", function () {
    state.model = selMdl.value;
    save({ model: selMdl.value });
  });

  api("/state")
    .then(function (r) {
      return r.json();
    })
    .then(function (s) {
      state = s;
      render();
      document.body.appendChild(host);
    })
    .catch(function () {
      /* App disabled or gateway busy — stay invisible rather than show a
         broken control. */
    });
})();
