/*
 * jax_stream_swipe.js -- Jax Stream swipe gesture handler (browser side)
 *
 * Loaded once via Home Assistant's frontend.extra_module_url (see README).
 * Detects a horizontal swipe on the bundled clock view and calls
 * shell_command.jax_stream_swipe with {stream, direction}; the shell script
 * removes the photo from the album (left) or just advances (right).
 *
 * No HACS / browser_mod dependency -- plain touch events, matching the
 * distro's no-dependency ethos.
 *
 * Reliability (the important part): a slightly DOWNWARD swipe was swallowed by
 * the WebView's native pull-to-refresh and never reached this code (proven by
 * its absence from gesture logs). This WebView ignores preventDefault on
 * touchmove, so the real fix is declarative touch-action:none on the clock view
 * -- the browser will not even START a pan/pull gesture, so the touch stays with
 * us. It is applied to html/body only while on the clock view (nothing to
 * scroll there) and removed elsewhere so other dashboards scroll normally.
 * preventDefault + overscroll-behavior:none remain as secondary guards.
 *
 * Affordance: touching down on the clock view shows a faint, transparent hit
 * box with left/right hints so the gesture is discoverable and you get
 * immediate "swipe mode" feedback (CFG.showHint).
 *
 * Instant refresh: after the advance completes, the just-rewritten random.jpg
 * is already on disk, but the browser still shows the cached old URL. We force a
 * reload purely in THIS WebView by injecting a short-lived CSS override on the
 * clock card's background-image with a fresh ?v= -- NOT by writing VA's
 * background attribute (an earlier set_state approach made VA stop
 * auto-rotating). VA's timer rotation is left untouched.
 *
 * Tunables: window.JAX_SWIPE_CONFIG = { minDistance: 40 };
 */
(function () {
  "use strict";

  if (window.__jaxStreamSwipeLoaded) return; // guard against double-injection
  window.__jaxStreamSwipeLoaded = true;

  var CFG = Object.assign(
    {
      minDistance: 40,    // px of horizontal travel to count as a swipe
      axisRatio: 1.0,     // |dx| must exceed |dy| * axisRatio (allow diagonal)
      maxDuration: 2000,  // ms; real "look then swipe" gestures are slow
      cooldownMs: 1000,   // ignore further swipes until the advance settles
      refreshDelayMs: 3000, // ms to wait after callService before reloading the image;
                            // callService resolves on dispatch (not script completion),
                            // so the shell script needs time to write the new random.jpg
      showHint: true,     // transparent swipe affordance on touch
      showToast: true,    // brief on-screen confirmation
    },
    window.JAX_SWIPE_CONFIG || {}
  );

  // Belt-and-suspenders: discourage native pull-to-refresh/overscroll.
  try {
    var ob = document.createElement("style");
    ob.textContent = "html, body { overscroll-behavior: none !important; }";
    (document.head || document.documentElement).appendChild(ob);
  } catch (e) {}

  var STREAM_RE = /jax-stream\/([A-Za-z0-9_-]+)\//;

  var startX = 0, startY = 0, startT = 0, tracking = false, lastFire = 0;

  function getHass() {
    var el = document.querySelector("home-assistant");
    return el && el.hass ? el.hass : null;
  }

  // Cheap per-view gate: the bundled clock view's path contains "clock".
  // Swipes are only armed here, so other dashboards keep normal scrolling.
  function onClockView() {
    try { return location.pathname.toLowerCase().indexOf("clock") !== -1; }
    catch (e) { return false; }
  }

  // SwipeRefreshLayout bypass: two properties required together.
  //
  // (1) overflow:hidden -- disables the WebView's native scroll so
  //     canScrollVertically(-1) evaluates scrollTop directly.
  // (2) height:calc(100vh+1px) + scrollTop=1 -- with overflow:hidden, html
  //     is 1px taller than the viewport, so scrollTop=1 is addressable.
  //     With scrollTop > 0, canScrollVertically(-1) returns true and the
  //     native SwipeRefreshLayout backs off, passing all gestures to JS.
  //
  // Only applied on the clock view; all overrides removed on navigation away
  // so other views scroll normally. A scroll listener re-applies scrollTop=1.
  function setTouchAction(on) {
    try {
      var v = on ? "none" : "";
      var imp = on ? "important" : "";
      document.documentElement.style.setProperty("touch-action", v, imp);
      if (document.body) document.body.style.setProperty("touch-action", v, imp);
      if (on) {
        document.documentElement.style.setProperty("overflow", "hidden", "important");
        if (document.body) document.body.style.setProperty("overflow", "hidden", "important");
        document.documentElement.style.setProperty("height", "calc(100vh + 1px)", "important");
        document.documentElement.scrollTop = 1;
      } else {
        document.documentElement.style.removeProperty("overflow");
        if (document.body) document.body.style.removeProperty("overflow");
        document.documentElement.style.removeProperty("height");
      }
    } catch (e) {}
  }
  function syncTouchAction() { setTouchAction(onClockView()); }

  // Walk the DOM (incl. shadow roots) for the first jax-stream stream name in a
  // background-image -- the photo actually rendered on THIS device's clock view.
  function findStreamFromDom() {
    var stack = [document.documentElement];
    var guard = 0;
    while (stack.length && guard < 20000) {
      guard++;
      var node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        var probes = [];
        try { probes.push(getComputedStyle(node).backgroundImage); } catch (e) {}
        try { probes.push(getComputedStyle(node, "::before").backgroundImage); } catch (e) {}
        try { probes.push(getComputedStyle(node, "::after").backgroundImage); } catch (e) {}
        for (var i = 0; i < probes.length; i++) {
          if (probes[i] && probes[i] !== "none") {
            var m = STREAM_RE.exec(probes[i]);
            if (m) return m[1];
          }
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      var kids = node.children;
      if (kids) for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
    return null;
  }

  // Fallback: scan hass states for a jax-stream background attribute.
  function findStreamFromHass() {
    var hass = getHass();
    if (!hass || !hass.states) return null;
    var keys = Object.keys(hass.states);
    for (var i = 0; i < keys.length; i++) {
      var attrs = hass.states[keys[i]].attributes || {};
      var bg = attrs.background;
      if (typeof bg === "string") {
        var m = STREAM_RE.exec(bg);
        if (m) return m[1];
      }
    }
    return null;
  }

  function currentStream() {
    return findStreamFromDom() || findStreamFromHass();
  }

  // Returns a dismiss() callback so the caller can remove the label when the
  // new photo actually lands (see fireSwipe). Auto-dismisses after 12s as a
  // safety net in case callService or reloadStream fails silently.
  function showStatus(msg, color) {
    if (!CFG.showToast) return function () {};
    var t, safetyTimer;
    try {
      t = document.createElement("div");
      t.textContent = msg;
      t.style.cssText =
        "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);" +
        "background:rgba(0,0,0,0.75);color:" + color + ";padding:12px 28px;" +
        "border-radius:20px;font:700 6vh/1 sans-serif;z-index:99999;" +
        "pointer-events:none;transition:opacity .4s;opacity:1;";
      document.body.appendChild(t);
    } catch (e) { return function () {}; }
    function dismiss() {
      try {
        clearTimeout(safetyTimer);
        t.style.opacity = "0";
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 500);
      } catch (e) {}
    }
    safetyTimer = setTimeout(dismiss, 12000);
    return dismiss;
  }

  // Transparent swipe affordance shown while a gesture is in progress.
  var hintEl = null;
  function showHint() {
    if (!CFG.showHint) return;
    try {
      if (!hintEl) {
        hintEl = document.createElement("div");
        hintEl.style.cssText =
          "position:fixed;inset:0;z-index:99997;pointer-events:none;opacity:0;" +
          "transition:opacity .12s;display:flex;align-items:center;" +
          "justify-content:space-between;padding:0 6vw;box-sizing:border-box;" +
          "color:rgba(255,255,255,0.9);font:800 7vh/1 sans-serif;" +
          "text-shadow:0 2px 6px #000;" +
          "background:radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.22) 100%);";
        hintEl.innerHTML = "<span>&#8249;</span><span>&#8250;</span>";
        document.body.appendChild(hintEl);
      }
      hintEl.style.opacity = "1";
    } catch (e) {}
  }
  function hideHint() { try { if (hintEl) hintEl.style.opacity = "0"; } catch (e) {} }

  // Instant refresh, client-side only. Override the clock card's
  // background-image with a fresh ?v= so THIS WebView re-fetches the
  // already-rewritten random.jpg. Held ~65s then removed so VA's own rotation
  // repaints. VA's background attribute is never written (that would stop
  // rotation), so timer rotation keeps running.
  function reloadStream(stream) {
    var stack = [document.documentElement];
    var guard = 0;
    while (stack.length && guard < 20000) {
      guard++;
      var node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        var probe = "";
        try {
          var a = getComputedStyle(node, "::after").backgroundImage;
          if (a && a !== "none" && STREAM_RE.test(a)) probe = a;
        } catch (e) {}
        if (!probe) {
          try {
            var b = getComputedStyle(node, "::before").backgroundImage;
            if (b && b !== "none" && STREAM_RE.test(b)) probe = b;
          } catch (e) {}
        }
        if (probe) {
          var sm = STREAM_RE.exec(probe);
          var um = probe.match(/url\(["']?([^"')?]+)/);
          if (sm && sm[1] === stream && um) {
            var fresh = um[1] + "?v=" + Date.now();
            var root = node.getRootNode && node.getRootNode();
            if (root && root.appendChild) {
              var prev = root.querySelector && root.querySelector("style[data-jax-refresh]");
              if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
              var st = document.createElement("style");
              st.setAttribute("data-jax-refresh", "1");
              st.textContent =
                'ha-card::before, ha-card::after { background-image: url("' +
                fresh + '") !important; }';
              root.appendChild(st);
              (function (s) {
                setTimeout(function () {
                  if (s && s.parentNode) s.parentNode.removeChild(s);
                }, 65000);
              })(st);
            }
          }
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      var kids = node.children;
      if (kids) for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
  }

  function fireSwipe(direction, stream) {
    var hass = getHass();
    if (!hass) return;
    var dismiss = showStatus(
      direction === "left" ? "Removing" : "Next",
      direction === "left" ? "#ff5555" : "#55dd55"
    );
    var delay = typeof CFG.refreshDelayMs === "number" ? CFG.refreshDelayMs : 3000;
    Promise.resolve(
      hass.callService("shell_command", "jax_stream_swipe", {
        stream: stream,
        direction: direction,
      })
    ).then(function () {
      setTimeout(function () {
        reloadStream(stream);
        // Brief pause so the new photo has a moment to paint before the label goes.
        setTimeout(dismiss, 800);
      }, delay);
    }).catch(function (err) {
      dismiss();
      // eslint-disable-next-line no-console
      console.error("[jax-stream-swipe] callService failed:", err);
    });
  }

  function pointOf(e) {
    if (e.touches && e.touches.length) return e.touches[0];
    if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
    return e;
  }

  function onStart(e) {
    if (e.touches && e.touches.length > 1) { tracking = false; return; }
    if (!onClockView()) { tracking = false; return; } // only arm on the clock view
    var p = pointOf(e);
    startX = p.clientX; startY = p.clientY; startT = Date.now();
    tracking = true;
    showHint();
  }

  // On the clock view (nothing to scroll there) preventDefault EVERY move while
  // tracking -- from the very first one -- so a downward swipe cannot start the
  // native pull-to-refresh. Latching only on horizontal intent was the bug: a
  // slightly-downward swipe begins vertical, so the pull fired before the latch.
  // Taps still produce a click; the clock view has no scroll to lose.
  function onMove(e) {
    if (!tracking) return;
    if (e.cancelable) e.preventDefault();
  }

  function onCancel(e) {
    if (!tracking) return;
    tracking = false;
    hideHint();
  }

  function onEnd(e) {
    if (!tracking) return;
    tracking = false;
    hideHint();

    var p = pointOf(e);
    var dx = Math.round(p.clientX - startX);
    var dy = Math.round(p.clientY - startY);
    var dt = Date.now() - startT;
    var adx = Math.abs(dx), ady = Math.abs(dy);

    if (adx < CFG.minDistance) return;
    if (dt > CFG.maxDuration) return;
    if (adx < ady * CFG.axisRatio) return;

    var now = Date.now();
    if (now - lastFire < CFG.cooldownMs) return;
    var stream = currentStream();
    if (!stream) return;

    lastFire = now;
    if (e.stopPropagation) e.stopPropagation();
    fireSwipe(dx < 0 ? "left" : "right", stream);
  }

  // Apply touch-action:none on the clock view (the real pull-to-refresh fix),
  // and keep it in sync as the device navigates between views.
  syncTouchAction();
  window.addEventListener("location-changed", syncTouchAction); // HA frontend nav
  window.addEventListener("popstate", syncTouchAction);
  window.addEventListener("hashchange", syncTouchAction);
  setInterval(syncTouchAction, 1500); // fallback if a nav event is missed

  // Re-apply scrollTop=1 whenever it resets to 0. The native SwipeRefreshLayout
  // may briefly reset it after intercepting a gesture; keeping it at 1 ensures
  // the next downward swipe also reaches JavaScript.
  window.addEventListener("scroll", function () {
    if (onClockView() && document.documentElement.scrollTop < 0.5) {
      document.documentElement.scrollTop = 1;
    }
  }, { passive: true });

  // touchmove non-passive is a secondary guard (this WebView may ignore it).
  window.addEventListener("touchstart", onStart, { passive: true, capture: true });
  window.addEventListener("touchmove", onMove, { passive: false, capture: true });
  window.addEventListener("touchend", onEnd, { capture: true });
  window.addEventListener("touchcancel", onCancel, { capture: true });

  // Mouse fallback for desktop / emulator testing without a touchscreen.
  window.addEventListener("mousedown", onStart, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onEnd, true);

  // eslint-disable-next-line no-console
  console.info("[jax-stream-swipe] loaded");
})();
