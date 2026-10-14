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
 *   GET  /api/agents/resolved-model   -> rewrite the plain id back to composite
 *   GET  /api/chat/slots[/{slot}]     -> same, for each slot's stored model
 *   WS   /api/ws  `slots` frame       -> same, for the live slots push
 *   PUT  /api/agents/{name}           -> composite pin reduced to the plain id
 *   GET  /api/agents                  -> each agent's model -> composite
 *
 * The last two are what the composer chip actually reads (slot.model from the
 * store); without them a pick reverted to "auto" on the next slots push and
 * never survived a reload. See rewriteSlot.
 *
 * The dashboard's native picker renders the merged list and sends a pick back
 * through its own code path; we translate on the way out. No pill, no shadow
 * root, no grafted nodes, nothing to break on a Vite rebuild.
 *
 * Why /api/agents/resolved-model has to be intercepted too: the picker does
 * not decide what to highlight as "current" from the models list itself. A
 * separate call, `providers-*.js` `resolveModel` -> `agentResolvedModel` ->
 * GET /api/agents/resolved-model, reports which model the session is
 * ACTUALLY running (plain id, e.g. "sonnet"), and the picker highlights
 * whichever /api/models entry has that exact `name`. Since every name in our
 * merged list is a composite ("Claude Code › sonnet"), the plain id this
 * endpoint returns never matches ANY entry -- not even a live kiro-cli
 * session's, because buildMerged renamed those too ("Kiro CLI › sonnet") --
 * so the picker falls back to showing nothing recognized, which renders as
 * "auto" regardless of what was actually picked. Rewriting this response the
 * same way buildMerged renamed the list is what makes the two agree.
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

  /* Backend id -> the label buildMerged wraps its models in. "" (kiro-cli) is
     hardcoded to KIRO_LABEL rather than looked up, exactly like buildMerged's
     own kiro-row branch -- state.providers carries "Kiro CLI (default)" for
     that id (the Settings label), a different string than the constant
     buildMerged actually names kiro rows with. */
  function labelForBackend(id) {
    if (id === "") return KIRO_LABEL;
    for (var i = 0; i < state.providers.length; i++) {
      var p = state.providers[i];
      if (p.id === id) return p.label || p.id;
    }
    return null;
  }

  function providerById(id) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === id) return state.providers[i];
    }
    return null;
  }

  function offers(p, model) {
    return !!(p && p.models && p.models.indexOf(model) !== -1);
  }

  /* Plain model id -> the composite name it appears under in the merged
     /api/models list, so the picker's by-name match can find it.
     *backend* defaults to state.current (the resolved-model call and the
     slots feed have no other way to know which backend a plain id belongs
     to); handleSlotModel passes the pick's OWN backend explicitly since the
     response being rewritten there is for exactly that pick, not
     necessarily whatever state.current has settled to yet.

     A plain id the backend's own list does not offer, but another
     registered harness does, is labelled with THAT harness: a slot pinned
     before a switch keeps the model it was pinned to, and naming it under
     its real provider beats naming a row that does not exist. */
  function compositeForCurrent(model, backend) {
    if (!model || model === "auto") return "auto";
    if (model.indexOf(SEP) !== -1) return model; /* already composite */
    var b = backend === undefined ? state.current : backend;
    var own = providerById(b);
    if (b !== "" && own && !offers(own, model)) {
      for (var i = 0; i < state.providers.length; i++) {
        var p = state.providers[i];
        if (p.id !== "" && offers(p, model)) return (p.label || p.id) + SEP + model;
      }
    }
    var label = labelForBackend(b);
    if (label === null) return model; /* unknown backend: pass through untouched */
    return label + SEP + model;
  }

  /* ---- slot.model feeds ----------------------------------------------------
   * What the composer chip shows is `slot.model` from the Redux store, matched
   * by NAME against the /api/models list (ChatPage `displayModel`); the
   * resolved-model call only fills in when a slot has no model at all. The
   * store is written by two authoritative feeds -- the WS `slots` frame and
   * GET /api/chat/slots -- and both carry the server's PLAIN id ("opus").
   * Against a list whose every name is composite that matches nothing, so the
   * chip fell back to "auto" on the very next slots frame after a pick, and on
   * every page load: the pick looked like it never happened or never
   * persisted. Rewriting both feeds the same way buildMerged names the rows
   * is what keeps the chip on the pick.
   */
  function rewriteSlot(s) {
    if (!s || typeof s !== "object" || typeof s.model !== "string" || !s.model) return s;
    var c = compositeForCurrent(s.model);
    return c === s.model ? s : Object.assign({}, s, { model: c });
  }

  function rewriteSlots(body) {
    if (Array.isArray(body)) {
      var changed = false;
      var out = body.map(function (s) {
        var n = rewriteSlot(s);
        if (n !== s) changed = true;
        return n;
      });
      return changed ? out : body;
    }
    if (body && typeof body === "object") {
      if (typeof body.key === "string") return rewriteSlot(body);
      if (body.slot && typeof body.slot === "object") {
        var ns = rewriteSlot(body.slot);
        return ns === body.slot ? body : Object.assign({}, body, { slot: ns });
      }
    }
    return body;
  }

  function handleSlots(input, init) {
    return nativeFetch(input, init).then(function (r) {
      if (!r.ok) return r;
      return r
        .clone()
        .json()
        .then(function (j) {
          var out = rewriteSlots(j);
          return out === j ? r : jsonResponse(out);
        })
        .catch(function () {
          return r;
        });
    });
  }

  function rewriteFrame(raw) {
    if (typeof raw !== "string" || raw.indexOf('"slots"') === -1) return raw;
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return raw;
    }
    if (!msg || msg.type !== "slots" || !Array.isArray(msg.data)) return raw;
    var data = rewriteSlots(msg.data);
    if (data === msg.data) return raw;
    msg.data = data;
    return JSON.stringify(msg);
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

    /* patches.py's AcpClient monkeypatches (untranslated model ids, MCP
       injection, idempotent re-patching) are a SEPARATE step from route
       registration (this file) and have been observed not to complete on a
       given gateway boot even though the app loads and /state answers
       fine. When that happens every non-native harness pick will silently
       misbehave regardless of what the picker shows -- indistinguishable
       from a fix that never worked, which is exactly what made several of
       this app's own bugs hard to pin down. Flagging it directly in the
       description means a screenshot of the picker settles the question. */
    var patchWarning = state.patchesActive === false
      ? "⚠ acp-harnesses patches not active this session — fully restart Kiro Crew. "
      : "";

    state.providers.forEach(function (p) {
      if (p.id === "") return; /* kiro-cli: covered by the live rows above */
      var label = p.label || p.id;
      var models = p.models && p.models.length ? p.models : ["auto"];
      models.forEach(function (m) {
        out.push({
          model_id: m,
          model_name: label + SEP + m,
          description: patchWarning + label,
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
      return nativeFetch(input, Object.assign({}, init, { body: JSON.stringify(payload) })).then(
        function (r) {
          if (!r.ok) return r;
          return r
            .json()
            .then(function (j) {
              if (!j || typeof j !== "object" || typeof j.model !== "string") {
                return jsonResponse(j || {});
              }
              // The chat composer stores THIS response's `model` directly as
              // the slot's current value (client-*.js: `(await
              // J.chatSlotModel(...))?.model ?? t`) and compares it against
              // /api/models entries by NAME to decide what to check -- it
              // does not re-fetch anything afterward. Forwarding the real
              // server's plain id (e.g. "opus") leaves that stored value
              // matching nothing in our composite-named list, so the picker
              // shows no selection (falls back to "auto") until the next
              // fresh chat mount pulls a composite-correct value from a
              // different source. Rewriting it here the same way
              // buildMerged names the list entry is what makes the two
              // agree immediately, in an existing chat, without a reload.
              return jsonResponse(
                Object.assign({}, j, { model: compositeForCurrent(j.model, pick.backend) })
              );
            })
            .catch(function () {
              return jsonResponse({});
            });
        },
        function () {
          return nativeFetch(input, init);
        }
      );
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
        return reloadSlotThenForward();
      })
      .catch(function () {
        return reloadSlotThenForward();
      });

    /* Reloading the factory does not touch a session THIS chat already has --
     * the core's own model-switch path (chat_handlers._try_live_model_switch)
     * only ever tries session/set_model on whatever provider is already live,
     * with no check that its backend still matches what was just configured.
     * On an existing chat that "live switch" keeps succeeding on the OLD
     * backend (a portable id like "opus" often resolves to SOMETHING there
     * too), so api_chat_slot_model's reset fallback -- the one path that
     * would actually rebuild on the new backend -- never triggers, and the
     * chat is stuck on whatever backend it started with for its entire
     * lifetime, not just its first message. POST .../slots/{slot}/reload
     * (chat_handlers.api_chat_slot_reload) is the supported way to force
     * that rebuild: tears the process down and relaunches it with the
     * conversation preserved via session/load, which is exactly the tool
     * Kiro Crew's own agent/workspace switch handlers use for the same
     * problem. Best-effort: forward() runs regardless of the outcome here,
     * since a failed reload attempt (e.g. a turn in flight) shouldn't block
     * the rest of the flow -- the model pick's own guards handle that case.
     */
    function reloadSlotThenForward() {
      var slotName = typeof input === "string" ? _slotNameFromUrl(input) : null;
      if (!slotName) return forward();
      return _reloadSlot(slotName, 0).then(forward);
    }
  }

  /* Slot name out of a POST .../slots/{slot}/model URL, or null for the
     all-slots variant (.../slots/model) which names no single slot to
     reload. */
  function _slotNameFromUrl(url) {
    var m = /\/api\/chat\/slots\/([^/]+)\/model(?:\?|$)/.exec(url);
    return m ? m[1] : null;
  }

  /* POST .../slots/{slot}/reload, retrying a few times on "turn_in_flight".
   * Observed live: switching provider right after the previous turn's reply
   * lands often needs two clicks to "stick" -- the reload is refused because
   * the backend hasn't marked that turn fully settled yet, and since the
   * caller only ever tried once, the model pick that follows falls through
   * to the model-set endpoint's own live-switch path, which "succeeds" by
   * changing the model on the SAME (unswitched) session -- so the first
   * click looks like it did nothing. A short bounded retry covers the gap
   * without turning every switch into a long wait: real settling here is a
   * fraction of a second, not the minutes a genuinely stuck turn would take. */
  function _reloadSlot(slotName, attempt) {
    return nativeFetch("/api/chat/slots/" + encodeURIComponent(slotName) + "/reload", {
      method: "POST",
      credentials: "same-origin",
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (rj) {
        if (rj && rj.code === "turn_in_flight" && attempt < 3) {
          return new Promise(function (resolve) {
            setTimeout(resolve, 400);
          }).then(function () {
            return _reloadSlot(slotName, attempt + 1);
          });
        }
        if (rj && rj.error) {
          console.warn(
            "[acp-harnesses] session reload after backend switch failed: " + rj.error
          );
        }
        return rj;
      })
      .catch(function () {
        return {};
      });
  }

  /* ---- GET /api/agents/resolved-model --------------------------------------
   * Rewrite the plain model id the core reports back to the composite name it
   * appears under in our merged list, so the picker's by-name match actually
   * finds and highlights it. See the file-header comment for why this call
   * exists at all.
   */
  function handleResolvedModel(input, init) {
    return nativeFetch(input, init).then(
      function (r) {
        if (!r.ok) return r;
        return r
          .json()
          .then(function (j) {
            if (!j || typeof j !== "object" || typeof j.model !== "string") {
              return jsonResponse(j || {});
            }
            return jsonResponse(
              Object.assign({}, j, { model: compositeForCurrent(j.model) })
            );
          })
          .catch(function () {
            return jsonResponse({});
          });
      },
      function () {
        return nativeFetch(input, init);
      }
    );
  }

  /* ---- agent model pins ----------------------------------------------------
   * The picker's "Set <model> as default model for <agent>" row PUTs the
   * row's name -- our composite -- to /api/agents/{name} as `model`, which
   * would persist "Claude Code › opus" into agents.<name>.model and hand it to
   * the harness verbatim on the next spawn. A pin is model-only (it never
   * switches backend), so the composite is reduced to its plain id on the way
   * out. GET /api/agents is renamed the other way so the row's "already
   * pinned" check, which compares the agent's stored model against the chip's
   * composite, can match.
   *
   * Only kiro-cli models can be pinned: the core validates agents.<name>.model
   * against kiro-cli's catalogue whatever backend is live (observed on 0.7.0:
   * `'opus' is not a model kiro-cli serves`). A harness pick is refused here
   * with a message that says so, rather than forwarded to fail with one that
   * talks about kiro-cli models the user never picked.
   */
  function handleAgentPut(input, init) {
    var payload;
    try {
      payload = JSON.parse((init && init.body) || "");
    } catch (e) {
      return nativeFetch(input, init);
    }
    var pick = payload && typeof payload === "object" ? splitPick(payload.model) : null;
    if (!pick) return nativeFetch(input, init);
    if (pick.backend !== "") {
      var label = labelForBackend(pick.backend) || pick.backend;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error:
              "Kiro Crew can only pin kiro-cli models to an agent. " +
              label + " models apply per chat; pick one from the chat's model picker instead.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    payload.model = pick.model;
    return nativeFetch(input, Object.assign({}, init, { body: JSON.stringify(payload) }));
  }

  function rewriteAgent(a) {
    if (!a || typeof a !== "object" || typeof a.model !== "string" || !a.model) return a;
    var c = compositeForCurrent(a.model);
    return c === a.model ? a : Object.assign({}, a, { model: c });
  }

  function handleAgents(input, init) {
    return nativeFetch(input, init).then(function (r) {
      if (!r.ok) return r;
      return r
        .clone()
        .json()
        .then(function (j) {
          var list = Array.isArray(j) ? j : j && Array.isArray(j.agents) ? j.agents : null;
          if (!list) return r;
          var changed = false;
          var out = list.map(function (a) {
            var n = rewriteAgent(a);
            if (n !== a) changed = true;
            return n;
          });
          if (!changed) return r;
          return jsonResponse(Array.isArray(j) ? out : Object.assign({}, j, { agents: out }));
        })
        .catch(function () {
          return r;
        });
    });
  }

  /* ---- readiness -----------------------------------------------------------
   * Settles once /state has answered, or once bootstrapState gives up (or
   * READY_CAP_MS passes), whichever comes first. Intercepted calls WAIT on it
   * instead of passing through while it is pending: the picker's model list is
   * a react-query entry with no refetch interval once it holds a live list, so
   * a pass-through on the first /api/models call -- which the SPA makes during
   * the same cold start that /state is still retrying through -- cached the
   * stock kiro-only list for the life of the page. The harnesses were simply
   * missing from the picker until something happened to remount it.
   */
  var READY_CAP_MS = 5000;
  var settled = false;
  var settleWaiters = [];
  function settle() {
    if (settled) return;
    settled = true;
    var w = settleWaiters;
    settleWaiters = [];
    w.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* one waiter must not starve the rest */
      }
    });
  }
  function whenSettled(fn) {
    if (settled) fn();
    else settleWaiters.push(fn);
  }
  var readyPromise = new Promise(function (resolve) {
    whenSettled(resolve);
  });
  setTimeout(settle, READY_CAP_MS);

  /* ---- the one fetch wrapper ---------------------------------------------- */
  function route(url, method, input) {
    if (method === "GET" && url.indexOf("/api/models") !== -1) return handleModels;
    if (method === "GET" && url.indexOf("/api/agents/resolved-model") !== -1) {
      return handleResolvedModel;
    }
    if (method === "GET" && /\/api\/chat\/slots(?:\/[^/?]+)?(?:\?|$)/.test(url)) {
      return handleSlots;
    }
    if (method === "GET" && /\/api\/agents(?:\?|$)/.test(url)) return handleAgents;
    if (method === "PUT" && typeof input === "string" && /\/api\/agents\/[^/?]+(?:\?|$)/.test(url)) {
      return handleAgentPut;
    }
    if (
      method === "POST" &&
      typeof input === "string" &&
      /\/api\/chat\/slots\/(?:[^/]+\/)?model(?:\?|$)/.test(url)
    ) {
      return handleSlotModel;
    }
    return null;
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var handler = route(url, method, input);
    if (!handler) return nativeFetch(input, init);
    if (state.ready) return handler(input, init);
    return readyPromise.then(function () {
      /* /state never answered: behave exactly as the dashboard does without us. */
      return state.ready ? handler(input, init) : nativeFetch(input, init);
    });
  };

  /* ---- the WebSocket wrapper -----------------------------------------------
   * The dashboard's `/api/ws` socket pushes the `slots` frame that every chip
   * reads slot.model from (see rewriteSlot). Frames are rewritten in place;
   * until readiness settles they are QUEUED rather than passed through, in
   * arrival order across every listener, so a plain-id frame can never land
   * in the store ahead of the rewrite and no frame is reordered relative to
   * another. This is why shell.py loads this script synchronously in <head>:
   * the socket has to be constructed through this wrapper, and the SPA opens
   * it during its first render.
   */
  var NativeWS = window.WebSocket;
  if (typeof NativeWS === "function") {
    var onmessageDesc = Object.getOwnPropertyDescriptor(NativeWS.prototype, "onmessage");

    var isDashboardSocket = function (url) {
      try {
        return new URL(String(url), window.location.href).pathname === "/api/ws";
      } catch (e) {
        return false;
      }
    };

    var hookSocket = function (ws) {
      var queue = [];
      var wrapped = new Map();

      function invoke(listener, ev) {
        if (typeof listener === "function") listener.call(ws, ev);
        else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(ev);
      }
      function rewritten(ev) {
        var data = state.ready ? rewriteFrame(ev.data) : ev.data;
        if (data === ev.data) return ev;
        return new MessageEvent("message", {
          data: data,
          origin: ev.origin,
          lastEventId: ev.lastEventId,
          source: ev.source,
          ports: ev.ports ? Array.prototype.slice.call(ev.ports) : [],
        });
      }
      function deliver(listener, ev) {
        if (settled && !queue.length) return invoke(listener, rewritten(ev));
        queue.push([listener, ev]);
      }
      whenSettled(function () {
        var q = queue;
        queue = [];
        q.forEach(function (item) {
          try {
            invoke(item[0], rewritten(item[1]));
          } catch (e) {
            setTimeout(function () {
              throw e;
            });
          }
        });
      });
      function wrap(listener) {
        var w = wrapped.get(listener);
        if (!w) {
          w = function (ev) {
            deliver(listener, ev);
          };
          wrapped.set(listener, w);
        }
        return w;
      }

      if (onmessageDesc && onmessageDesc.set) {
        var current = null;
        Object.defineProperty(ws, "onmessage", {
          configurable: true,
          enumerable: true,
          get: function () {
            return current;
          },
          set: function (fn) {
            current = typeof fn === "function" ? fn : null;
            onmessageDesc.set.call(ws, current ? wrap(current) : null);
          },
        });
      }
      var nativeAdd = ws.addEventListener;
      var nativeRemove = ws.removeEventListener;
      ws.addEventListener = function (type, listener, opts) {
        if (type !== "message" || !listener) return nativeAdd.call(ws, type, listener, opts);
        return nativeAdd.call(ws, type, wrap(listener), opts);
      };
      ws.removeEventListener = function (type, listener, opts) {
        if (type !== "message" || !listener || !wrapped.has(listener)) {
          return nativeRemove.call(ws, type, listener, opts);
        }
        return nativeRemove.call(ws, type, wrapped.get(listener), opts);
      };
    };

    var PatchedWebSocket = function WebSocket(url, protocols) {
      var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      if (isDashboardSocket(url)) {
        try {
          hookSocket(ws);
        } catch (e) {
          /* never break the dashboard's socket over our rewrite */
        }
      }
      return ws;
    };
    PatchedWebSocket.prototype = NativeWS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
      PatchedWebSocket[k] = NativeWS[k];
    });
    window.WebSocket = PatchedWebSocket;
  }

  /* Until /state resolves we do not know the harness list; intercepted calls
   * wait on readiness (above) rather than serving a list missing groups.
   *
   * Retries a few times on failure. Observed live: a hard refresh (which
   * re-initializes the whole page cold, unlike a normal load) can lose a
   * race against the dashboard's own auth-session setup — this script is
   * `defer`red and runs early, and /state sits behind the same auth
   * middleware as every other app route. A failed request here used to be
   * silent and PERMANENT for the rest of that page load (worse: the old
   * code never even checked response.ok, so a 403's JSON error body parsed
   * "successfully" and left state.ready=true with providers still empty —
   * exactly "only the native list shows up", indistinguishable from the
   * app being gone). Auth finishes settling within a second or two of load,
   * so a short bounded retry recovers on its own instead of requiring
   * another reload.
   */
  function bootstrapState(attempt) {
    api("/state")
      .then(function (r) {
        if (!r.ok) throw new Error("state fetch: HTTP " + r.status);
        return r.json();
      })
      .then(function (s) {
        state = Object.assign(state, s, { ready: true });
        settle();
        if (state.patchesActive === false) {
          console.error(
            "[acp-harnesses] on_startup's AcpClient patches are NOT active " +
              "in this gateway process. Claude/Gemini picks will silently " +
              "misbehave (wrong model ids, no MCP tools) no matter what the " +
              "picker shows. Fully quit and relaunch Kiro Crew (not just " +
              "reload the page or toggle the app) to fix this."
          );
        }
      })
      .catch(function () {
        if (attempt < 5) {
          setTimeout(function () {
            bootstrapState(attempt + 1);
          }, 500);
          return;
        }
        /* Attempts exhausted: release everything queued on readiness as a
           pass-through so the dashboard behaves exactly as it does without
           this app. */
        settle();
      });
  }
  bootstrapState(0);

  /* The backend is global and can change outside this tab (Settings, another
     tab, a config edit). Re-read it when the tab comes back so the slots feed
     labels plain ids with the backend actually live, not the one this page
     booted on. */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !state.ready) return;
    api("/state")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (s) state = Object.assign(state, s, { ready: true });
      })
      .catch(function () {});
  });
})();
