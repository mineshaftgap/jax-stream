/*
 * jax_stream.js -- Jax Stream browser module (swipe, menus, overlays)
 *
 * Loaded once via Home Assistant's frontend.extra_module_url (see README).
 * Horizontal swipe: right = advance to next photo; left = go to previous photo
 *   (in-memory history stack, up to 10 entries). Remove-from-album is menu-only (jaxmenu -> remove).
 *
 * Uses plain touch events, with no browser_mod dependency.
 *
 * Reliability: a slightly DOWNWARD swipe was swallowed by the WebView's native
 * pull-to-refresh before reaching this code. The fix is overflow:hidden +
 * scrollTop=1 on html/body (SwipeRefreshLayout bypass -- see DEVEL.md).
 *
 * Tunables: window.JAX_SWIPE_CONFIG = { minDistance: 40, axisRatio: 1.0 };
 */
(function () {
  "use strict";

  // Remove listeners from any previous injection before re-registering.
  if (window.__jaxStreamSwipeDestroy) {
    try { window.__jaxStreamSwipeDestroy(); } catch (e) {}
  }
  window.__jaxStreamSwipeLoaded = true;

  var CFG = Object.assign(
    {
      minDistance: 40,    // px of horizontal travel to count as a swipe
      axisRatio: 1.0,     // |dx| must exceed |dy| * axisRatio (allow diagonal)
      maxDuration: 2000,  // ms; real "look then swipe" gestures are slow
      cooldownMs: 1000,   // ignore further swipes until the advance settles
      refreshDelayMs: 500,  // ms to wait after callService before reloading the image
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

  function loadStyle(stream) {
    try {
      fetch('/view_assist/images/jax-stream/' + stream + '/style.css')
        .then(function(r) { return r.ok ? r.text() : null; })
        .then(function(css) {
          if (!css) return;
          var old = document.getElementById('jax-style');
          if (old && old.parentNode) old.parentNode.removeChild(old);
          var el = document.createElement('style');
          el.id = 'jax-style';
          el.textContent = css;
          (document.head || document.documentElement).appendChild(el);
        })
        .catch(function() {});
    } catch (e) {}
  }

  var startX = 0, startY = 0, startT = 0, tracking = false, lastFire = 0;
  var ratingMenuOverlay = null;
  var ratingPrefetchStream = null;
  var ratingPrefetchTime   = 0;
  var lastPhotoSrc = null;
  // Photos are all served as the same overwrite-in-place file (random.jpg); a
  // past photo has no stable server URL. So back-nav caches the BYTES of each
  // photo into an in-memory blob: URL while it is on screen, and history holds
  // those blob URLs -- never the server URL, which would just re-fetch current.
  var photoHistory = [];       // [{blobUrl, stream}], oldest at [0], max 10
  var historyPos   = -1;       // -1 = live; >=0 = browsing photoHistory[historyPos]
  var histNavSuppress = false; // true for ONE checkPhotoChange cycle after nav injection
  var liveBlobUrl  = null;     // blob: URL of the photo currently live on screen
  var liveBlobSrc  = null;     // the computed bg string liveBlobUrl was captured from
  var bgRoot       = null;     // cached shadow root hosting ha-card (showBg target)

  // Pause / suppress-auto-advance state. The server (jax_stream_action.sh) is
  // the source of truth via pause_manual.txt / pause_touch.txt; these mirror it
  // for the UI. See DEVEL / TODO "Suppress auto-advance after recent touch".
  var paused        = false;   // manual pause (mirrors pause_manual.txt)
  var lastTouchArm  = 0;       // ms of last 'touch' shell call (debounce)
  var pauseIndicator = null;   // persistent quick-unpause icon (manual pause only)
  var lastPauseAt   = 0;       // ms of the last doPause (indicator mouseup guard)
  var TOUCH_ARM_DEBOUNCE_MS = 30000;  // don't re-arm the 90s window more than this often
  // Two bars = pause action; triangle = resume action (also the indicator glyph).
  var PAUSE_SVG =
    '<svg pointer-events="none" width="28" height="28" viewBox="0 0 24 24">' +
    '<rect x="6" y="5" width="4" height="14" rx="1" fill="#fff"/>' +
    '<rect x="14" y="5" width="4" height="14" rx="1" fill="#fff"/></svg>';
  var RESUME_SVG =
    '<svg pointer-events="none" width="28" height="28" viewBox="0 0 24 24">' +
    '<polygon points="7,5 19,12 7,19" fill="#fff"/></svg>';

  function getHass() {
    var el = document.querySelector("home-assistant");
    return el && el.hass ? el.hass : null;
  }

  function onClockView() {
    try {
      var p = location.pathname.toLowerCase();
      return p.indexOf("clock") !== -1 || p.indexOf("jax-stream") !== -1;
    }
    catch (e) { return false; }
  }

  // SwipeRefreshLayout bypass -- see DEVEL.md for the full explanation.
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

  function showStatus(msg, color) {
    if (!CFG.showToast) return function () {};
    // window-scoped so all injected instances share one active toast -- prevents
    // multiple closure-local trackers from stacking toasts during CDP iteration.
    if (window.__jaxActiveToast) { try { window.__jaxActiveToast(); } catch (e) {} window.__jaxActiveToast = null; }
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
        if (window.__jaxActiveToast === dismiss) window.__jaxActiveToast = null;
        clearTimeout(safetyTimer);
        t.style.opacity = "0";
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 500);
      } catch (e) {}
    }
    safetyTimer = setTimeout(dismiss, 12000);
    window.__jaxActiveToast = dismiss;
    return dismiss;
  }

  // Left/right swipe affordance.
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

  // Confirm overlay for remove gestures. Only one instance at a time.
  // Set window.__jaxConfirmSkip = true to bypass (used by the test suite).
  var confirmOverlay = null;
  function showConfirm(onYes, onNo) {
    if (window.__jaxConfirmSkip) { if (onYes) onYes(); return; }
    if (confirmOverlay) return;
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:100000;" +
      "background:rgba(0,0,0,0.65);display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:6vh;";
    // Prevent scroll/swipe under the overlay. Do NOT stopPropagation on touchend
    // or mouseup -- those must reach the buttons. onEnd guards itself via confirmOverlay.
    overlay.addEventListener("touchstart", function(e) { e.stopPropagation(); }, { capture: true });
    overlay.addEventListener("touchmove", function(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { capture: true, passive: false });
    overlay.addEventListener("mousedown", function(e) { e.stopPropagation(); }, true);
    var msg = document.createElement("div");
    msg.textContent = "Remove from Album?";
    msg.style.cssText =
      "color:#fff;font:700 6vh/1.3 sans-serif;text-align:center;" +
      "padding:0 8vw;text-shadow:0 2px 8px rgba(0,0,0,0.8);";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6vw;";
    function makeBtn(label, bg) {
      var b = document.createElement("div");
      b.textContent = label;
      b.style.cssText =
        "background:" + bg + ";color:#fff;font:700 5vh/1 sans-serif;" +
        "padding:3vh 10vw;border-radius:16px;cursor:pointer;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.5);";
      return b;
    }
    var yesBtn = makeBtn("Remove", "#cc3333");
    var noBtn = makeBtn("Cancel", "#555555");
    row.appendChild(yesBtn);
    row.appendChild(noBtn);
    overlay.appendChild(msg);
    overlay.appendChild(row);
    document.body.appendChild(overlay);
    confirmOverlay = overlay;
    var autoTimer = setTimeout(function() { cleanup(); }, 8000);
    function cleanup() {
      clearTimeout(autoTimer);
      confirmOverlay = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function handleYes() { cleanup(); if (onYes) onYes(); }
    function handleNo() { cleanup(); if (onNo) onNo(); }
    yesBtn.addEventListener("touchend", function(e) { e.stopPropagation(); handleYes(); }, { capture: true });
    noBtn.addEventListener("touchend", function(e) { e.stopPropagation(); handleNo(); }, { capture: true });
    yesBtn.addEventListener("mouseup", function(e) { e.stopPropagation(); handleYes(); }, true);
    noBtn.addEventListener("mouseup", function(e) { e.stopPropagation(); handleNo(); }, true);
  }

  function openRatingMenu(stream, currentRating) {
    if (ratingMenuOverlay) return;
    if (typeof currentRating !== "number" || currentRating < 0 || currentRating > 5) currentRating = 0;
    tracking = false;
    hideHint();
    window.__jaxLastMenu = { stream: stream, currentRating: currentRating, t: Date.now() };
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:100000;" +
      "background:rgba(0,0,0,0.70);display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:7vh;";
    overlay.addEventListener("touchstart", function(e) { e.stopPropagation(); }, { capture: true });
    overlay.addEventListener("touchmove", function(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { capture: true, passive: false });
    overlay.addEventListener("mousedown", function(e) { e.stopPropagation(); }, true);
    var title = document.createElement("div");
    title.textContent = "Rate Photo";
    title.style.cssText = "color:#fff;font:700 5vh/1 sans-serif;text-align:center;";
    var starRow = document.createElement("div");
    starRow.style.cssText =
      "display:flex;flex-wrap:wrap;justify-content:center;gap:2vw;" +
      "background:#000;border-radius:9999px;padding:2vh 5vw;";
    ratingMenuOverlay = overlay;
    var autoTimer = setTimeout(function() { cleanup(); }, 8000);
    function cleanup() {
      clearTimeout(autoTimer);
      ratingMenuOverlay = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    var starBtns = [];
    for (var n = 1; n <= 5; n++) {
      (function(stars) {
        var btn = document.createElement("div");
        var filled = stars <= currentRating;
        btn.innerHTML = filled ? "&#9733;" : "&#9734;";
        btn.style.cssText =
          "font:700 10vh/1 sans-serif;padding:1vh 2vw;cursor:pointer;" +
          "color:" + (filled ? "#FFD700" : "#555") + ";";
        starBtns.push(btn);
        var fired = false;
        function doRate() {
          if (fired) return;
          fired = true;
          for (var i = 0; i < starBtns.length; i++) {
            starBtns[i].innerHTML = i < stars ? "&#9733;" : "&#9734;";
            starBtns[i].style.color = i < stars ? "#FFD700" : "#555";
          }
          setTimeout(function() {
            var alreadyGone = !overlay.parentNode;
            cleanup();
            if (!alreadyGone) fireRating(stream, stars);
          }, 600);
        }
        btn.addEventListener("touchend", function(e) { e.stopPropagation(); doRate(); }, { capture: true });
        btn.addEventListener("mouseup", function(e) { e.stopPropagation(); doRate(); }, true);
        starRow.appendChild(btn);
      })(n);
    }
    var unrateBtn = document.createElement("div");
    unrateBtn.textContent = "Unrate";
    unrateBtn.style.cssText =
      "color:#aaa;font:700 4vh/1 sans-serif;padding:2vh 8vw;" +
      "border-radius:12px;cursor:pointer;" +
      (currentRating === 0
        ? "background:rgba(255,255,255,0.20);box-shadow:0 0 0 2px #aaa;"
        : "background:rgba(255,255,255,0.08);");
    var unrateFired = false;
    function doUnrate() {
      if (unrateFired) return;
      unrateFired = true;
      cleanup();
      fireRating(stream, 0);
    }
    unrateBtn.addEventListener("touchend", function(e) { e.stopPropagation(); doUnrate(); }, { capture: true });
    unrateBtn.addEventListener("mouseup", function(e) { e.stopPropagation(); doUnrate(); }, true);
    var overlayOpenedAt = Date.now();
    overlay.addEventListener("touchend", function(e) { if (Date.now() - overlayOpenedAt > 300 && e.target === overlay) cleanup(); }, false);
    overlay.addEventListener("mouseup", function(e) { if (Date.now() - overlayOpenedAt > 300 && e.target === overlay) cleanup(); }, false);
    overlay.appendChild(title);
    overlay.appendChild(starRow);
    overlay.appendChild(unrateBtn);
    document.body.appendChild(overlay);
  }

  function fireRating(stream, stars) {
    var hass = getHass();
    if (!hass) return;
    var msg = stars === 0 ? "Unrated" : ("Rated " + stars + (stars === 1 ? " star" : " stars"));
    var color = stars === 0 ? "#aaaaaa" : "#ffcc44";
    showStatus(msg, color);
    window.__jaxLastRating = { stars: stars, stream: stream, t: Date.now() };
    Promise.resolve(
      hass.callService("jax_stream", "set_rating", {
        stream: stream,
        rating: stars,
      })
    ).catch(function (err) {
      // eslint-disable-next-line no-console
      console.error("[jax-stream-swipe] rating callService failed:", err);
    });
  }

  function reloadStream(stream) {
    closeJaxMenu();
    if (confirmOverlay && confirmOverlay.parentNode) { confirmOverlay.parentNode.removeChild(confirmOverlay); confirmOverlay = null; }
    if (ratingMenuOverlay && ratingMenuOverlay.parentNode) { ratingMenuOverlay.parentNode.removeChild(ratingMenuOverlay); ratingMenuOverlay = null; }
    loadStyle(stream);
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
              window.__jaxLastReload = { stream: stream, url: fresh, t: Date.now() };
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

  // Find the shadow root hosting the jax-stream ha-card. While live the card's
  // pseudo background matches STREAM_RE; once we inject a blob bg the computed
  // value is blob: and no longer matches, so we cache the root and fall back to
  // it on later navigations.
  function findBgRoot(stream) {
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
          if (sm && (!stream || sm[1] === stream)) {
            var root = node.getRootNode && node.getRootNode();
            if (root && root.appendChild) { bgRoot = root; return root; }
          }
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      var kids = node.children;
      if (kids) for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
    // Fall back to the last-known root (it persists across photo changes) if it
    // is still attached.
    if (bgRoot && bgRoot.appendChild) return bgRoot;
    return null;
  }

  // Capture the bytes of the currently-live photo into a blob: URL so back-nav
  // can show it later, after the server has overwritten random.jpg. Idempotent
  // per source string; only the most recent capture is kept.
  function captureLive(src) {
    if (!src || src === liveBlobSrc) return;
    var m = src.match(/url\(["']?([^"')]+)/);
    var fetchUrl = m ? m[1] : src;   // keep ?v= -- fetches the bytes live RIGHT NOW
    liveBlobSrc = src;
    fetch(fetchUrl, { credentials: "include" })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) {
        if (!b) return;
        var u = URL.createObjectURL(b);
        if (liveBlobSrc === src) {
          // Replace any earlier live blob that was never pushed to history.
          if (liveBlobUrl) URL.revokeObjectURL(liveBlobUrl);
          liveBlobUrl = u;
          window.__jaxLiveBlobUrl = u;
        } else {
          URL.revokeObjectURL(u);  // a newer photo superseded this capture
        }
      })
      .catch(function () {});
  }

  // Paint a cached blob: URL as the background. blobUrl is immutable so no
  // cache-buster is appended (a ?v= query would break the blob URL).
  function showBg(blobUrl, stream) {
    if (!blobUrl) return;
    var root = findBgRoot(stream);
    if (!root) return;
    var prev = root.querySelector && root.querySelector("style[data-jax-refresh]");
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var st = document.createElement("style");
    st.setAttribute("data-jax-refresh", "1");
    st.textContent =
      'ha-card::before, ha-card::after { background-image: url("' + blobUrl + '") !important; }';
    root.appendChild(st);
    window.__jaxLastReload = { stream: stream, url: blobUrl, t: Date.now() };
  }

  // Append to history, evicting + revoking the oldest blob past the cap of 10.
  function pushHistory(blobUrl, stream) {
    photoHistory.push({ blobUrl: blobUrl, stream: stream });
    if (photoHistory.length > 10) {
      var ev = photoHistory.shift();
      if (ev && ev.blobUrl) URL.revokeObjectURL(ev.blobUrl);
    }
  }

  function navTo(historyEntryPos, stream) {
    historyPos = historyEntryPos; histNavSuppress = true;
    window.__jaxHistoryPos = historyPos;
    window.__jaxLastBack = { pos: historyPos, url: photoHistory[historyPos].blobUrl, t: Date.now() };
    showStatus("Back", "#5599ff");
    showBg(photoHistory[historyPos].blobUrl, stream);
  }

  function navBack(stream) {
    if (historyPos >= 0) {
      if (historyPos === 0) { showStatus("No previous photo", "#888888"); return; }
      navTo(historyPos - 1, stream); return;
    }
    // From live. Nothing recorded yet -> nowhere to go back to.
    if (photoHistory.length === 0) { showStatus("No previous photo", "#888888"); return; }
    // Push the current live photo so the user can swipe forward back to it, then
    // step to the photo shown just before it.
    if (liveBlobUrl) {
      pushHistory(liveBlobUrl, stream);
      liveBlobUrl = null;             // ownership transferred to history
      window.__jaxLiveBlobUrl = null;
    }
    var targetPos = photoHistory.length - 2;
    if (targetPos < 0) { showStatus("No previous photo", "#888888"); return; }
    navTo(targetPos, stream);
  }

  function navForward(stream) {
    if (historyPos < 0) { fireSwipe("right", stream); return; }
    var nextPos = historyPos + 1;
    if (nextPos >= photoHistory.length) {
      historyPos = -1; histNavSuppress = true; window.__jaxHistoryPos = -1;
      fireSwipe("right", stream); return;
    }
    historyPos = nextPos; histNavSuppress = true; window.__jaxHistoryPos = historyPos;
    showBg(photoHistory[historyPos].blobUrl, stream);
  }

  function fireSwipe(direction, stream) {
    var hass = getHass();
    if (!hass) return;
    var dismiss = showStatus(
      direction === "left" ? "Removing" : "Next",
      direction === "left" ? "#ff5555" : "#55dd55"
    );
    var delay = typeof CFG.refreshDelayMs === "number" ? CFG.refreshDelayMs : 3000;
    window.__jaxLastSwipe = { direction: direction, stream: stream, t: Date.now() };
    Promise.resolve(
      hass.callService("shell_command", "jax_stream_action", {
        subcommand: "swipe",
        stream: stream,
        direction: direction,
      })
    ).then(function () {
      setTimeout(function () {
        reloadStream(stream);
        setTimeout(dismiss, 800);
        // Fire prefetch directly on swipe; checkPhotoChange covers organic advances.
        ratingPrefetchStream = stream;
        ratingPrefetchTime   = Date.now();
        window.__jaxRatingPrefetch = { stream: stream, t: ratingPrefetchTime };
        // rate_menu prefetch removed: coordinator writes rate_current.txt on every advance (D-11).
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
    if (!onClockView()) { tracking = false; return; }
    if (isJaxUi(e.target)) { tracking = false; return; }
    var p = pointOf(e);
    startX = p.clientX; startY = p.clientY; startT = Date.now();
    tracking = true;
    showHint();
  }

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
    if (confirmOverlay) return; // let the overlay's own button handlers fire

    var p = pointOf(e);
    var dx = Math.round(p.clientX - startX);
    var dy = Math.round(p.clientY - startY);
    var dt = Date.now() - startT;
    var adx = Math.abs(dx), ady = Math.abs(dy);

    // Any genuine screen touch (tap or swipe) arms the 90s suppression window.
    var stream = currentStream();
    if (stream) armTouchWindow(stream);

    // Horizontal path: swipe advance / remove.
    if (adx < CFG.minDistance) return;
    if (dt > CFG.maxDuration) return;
    if (adx < ady * CFG.axisRatio) return;

    var now = Date.now();
    if (now - lastFire < CFG.cooldownMs) return;
    if (!stream) return;

    lastFire = now;
    if (e.stopPropagation) e.stopPropagation();
    var dir = dx < 0 ? "left" : "right";
    if (dir === "left") {
      navBack(stream);
    } else {
      navForward(stream);
    }
    // A deliberate swipe auto-unpauses (clears the manual hold); the touch
    // window armed above keeps the landed photo for 90s.
    if (paused) autoUnpause(stream);
  }

  function onScroll() {
    if (onClockView() && document.documentElement.scrollTop < 0.5) {
      document.documentElement.scrollTop = 1;
    }
  }


  // --- Pause / suppress-auto-advance ---------------------------------------
  // Fire a pause-state shell action (pause|unpause|resume|touch) and record it
  // for tests. The server file the subcommand touches is the real state.
  function firePauseAction(sub, stream) {
    var hass = getHass();
    if (!hass || !stream) return;
    window.__jaxLastPauseCall = { subcommand: sub, stream: stream, t: Date.now() };
    // Map subcommand to jax_stream service (D-13, Option C). Keep function signature identical.
    // "unpause" maps to jax_stream.next per D-08 (auto-unpause advances the slide).
    var p;
    if (sub === "pause") {
      p = hass.callService("jax_stream", "pause", { stream: stream });
    } else if (sub === "resume") {
      p = hass.callService("jax_stream", "resume", { stream: stream });
    } else if (sub === "touch") {
      p = hass.callService("jax_stream", "touch", { stream: stream });
    } else if (sub === "unpause") {
      p = hass.callService("jax_stream", "next", { stream: stream });
    } else {
      p = Promise.resolve();
    }
    Promise.resolve(p).catch(function (err) { console.error("[jax-stream] " + sub + " failed:", err); });
  }

  // Any genuine screen touch arms the 90s suppression window (debounced so we
  // don't spawn a shell command on every touch).
  function armTouchWindow(stream) {
    var now = Date.now();
    if (now - lastTouchArm < TOUCH_ARM_DEBOUNCE_MS) return;
    lastTouchArm = now;
    firePauseAction("touch", stream);
  }

  function doPause(stream) {
    paused = true; window.__jaxPaused = true;
    lastPauseAt = Date.now();
    firePauseAction("pause", stream);
    syncPauseIndicator();
  }
  // Explicit unpause (flyout Resume / indicator tap): immediate full resume.
  function doResume(stream) {
    paused = false; window.__jaxPaused = false;
    firePauseAction("resume", stream);
    syncPauseIndicator();
  }
  // Swipe-driven auto-unpause: lift the manual hold only; the swipe's own
  // armTouchWindow keeps the landed photo for 90s.
  function autoUnpause(stream) {
    if (!paused) return;
    paused = false; window.__jaxPaused = false;
    firePauseAction("unpause", stream);
    syncPauseIndicator();
  }

  // True if node is inside any jax-owned UI (so its taps neither swipe nor arm
  // the touch window -- e.g. the unpause indicator must not re-suppress).
  function isJaxUi(node) {
    if (!node) return false;
    var ctrls = [jaxMenuTrigger, pauseIndicator, jaxMenuOverlay, confirmOverlay, ratingMenuOverlay];
    for (var i = 0; i < ctrls.length; i++) {
      var c = ctrls[i];
      if (c && (c === node || (c.contains && c.contains(node)))) return true;
    }
    for (var j = 0; j < jaxMenuItems.length; j++) {
      var it = jaxMenuItems[j];
      if (it === node || (it.contains && it.contains(node))) return true;
    }
    return false;
  }

  function ensurePauseIndicator() {
    if (pauseIndicator) return;
    // Sweep stale indicators left by older injections this module's destroy
    // doesn't know about (CDP iteration artifact) -- mirrors ensureJaxMenuTrigger.
    document.querySelectorAll("body > div").forEach(function(el) {
      if (el.style.zIndex === "99991" && el.parentNode) el.parentNode.removeChild(el);
    });
    pauseIndicator = document.createElement("div");
    // Aligned with the flyout's first item (left:11 + translateX 63) so it reads
    // as the pause control persisting just right of the jaxicon.
    pauseIndicator.style.cssText =
      "position:fixed;top:15px;left:11px;width:55px;height:55px;" +
      "transform:translateX(63px);background:rgba(0,0,0,0.45);border-radius:10px;" +
      "display:none;align-items:center;justify-content:center;" +
      "z-index:99991;cursor:pointer;user-select:none;";
    pauseIndicator.innerHTML = RESUME_SVG;  // shows the resume affordance
    // Ignore activations within 500ms of a pause: the indicator appears at the
    // same spot as the flyout's pause item, so the compatibility mouseup
    // synthesized ~immediately after a touch-tap on that item would otherwise
    // resume instantly (pause -> unpause). Guard on the pause TIME (deterministic)
    // not the indicator's show time (which a syncAll tick can defer). A real
    // resume tap is always well after the pause.
    function onIndicatorActivate(e) {
      e.stopPropagation();
      if (Date.now() - lastPauseAt < 500) return;
      doResume(currentStream());
    }
    pauseIndicator.addEventListener("touchstart", function (e) { e.stopPropagation(); }, { capture: true });
    pauseIndicator.addEventListener("touchend", onIndicatorActivate, { capture: true });
    pauseIndicator.addEventListener("mousedown", function (e) { e.stopPropagation(); }, true);
    pauseIndicator.addEventListener("mouseup", onIndicatorActivate, true);
    document.body.appendChild(pauseIndicator);
  }

  // Visible whenever manually paused on the clock view. While the flyout is open
  // its first item (z 99992) sits on top of the indicator (z 99991), so they do
  // not visually conflict; gating on !jaxMenuOverlay was a fragile ordering
  // dependency (the indicator could stay hidden if an overlay lingered).
  function syncPauseIndicator() {
    ensurePauseIndicator();
    var show = paused && onClockView();
    pauseIndicator.style.display = show ? "flex" : "none";
  }

  // Read the server's manual-pause state once the stream is known. Restores the
  // indicator after a VA bounce / view reload (browser state is lost; the file
  // persists). A missing file (404) reads as not-paused.
  function readPauseState(stream) {
    if (!stream) return;
    fetch('/view_assist/images/jax-stream/' + stream + '/pause_manual.txt?v=' + Date.now())
      .then(function (r) { paused = r.ok; window.__jaxPaused = paused; syncPauseIndicator(); })
      .catch(function () {});
  }

  // Corner menu trigger -- shown only on the clock view. Provides jax-stream
  // actions (pause, remove, rate) without depending on VA's hamburger menu API,
  // which does not support runtime menu item removal in the installed version.
  var jaxMenuTrigger = null;
  var jaxMenuOverlay = null;
  var jaxMenuItems = [];
  var jaxMenuAutoTimer = null;

  function closeJaxMenu() {
    clearTimeout(jaxMenuAutoTimer);
    jaxMenuAutoTimer = null;
    if (jaxMenuOverlay && jaxMenuOverlay.parentNode) jaxMenuOverlay.parentNode.removeChild(jaxMenuOverlay);
    jaxMenuOverlay = null;
    jaxMenuItems.forEach(function(el) { if (el.parentNode) el.parentNode.removeChild(el); });
    jaxMenuItems = [];
  }

  function ensureJaxMenuTrigger() {
    if (jaxMenuTrigger) return;
    // Sweep any stale triggers left by older injections that this module's
    // destroy doesn't know about (CDP iteration artifact).
    document.querySelectorAll("body > div").forEach(function(el) {
      if (el.style.zIndex === "99990") el.parentNode.removeChild(el);
    });
    jaxMenuTrigger = document.createElement("div");
    jaxMenuTrigger.style.cssText =
      "position:fixed;top:15px;left:11px;width:55px;height:55px;" +
      "background:rgba(0,0,0,0);" +
      "display:flex;align-items:center;justify-content:center;" +
      "z-index:99990;cursor:pointer;user-select:none;";
    var jaxImg = document.createElement("img");
    jaxImg.src = "/local/jaxicon.svg?v=3";
    // Opacity is blueprint-driven via --jax-icon-opacity (emitted into
    // style.css by jax_stream_action.sh write_conf). Softens the stark white
    // jaxicon toward the lighter weight of the VA menu icons. Fallback 0.8
    // applies before style.css loads or if the var is absent.
    jaxImg.style.cssText = "height:48px;width:auto;opacity:var(--jax-icon-opacity, 0.8);";
    jaxImg.alt = "";
    jaxImg.onerror = function() {
      if (jaxMenuTrigger && jaxImg.parentNode) jaxImg.parentNode.removeChild(jaxImg);
      if (jaxMenuTrigger) {
        jaxMenuTrigger.style.font = "600 22px/1 sans-serif";
        jaxMenuTrigger.style.color = "rgba(255,255,255,0.85)";
        jaxMenuTrigger.innerHTML = "&#9776;";
      }
    };
    jaxMenuTrigger.appendChild(jaxImg);
    var tapFired = false;
    function doTriggerTap() {
      if (tapFired) return;
      tapFired = true;
      openJaxMenu();
      setTimeout(function() { tapFired = false; }, 500);
    }
    jaxMenuTrigger.addEventListener("touchstart", function(e) { e.stopPropagation(); }, { capture: true });
    jaxMenuTrigger.addEventListener("touchend", function(e) { e.stopPropagation(); doTriggerTap(); }, { capture: true });
    jaxMenuTrigger.addEventListener("mousedown", function(e) { e.stopPropagation(); }, true);
    jaxMenuTrigger.addEventListener("mouseup", function(e) { e.stopPropagation(); doTriggerTap(); }, true);
    document.body.appendChild(jaxMenuTrigger);
  }

  function syncJaxMenuTrigger() {
    if (onClockView()) {
      ensureJaxMenuTrigger();
      if (jaxMenuTrigger) jaxMenuTrigger.style.display = "flex";
    } else {
      if (jaxMenuTrigger) jaxMenuTrigger.style.display = "none";
    }
  }

  function openJaxMenu() {
    if (jaxMenuOverlay) { closeJaxMenu(); return; }
    var stream = currentStream();
    tracking = false;
    hideHint();

    var REMOVE_SVG =
      '<svg pointer-events="none" width="28" height="28" viewBox="0 0 28 28" fill="none">' +
      '<rect x="1" y="4" width="26" height="20" rx="2" stroke="white" stroke-width="2" fill="rgba(255,255,255,0.08)"/>' +
      '<polyline points="3,20 9,12 15,17 20,11 27,16" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" fill="none"/>' +
      '<line x1="7" y1="8" x2="21" y2="20" stroke="#ff5555" stroke-width="3" stroke-linecap="round"/>' +
      '<line x1="21" y1="8" x2="7" y2="20" stroke="#ff5555" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>';
    var RATE_SVG =
      '<svg pointer-events="none" width="28" height="28" viewBox="0 0 24 24">' +
      '<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" stroke="#ffcc44" stroke-width="1.5" fill="#ffcc44"/>' +
      '</svg>';

    // Transparent click-catcher: outside tap dismisses menu
    var catcher = document.createElement("div");
    catcher.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;z-index:99981;";
    catcher.addEventListener("touchstart", function(e) { e.stopPropagation(); }, { capture: true });
    catcher.addEventListener("touchmove", function(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { capture: true, passive: false });
    var catchFired = false;
    function dismissCatch(e) {
      if (catchFired) return; catchFired = true;
      e.stopPropagation(); closeJaxMenu();
    }
    catcher.addEventListener("touchend", dismissCatch, { capture: true });
    catcher.addEventListener("mouseup", dismissCatch, true);
    document.body.appendChild(catcher);
    jaxMenuOverlay = catcher;

    // Pause toggle is always the FIRST item, immediately right of the jaxicon.
    var pauseDef = paused
      ? { svg: RESUME_SVG, onTap: function() { if (stream) doResume(stream); } }
      : { svg: PAUSE_SVG,  onTap: function() { if (stream) doPause(stream); } };
    var itemDefs = [
      pauseDef,
      {
        svg: REMOVE_SVG,
        onTap: function() {
          if (!stream) return;
          showConfirm(function() {
            var hass = getHass();
            if (!hass) return;
            var dismiss = showStatus("Removing", "#ff5555");
            var delay = typeof CFG.refreshDelayMs === "number" ? CFG.refreshDelayMs : 3000;
            Promise.resolve(
              hass.callService("jax_stream", "remove", { stream: stream })
            ).then(function() {
              setTimeout(function() { reloadStream(stream); setTimeout(dismiss, 800); }, delay);
            }).catch(function(err) { dismiss(); console.error("[jax-stream] remove_confirm failed:", err); });
          }, null);
        }
      },
      {
        svg: RATE_SVG,
        onTap: function() {
          if (!stream) return;
          var hass = getHass();
          if (!hass) return;
          var s = stream;
          var prefetchAge = Date.now() - ratingPrefetchTime;
          var prefetchFresh = ratingPrefetchStream === s && prefetchAge < 60000;
          // rate_menu prefetch removed: coordinator writes rate_current.txt on every advance (D-11).
          // prefetchFresh still controls waitMs below (D-15).
          // If a prefetch fired on advance, rate_current.txt should already be
          // written; wait out only whatever time remains of the 2.2s budget.
          var waitMs = prefetchFresh ? Math.max(0, 2200 - prefetchAge) : 2000;
          window.__jaxRatingWaitMs = { waitMs: waitMs, prefetchFresh: prefetchFresh, prefetchAge: prefetchAge };
          setTimeout(function() {
            fetch("/view_assist/images/jax-stream/" + s + "/rate_current.txt?v=" + Date.now())
              .then(function(r) { return r.ok ? r.text() : "0"; })
              .then(function(ratingStr) {
                var cur = parseInt(ratingStr.trim(), 10);
                if (isNaN(cur) || cur < 0 || cur > 5) cur = 0;
                openRatingMenu(s, cur);
              })
              .catch(function() { openRatingMenu(s, 0); });
          }, waitMs);
        }
      }
    ];

    itemDefs.forEach(function(def, i) {
      var btn = document.createElement("div");
      var targetX = 63 + i * 63;
      btn.style.cssText =
        "position:fixed;top:15px;left:11px;width:55px;height:55px;" +
        "background:rgba(0,0,0,0.55);border-radius:10px;" +
        "display:flex;align-items:center;justify-content:center;" +
        "z-index:99992;cursor:pointer;user-select:none;" +
        "opacity:0;transform:translateX(0);pointer-events:none;" +
        "transition:opacity 0.18s ease,transform 0.22s ease;";
      btn.innerHTML = def.svg;
      var fired = false;
      function doTap(e) {
        if (fired) return; fired = true;
        e.stopPropagation();
        closeJaxMenu();
        def.onTap();
      }
      btn.addEventListener("touchend", doTap, { capture: true });
      btn.addEventListener("mouseup", doTap, true);
      document.body.appendChild(btn);
      jaxMenuItems.push(btn);
      setTimeout(function() {
        btn.getBoundingClientRect();
        btn.style.opacity = "1";
        btn.style.transform = "translateX(" + targetX + "px)";
      }, i * 60);
      // Synthetic mouseup from the opener tap fires within ~100ms. Keep
      // pointer-events:none until that window has safely passed, or the
      // rate item (same initial position as trigger, higher z-index) intercepts
      // the synthetic event and opens the rating overlay instead of the menu.
      setTimeout(function() { btn.style.pointerEvents = "auto"; }, 350);
    });

    jaxMenuAutoTimer = setTimeout(closeJaxMenu, 8000);
  }

  function currentPhotoSrc() {
    var stack = [document.documentElement];
    var guard = 0;
    while (stack.length && guard < 20000) {
      guard++;
      var node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        var probes = [];
        try { probes.push(getComputedStyle(node, "::before").backgroundImage); } catch(e) {}
        try { probes.push(getComputedStyle(node, "::after").backgroundImage); } catch(e) {}
        for (var pi = 0; pi < probes.length; pi++) {
          if (probes[pi] && probes[pi] !== "none" && STREAM_RE.test(probes[pi])) return probes[pi];
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      var kids = node.children;
      if (kids) for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
    return null;
  }

  function checkPhotoChange() {
    var src = currentPhotoSrc();
    if (!src) return;
    if (lastPhotoSrc !== null && src !== lastPhotoSrc) {
      if (histNavSuppress) {
        histNavSuppress = false;
        lastPhotoSrc = src;
        return;
      }
      var wasLive = historyPos < 0;
      if (!wasLive) {
        historyPos = -1;
        window.__jaxHistoryPos = -1;
      } else {
        // The photo leaving the screen had its bytes cached as liveBlobUrl while
        // it was live; push that blob (not the server URL) so back-nav can show
        // the real image after random.jpg has been overwritten.
        var hs = STREAM_RE.exec(lastPhotoSrc);
        if (liveBlobUrl && hs) {
          pushHistory(liveBlobUrl, hs[1]);
          liveBlobUrl = null;             // ownership transferred to history
          window.__jaxLiveBlobUrl = null;
        }
      }
      if (jaxMenuItems.length || confirmOverlay || ratingMenuOverlay) {
        closeJaxMenu();
        if (confirmOverlay && confirmOverlay.parentNode) { confirmOverlay.parentNode.removeChild(confirmOverlay); confirmOverlay = null; }
        if (ratingMenuOverlay && ratingMenuOverlay.parentNode) { ratingMenuOverlay.parentNode.removeChild(ratingMenuOverlay); ratingMenuOverlay = null; }
      }
      if (wasLive) {
        var stream = currentStream(); var hass = getHass();
        if (stream && hass) {
          ratingPrefetchStream = stream; ratingPrefetchTime = Date.now();
          window.__jaxRatingPrefetch = { stream: stream, t: ratingPrefetchTime };
          // rate_menu prefetch removed: coordinator writes rate_current.txt on every advance (D-11).
        }
      }
    }
    lastPhotoSrc = src;
    // Cache the bytes of whatever photo is now live (no-op if already captured).
    // Skipped while browsing history -- there src is a blob: and currentPhotoSrc
    // returns null, so we never reach here.
    captureLive(src);
  }

  function syncAll() { syncTouchAction(); syncJaxMenuTrigger(); syncPauseIndicator(); }

  syncTouchAction();
  syncJaxMenuTrigger();
  // Try to inject style.css at load; retry after 2s if jax-stream background
  // isn't in the DOM yet (button-card renders background asynchronously).
  (function tryLoadStyle() {
    var s = currentStream();
    if (s) { loadStyle(s); readPauseState(s); return; }
    setTimeout(function() { var s2 = currentStream(); if (s2) { loadStyle(s2); readPauseState(s2); } }, 2000);
  })();
  window.addEventListener("location-changed", syncAll);
  window.addEventListener("popstate", syncAll);
  window.addEventListener("hashchange", syncAll);
  var syncInterval = setInterval(syncAll, 1500);
  var photoWatchInterval = setInterval(checkPhotoChange, 300);

  window.__jaxPausePhotoWatch = function() { clearInterval(photoWatchInterval); photoWatchInterval = null; };
  window.__jaxResumePhotoWatch = function() { if (!photoWatchInterval) photoWatchInterval = setInterval(checkPhotoChange, 300); };

  window.addEventListener("scroll", onScroll, { passive: true });

  window.addEventListener("touchstart", onStart, { passive: true, capture: true });
  window.addEventListener("touchmove", onMove, { passive: false, capture: true });
  window.addEventListener("touchend", onEnd, { capture: true });
  window.addEventListener("touchcancel", onCancel, { capture: true });

  // Mouse fallback for desktop / emulator testing.
  window.addEventListener("mousedown", onStart, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onEnd, true);

  // Revoke every cached blob: URL (history entries + the pending live capture)
  // so back-nav navigation does not leak object URLs across resets/teardown.
  function revokeAllBlobs() {
    for (var i = 0; i < photoHistory.length; i++) {
      if (photoHistory[i] && photoHistory[i].blobUrl) URL.revokeObjectURL(photoHistory[i].blobUrl);
    }
    if (liveBlobUrl) URL.revokeObjectURL(liveBlobUrl);
    liveBlobUrl = null; liveBlobSrc = null; window.__jaxLiveBlobUrl = null;
  }

  window.__jaxHistoryPos = -1;
  window.__jaxHistory = photoHistory;
  window.__jaxClearHistory = function() {
    revokeAllBlobs();
    photoHistory.length = 0; historyPos = -1; histNavSuppress = false;
    window.__jaxHistoryPos = -1;
  };
  // Test hook: clear the swipe cooldown so scripted back-to-back gestures are not
  // swallowed by the 1s production debounce. Mirrors __jaxPausePhotoWatch -- test
  // instrumentation only, never invoked by production code paths.
  window.__jaxResetSwipeCooldown = function() { lastFire = 0; };
  // Test hook: clear the touch-arm debounce so a scripted tap reliably fires the
  // 'touch' shell action. Test instrumentation only, never used by production.
  window.__jaxResetTouchArm = function() { lastTouchArm = 0; };
  // Test hook: reset LOCAL pause state to not-paused (server files are cleared
  // separately via the 'resume' shell action). Test instrumentation only.
  window.__jaxResetPauseState = function() { paused = false; window.__jaxPaused = false; lastTouchArm = 0; syncPauseIndicator(); };

  window.__jaxStreamSwipeDestroy = function () {
    clearInterval(syncInterval);
    window.removeEventListener("location-changed", syncAll);
    window.removeEventListener("popstate", syncAll);
    window.removeEventListener("hashchange", syncAll);
    window.removeEventListener("scroll", onScroll, { passive: true });
    window.removeEventListener("touchstart", onStart, { capture: true });
    window.removeEventListener("touchmove", onMove, { capture: true });
    window.removeEventListener("touchend", onEnd, { capture: true });
    window.removeEventListener("touchcancel", onCancel, { capture: true });
    window.removeEventListener("mousedown", onStart, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onEnd, true);
    clearInterval(photoWatchInterval);
    lastPhotoSrc = null;
    if (confirmOverlay && confirmOverlay.parentNode) { confirmOverlay.parentNode.removeChild(confirmOverlay); confirmOverlay = null; }
    if (ratingMenuOverlay && ratingMenuOverlay.parentNode) { ratingMenuOverlay.parentNode.removeChild(ratingMenuOverlay); ratingMenuOverlay = null; }
    closeJaxMenu();
    if (jaxMenuTrigger && jaxMenuTrigger.parentNode) { jaxMenuTrigger.parentNode.removeChild(jaxMenuTrigger); jaxMenuTrigger = null; }
    if (pauseIndicator && pauseIndicator.parentNode) { pauseIndicator.parentNode.removeChild(pauseIndicator); pauseIndicator = null; }
    paused = false; lastTouchArm = 0;
    if (window.__jaxActiveToast) { try { window.__jaxActiveToast(); } catch (e) {} window.__jaxActiveToast = null; }
    revokeAllBlobs();
    photoHistory = []; historyPos = -1; histNavSuppress = false; bgRoot = null;
    delete window.__jaxHistoryPos; delete window.__jaxHistory;
    delete window.__jaxLastBack;   delete window.__jaxClearHistory;
    delete window.__jaxLiveBlobUrl;
    delete window.__jaxResetSwipeCooldown;
    delete window.__jaxResetTouchArm;
    delete window.__jaxResetPauseState;
    delete window.__jaxLastSwipe;
    delete window.__jaxLastRating;
    delete window.__jaxLastReload;
    delete window.__jaxLastMenu;
    delete window.__jaxPausePhotoWatch;
    delete window.__jaxResumePhotoWatch;
    delete window.__jaxPaused;
    delete window.__jaxLastPauseCall;
    delete window.__jaxStreamSwipeLoaded;
    delete window.__jaxStreamSwipeDestroy;
  };

  // eslint-disable-next-line no-console
  console.info("[jax-stream-swipe] loaded");
})();
