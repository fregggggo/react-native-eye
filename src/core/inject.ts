// Runs inside the app. Two rules it must never break:
//   1. never throw into app code — RN's fetch is XHR-based and a throwing
//      `loadend` listener surfaces as a console.error + LogBox redbox, i.e. the
//      tool would fabricate the very errors it is meant to observe;
//   2. never read a property that can throw. `responseText` throws whenever
//      responseType is not ""/"text", and whatwg-fetch (RN's fetch) sets
//      responseType = "blob" on every request.
export const INTERCEPTOR_VERSION = 3;

export const NETWORK_INTERCEPTOR_SOURCE = `
(function () {
  var VERSION = ${INTERCEPTOR_VERSION};
  // The installed-flag alone is a lie the app can outlive: it is set before the
  // wrappers go on, so a bundle init that reassigns fetch/XHR right after a
  // reload leaves "installed at this version" true with nothing wrapped, and
  // every later install short-circuited on it (field test D14). The wrapper
  // functions themselves are the only honest evidence, so they are what gets
  // checked.
  var installed = !!globalThis.__RNE_NET_INSTALLED__;
  var sameVersion = globalThis.__RNE_NET_VERSION__ === VERSION;
  var fetchLive = !globalThis.fetch || globalThis.fetch === globalThis.__RNE_WRAPPED_FETCH__;
  var xhrLive = !globalThis.XMLHttpRequest ||
    globalThis.XMLHttpRequest.prototype.send === globalThis.__RNE_WRAPPED_XHR_SEND__;
  // fetch and XHR drift independently — the app can replace one and leave the
  // other alone — so each gets its own "does this actually need wrapping"
  // flag. Without this, wrapping the mechanism that already held our own live
  // wrapper re-captured that wrapper as "the original" and chained it onto
  // itself, double-counting every request through it.
  var wrapFetch = !fetchLive;
  var wrapXhr = !xhrLive;
  if (installed && sameVersion && fetchLive && xhrLive) return "ok";
  if (installed && !sameVersion) {
    // An older build's hooks are in place. Re-installing on top of them would
    // double-wrap (and double-count) every request, so this is only safe when
    // that build saved the originals; otherwise say so — a reload clears it.
    if (!globalThis.__RNE_ORIG_FETCH__) return "stale";
    try {
      globalThis.fetch = globalThis.__RNE_ORIG_FETCH__;
      if (globalThis.__RNE_ORIG_XHR_OPEN__) globalThis.XMLHttpRequest.prototype.open = globalThis.__RNE_ORIG_XHR_OPEN__;
      if (globalThis.__RNE_ORIG_XHR_SEND__) globalThis.XMLHttpRequest.prototype.send = globalThis.__RNE_ORIG_XHR_SEND__;
      // The restore just put the app's own originals back in both places, so
      // both genuinely need wrapping again — not just whichever one drifted.
      wrapFetch = true;
      wrapXhr = true;
    } catch (e) { return "stale"; }
  }
  // Same version but our wrapper is gone: wrap whatever is live now. Restoring
  // first would put the *pre-reload* fetch back and lose the app's own.
  globalThis.__RNE_NET_INSTALLED__ = true;
  globalThis.__RNE_NET_VERSION__ = VERSION;
  globalThis.__RNE_IN_FETCH__ = 0;
  globalThis.__RNE_NET__ = globalThis.__RNE_NET__ || [];
  globalThis.__RNE_NET_SEQ__ = globalThis.__RNE_NET_SEQ__ || 0;
  var CAP = 200;
  var MAX_BODY = 4000;
  function record(entry) {
    entry.seq = ++globalThis.__RNE_NET_SEQ__;
    entry.timestamp = Date.now();
    globalThis.__RNE_NET__.push(entry);
    if (globalThis.__RNE_NET__.length > CAP) globalThis.__RNE_NET__.shift();
    return entry;
  }
  function touch(entry) { entry.__d = 1; }

  var origFetch = globalThis.fetch;
  if (origFetch && wrapFetch) {
    globalThis.__RNE_ORIG_FETCH__ = origFetch;
    globalThis.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      var started = Date.now();
      var reqBody = (init && typeof init.body === "string") ? init.body : undefined;
      var result;
      // RN's fetch is whatwg-fetch, i.e. an XHR underneath, and it opens/sends
      // that XHR synchronously inside this call. Without this flag both wrappers
      // record the same request and every call is counted twice.
      globalThis.__RNE_IN_FETCH__ = (globalThis.__RNE_IN_FETCH__ || 0) + 1;
      try {
        result = origFetch.apply(this, arguments);
      } finally {
        globalThis.__RNE_IN_FETCH__--;
      }
      return result.then(function (res) {
        // Recorded up front so the request is visible immediately; the body is
        // read asynchronously and merged into the same entry when it lands.
        var entry = record({
          method: method, url: url, status: res.status,
          durationMs: Date.now() - started, requestBody: reqBody, bodyPending: true
        });
        try {
          res.clone().text().then(function (t) {
            entry.responseBody = t ? t.slice(0, MAX_BODY) : undefined;
            entry.bodyPending = false;
            touch(entry);
          }, function () { entry.bodyPending = false; touch(entry); });
        } catch (e) { entry.bodyPending = false; }
        return res;
      }).catch(function (err) {
        record({ method: method, url: url, durationMs: Date.now() - started, requestBody: reqBody, error: String(err) });
        throw err;
      });
    };
    globalThis.__RNE_WRAPPED_FETCH__ = globalThis.fetch;
  }

  var XHR = globalThis.XMLHttpRequest;
  if (XHR && wrapXhr) {
    var open = XHR.prototype.open;
    var send = XHR.prototype.send;
    globalThis.__RNE_ORIG_XHR_OPEN__ = open;
    globalThis.__RNE_ORIG_XHR_SEND__ = send;
    function readBody(xhr) {
      // Both the type check and the read are guarded: responseType may be a
      // throwing getter on some polyfills too.
      try {
        var rt = xhr.responseType;
        if (rt === "" || rt === "text") {
          var t = xhr.responseText;
          return typeof t === "string" ? t.slice(0, MAX_BODY) : undefined;
        }
        if (rt === "json" && xhr.response != null) return JSON.stringify(xhr.response).slice(0, MAX_BODY);
      } catch (e) { /* unreadable body — the request itself is still recorded */ }
      return undefined;
    }
    XHR.prototype.open = function (method, url) {
      try { this.__rne = { method: method, url: url }; } catch (e) {}
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      var self = this;
      var started = Date.now();
      // Owned by the fetch wrapper above, which records it with better data.
      if (globalThis.__RNE_IN_FETCH__ > 0) {
        try { self.__rne = null; } catch (e) {}
        return send.apply(this, arguments);
      }
      try { if (self.__rne && typeof body === "string") self.__rne.requestBody = body; } catch (e) {}
      try {
        this.addEventListener("loadend", function () {
          try {
            if (!self.__rne) return;
            var status;
            try { status = self.status; } catch (e) {}
            record({
              method: self.__rne.method, url: self.__rne.url, status: status,
              durationMs: Date.now() - started, requestBody: self.__rne.requestBody,
              responseBody: readBody(self)
            });
          } catch (e) { /* never surface into app code */ }
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
    globalThis.__RNE_WRAPPED_XHR_SEND__ = XHR.prototype.send;
  }
  return "ok";
})();
`;

// Returns entries new since `sinceSeq` plus any earlier entry whose body has
// landed in the meantime (flagged with __d), so a late response body is never
// stranded behind the sequence watermark.
export function drainNetworkExpression(sinceSeq: number): string {
  return `JSON.stringify((globalThis.__RNE_NET__ || [])
    .filter(function (e) { return e.seq > ${sinceSeq} || e.__d; })
    .map(function (e) {
      e.__d = 0;
      var c = {};
      for (var k in e) { if (k !== "__d") c[k] = e[k]; }
      return c;
    }))`;
}

export const ERROR_INTERCEPTOR_VERSION = 3;

// In a dev build LogBox installs itself as the ErrorUtils global handler: it
// paints the redbox and swallows the exception, so CDP's Runtime.exceptionThrown
// never fires and the server's error buffer stayed empty under a full-screen
// redbox. This chains onto that handler rather than replacing it — the app must
// keep behaving exactly as it did, redbox included.
//
// The app may also call setGlobalHandler *after* us — LogBox in a runtime that
// was still booting, a crash reporter, the app's own code. Done naively that
// replaces our handler and every error until the next re-assert goes to the app
// alone (field test D26). So setGlobalHandler/getGlobalHandler are wrapped: a
// later handler becomes the next link in our chain, and the getter hands back
// that link instead of us, which is what the app would have seen without us
// (and keeps an app that chains onto "the current handler" from looping back).
export const ERROR_INTERCEPTOR_SOURCE = `
(function () {
  var VERSION = ${ERROR_INTERCEPTOR_VERSION};
  var EU = globalThis.ErrorUtils;
  if (!EU || typeof EU.getGlobalHandler !== "function" || typeof EU.setGlobalHandler !== "function") {
    return "unavailable";
  }
  // Once our wrappers are on this ErrorUtils, its public getter no longer
  // reports the real slot — only the original accessors do.
  var patched = globalThis.__RNE_ERR_EU__ === EU &&
    EU.getGlobalHandler === globalThis.__RNE_ERR_GET_WRAPPER__ &&
    EU.setGlobalHandler === globalThis.__RNE_ERR_SET_WRAPPER__;
  // A frozen ErrorUtils cannot carry the wrappers; there the handler identity
  // alone has to do, exactly as before the wrappers existed.
  var unpatchable = globalThis.__RNE_ERR_EU__ === EU && globalThis.__RNE_ERR_UNPATCHABLE__ === true;
  var realGet = patched ? globalThis.__RNE_ERR_ORIG_GET__ : EU.getGlobalHandler;
  var realSet = patched ? globalThis.__RNE_ERR_ORIG_SET__ : EU.setGlobalHandler;
  function safeGetHandler() {
    try { return { ok: true, value: realGet.call(EU) }; } catch (e) { return { ok: false, value: undefined }; }
  }
  if (globalThis.__RNE_ERR_INSTALLED__) {
    // Whether the handler ErrorUtils actually calls is still ours — on this
    // ErrorUtils, with our wrappers still on it — is the only honest test.
    // After a reload the app's LogBox takes the slot back and the flag alone
    // kept claiming the chain was intact (field test D13). A failed read here
    // just means "not demonstrably ours" — it falls through to the same
    // re-chain path as a confirmed replacement, which is safe either way.
    var live = (patched || unpatchable) && safeGetHandler().value === globalThis.__RNE_ERR_HANDLER__;
    if (globalThis.__RNE_ERR_VERSION__ === VERSION && live) return "ok";
    if (globalThis.__RNE_ERR_VERSION__ !== VERSION) {
      // An older build's handler sits in the chain. Restoring the handler it
      // replaced is the only way to re-install without recording every error twice.
      if (!globalThis.__RNE_ERR_PREV__) return "stale";
      try { realSet.call(EU, globalThis.__RNE_ERR_PREV__); } catch (e) { return "stale"; }
    }
    // Same version, handler gone: chain onto whatever is installed now. If our
    // old handler is somehow still buried in that chain the same error lands
    // twice; registry.ts's drain dedupes identical text within 5s, so the agent
    // is never told the app failed twice.
  }
  // A throwing read here cannot be treated as "no handler yet" — that reading
  // is what "there genuinely is no handler" (ok: true, value: undefined) means,
  // and it must keep working exactly as it does today. A failed read (ok: false)
  // is different: installing on top of it would call setGlobalHandler blind,
  // permanently overwriting whatever ErrorUtils currently calls — real or
  // app-installed — with no way to chain onto it. Declining outright, before
  // any state is touched, is what actually keeps the app's redbox painting.
  var prevResult = safeGetHandler();
  if (!prevResult.ok) return "unavailable";
  globalThis.__RNE_ERR_INSTALLED__ = true;
  globalThis.__RNE_ERR_VERSION__ = VERSION;
  globalThis.__RNE_ERR__ = globalThis.__RNE_ERR__ || [];
  globalThis.__RNE_ERR_SEQ__ = globalThis.__RNE_ERR_SEQ__ || 0;
  var CAP = 50;
  var MAX_STACK = 4000;
  // The next link: the handler we replaced, then whatever the app installs later.
  var next = prevResult.value;
  globalThis.__RNE_ERR_PREV__ = next;

  // A thrown value is arbitrary: it can be a string, null, or an object whose
  // every getter throws. Reading it unguarded would replace the app's redbox
  // with one of our own making.
  function describe(err) {
    try {
      if (err === null || err === undefined) return String(err);
      if (typeof err === "string") return err;
      var name = "";
      var msg = "";
      try { name = err.name ? String(err.name) : ""; } catch (e) {}
      try { msg = err.message ? String(err.message) : ""; } catch (e) {}
      if (name || msg) return (name ? name + ": " : "") + msg;
      return String(err);
    } catch (e) {
      return "unreadable thrown value";
    }
  }

  // Errors this handler is in the middle of passing down the chain. A link
  // that holds a stale reference to us and calls it with the same error would
  // otherwise recurse until the stack blows — inside the app's error path.
  var active = [];
  var handler = function (err, isFatal) {
    for (var i = 0; i < active.length; i++) if (active[i] === err) return;
    active.push(err);
    try {
      try {
        var stack;
        try {
          if (err && typeof err.stack === "string") stack = err.stack.slice(0, MAX_STACK);
        } catch (e) {}
        globalThis.__RNE_ERR__.push({
          seq: ++globalThis.__RNE_ERR_SEQ__,
          // Fatal is what RN paints as a full-screen redbox in dev; non-fatal
          // reaches the same handler but only dims the screen.
          kind: isFatal ? "redbox" : "exception",
          text: describe(err),
          stack: stack,
          timestamp: Date.now()
        });
        if (globalThis.__RNE_ERR__.length > CAP) globalThis.__RNE_ERR__.shift();
      } catch (e) { /* never surface into app code */ }
      if (typeof next === "function") return next(err, isFatal);
    } finally {
      active.pop();
    }
  };
  function ours() {
    return globalThis.__RNE_ERR_HANDLER__ === handler && safeGetHandler().value === handler;
  }
  var setWrapper = function (fn) {
    // While we hold the slot, a later handler becomes our next link instead of
    // unplugging us (field test D26). Once we no longer hold it — a newer
    // install re-chained elsewhere — behave exactly like the original.
    if (ours()) {
      if (fn !== handler) {
        next = fn;
        globalThis.__RNE_ERR_PREV__ = fn;
      }
      return;
    }
    return realSet.apply(EU, arguments);
  };
  var getWrapper = function () {
    var cur = safeGetHandler();
    if (!cur.ok) return realGet.apply(EU, arguments);
    return cur.value === handler ? next : cur.value;
  };
  globalThis.__RNE_ERR_HANDLER__ = handler;
  realSet.call(EU, handler);
  globalThis.__RNE_ERR_EU__ = EU;
  globalThis.__RNE_ERR_ORIG_GET__ = realGet;
  globalThis.__RNE_ERR_ORIG_SET__ = realSet;
  globalThis.__RNE_ERR_SET_WRAPPER__ = setWrapper;
  globalThis.__RNE_ERR_GET_WRAPPER__ = getWrapper;
  try {
    EU.setGlobalHandler = setWrapper;
    EU.getGlobalHandler = getWrapper;
  } catch (e) {}
  // A frozen ErrorUtils ignores (or throws on) the assignment. The chain still
  // works; it just cannot follow a later setGlobalHandler — the next tool
  // call's re-assert re-chains instead.
  var wrapped = EU.setGlobalHandler === setWrapper && EU.getGlobalHandler === getWrapper;
  if (!wrapped) {
    try { EU.setGlobalHandler = realSet; EU.getGlobalHandler = realGet; } catch (e) {}
  }
  globalThis.__RNE_ERR_UNPATCHABLE__ = !wrapped;
  return "ok";
})();
`;

/**
 * Takes the errors the app captured and clears them in the same synchronous
 * expression. A watermark would be wrong here: the app's counter restarts
 * whenever its JS context does, and a stale watermark would then filter out
 * every error from the new context — the exact blindness this path exists to fix.
 * Errors, unlike network entries, are never updated after the fact, so handing
 * them over and forgetting them loses nothing.
 */
export function drainErrorsExpression(): string {
  return `JSON.stringify((function () {
    var b = globalThis.__RNE_ERR__;
    if (!b || !b.length) return [];
    return b.splice(0, b.length);
  })())`;
}
