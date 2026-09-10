/* acp-harnesses — merges every ACP harness into the dashboard's OWN model picker.
 *
 * Loaded by a <script src> that shell.py appends to the SPA shell HTML.
 *
 * Why this replaces the v2.0.0 floating pill
 * ------------------------------------------
 * v2.0.0 rendered a self-owned pill in a shadow root because grafting nodes into
 * React's tree gets them reconciled away and the class names to anchor to are
 * build-hashed. That reasoning still holds for the DOM — so this version does not
 * touch the DOM at all. It intercepts at the DATA layer instead, which React has
 * no opinion about:
 *
 *   GET  /api/models                  -> merged list, one entry per harness+model
 *   POST /api/chat/slots/{slot}/model -> split the pick, switch backend, forward
 *   POST /api/chat/slots/model        -> same, for the all-slots variant
 *
 * The dashboard's native picker renders the merged list and sends a pick back
 * through its own code path; we translate on the way out. No pill, no shadow
 * root, no grafted nodes, nothing to break on a Vite rebuild.
 *
 * Contracts this depends on (verified against the shipped build, not assumed):
 *   - The CHAT picker maps the /api/models array with `{name: e.model_name}` and
 *     ignores model_id entirely (providers-*.js `fetchAvailableModels`). So
 *     model_name is BOTH the label and the value posted back — which is why the
 *     composite string lives there and is split again on the POST.
 *   - The Settings/Mochi selector uses `{value: model_id || model_name, label:
 *     model_name}` (SettingsPanel-*.js), so model_id stays the PLAIN id and that
 *     surface keeps posting a value the core accepts with no interception.
 *   - The API client posts as `fetch(url, {method:"POST", body: JSON.stringify(p)})`
 *     (client-*.js `Y`), so `input` is a string and `init.body` is a JSON string.
 *   - `_model_rejected_reason` rejects only TOP-LEVEL canonical registry keys
 *     (model_registry.json: fable-5-1m, opus-4.8-1m, sonnet-4.5, haiku-4.5, auto,
 *     …). Every plain id we forward (opus, sonnet, haiku, gemini-2.5-pro,
 *     gemini-2.5-flash) is absent from that set, so all of them pass the guard.
 */
(function () {
  "use strict";
  if (window.__acpHarnesses) return;
  window.__acpHarnesses = true;

  var BASE = "/api/apps/acp-harnesses";
  /* U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK. No model id or provider
     label contains it, so indexOf() splits the composite unambiguously. */
  var SEP = " › ";
  var KIRO_LABEL = "Kiro CLI";

  var nativeFetch = window.fetch.bind(window);
  var state = { current: "", model: "", providers: [], ready: false };

  /* Our own calls go through nativeFetch so they can never re-enter the wrapper. */
  function api(path, opts) {
    return nativeFetch(BASE + path, Object.assign({ credentials: "same-origin" }, opts || {}));
  }

  function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /* Composite label -> backend id. Returns undefined for a label we did not
     emit, which tells the caller to pass the request through untouched. */
  function backendForLabel(label) {
    if (label === KIRO_LABEL) return "";
    for (var i = 0; i < state.providers.length; i++) {
      var p = state.providers[i];
      if ((p.label || p.id) === label) return p.id;
    }
    return undefined;
  }

  /* ---- GET /api/models ----------------------------------------------------
   * The core handler unconditionally shells out to `kiro-cli chat --list-models`
   * with no provider branch, so its rows are always kiro-cli's catalogue whatever
   * backend is live. We keep those rows (they are the real, live kiro list) as
   * the "Kiro CLI" group and append one group per registered harness.
   */
  function buildMerged(kiroRows) {
    var out = [{
      model_id: "auto",
      model_name: "auto",
      description: "Provider default",
    }];

    var seen = {};
    (kiroRows || []).forEach(function (m) {
      var id = (m && (m.model_id || m.model_name)) || "";
      if (!id || id === "auto" || seen[id]) return;
      seen[id] = true;
      /* Copy the row so context_window_tokens / rate fields survive for the
         picker's own window + rate display, then override the identity fields. */
      out.push(Object.assign({}, m, {
        model_id: id,
        model_name: KIRO_LABEL + SEP + id,
        description: m.description || KIRO_LABEL,
      }));
    });
    if (!Object.keys(seen).length) {
      /* kiro-cli degraded (503 / cold spawn). Keep the group reachable so the
         backend is still selectable from the picker. */
      out.push({
        model_id: "auto",
        model_name: KIRO_LABEL + SEP + "auto",
        description: KIRO_LABEL,
      });
    }

    state.providers.forEach(function (p) {
      if (p.id === "") return; /* kiro-cli: covered by the live rows above */
      var label = p.label || p.id;
      var models = p.models && p.models.length ? p.models : ["auto"];
      models.forEach(function (m) {
        out.push({
          model_id: m,
          model_name: label + SEP + m,
          description: label,
          provider: p.id,
        });
      });
    });
    return out;
  }

  function handleModels(input, init) {
    return nativeFetch(input, init).then(
      function (r) {
        if (!r.ok) return jsonResponse(buildMerged([]));
        return r
          .json()
          .then(function (j) {
            return jsonResponse(buildMerged(Array.isArray(j) ? j : []));
          })
          .catch(function () {
            return jsonResponse(buildMerged([]));
          });
      },
      function () {
        return jsonResponse(buildMerged([]));
      }
    );
  }

  /* ---- POST .../model ------------------------------------------------------
   * Split "Gemini CLI › gemini-2.5-pro" back into (backend, model). Switch the
   * backend first if it changed, then forward the ORIGINAL request with a plain
   * model id the core accepts. The composite never reaches the server.
   */
  function splitPick(value) {
    if (typeof value !== "string") return null;
    var i = value.indexOf(SEP);
    if (i === -1) return null;
    var backend = backendForLabel(value.slice(0, i));
    if (backend === undefined) return null;
    var model = value.slice(i + SEP.length);
    return { backend: backend, model: model === "auto" ? "" : model };
  }

  function handleSlotModel(input, init) {
    var payload;
    try {
      payload = JSON.parse((init && init.body) || "");
    } catch (e) {
      return nativeFetch(input, init);
    }
    if (!payload || typeof payload !== "object") return nativeFetch(input, init);

    var pick = splitPick(payload.model);
    if (!pick) return nativeFetch(input, init);

    function forward() {
      payload.model = pick.model;
      return nativeFetch(input, Object.assign({}, init, { body: JSON.stringify(payload) }));
    }

    if (pick.backend === state.current) return forward();

    /* Backend actually changed: persist it (the route also rebuilds the provider
       factory in-process) BEFORE the core sets the slot model, so the model lands
       on a session already running the new harness. */
    return api("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: pick.backend, model: pick.model }),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (j) {
        if (j && j.error) {
          /* Surface as a normal API error so the picker's own error path shows
             it, rather than silently applying a model to the wrong backend. */
          return jsonResponse({ error: j.error });
        }
        state.current = pick.backend;
        if (j && j.restart_required) {
          console.warn(
            "[acp-harnesses] backend set to " +
              (pick.backend || "kiro-cli") +
              " but the provider factory could not be reloaded in-process — " +
              "restart Kiro Crew for it to take effect."
          );
        }
        return forward();
      })
      .catch(function () {
        return forward();
      });
  }

  /* ---- the one wrapper ---------------------------------------------------- */
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

    if (!state.ready) return nativeFetch(input, init);

    if (method === "GET" && url.indexOf("/api/models") !== -1) {
      return handleModels(input, init);
    }
    if (
      method === "POST" &&
      typeof input === "string" &&
      /\/api\/chat\/slots\/(?:[^/]+\/)?model(?:\?|$)/.test(url)
    ) {
      return handleSlotModel(input, init);
    }
    return nativeFetch(input, init);
  };

  /* Until /state resolves we do not know the harness list, so the wrapper stays
     a pass-through — the picker shows the stock kiro list rather than a list
     missing groups it will gain a moment later. */
  api("/state")
    .then(function (r) {
      return r.json();
    })
    .then(function (s) {
      state = Object.assign(state, s, { ready: true });
    })
    .catch(function () {
      /* App disabled or gateway busy: leave fetch as a pass-through so the
         dashboard behaves exactly as it does without this app. */
    });
})();
