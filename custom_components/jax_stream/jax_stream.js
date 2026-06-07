/*
 * jax_stream.js -- Jax Stream browser module (swipe, menus, overlays)
 *
 * Loaded once via Home Assistant's frontend.extra_module_url (see README).
 * Horizontal swipe (carousel convention, photo follows the finger): left =
 * advance to next photo (slides in from the right); right = go to previous photo
 *   (slides in from the left; in-memory history stack, up to 10 entries).
 *   Remove-from-album is menu-only (jaxmenu -> remove).
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
      refreshDelayMs: 100,  // ms to wait after callService before reloading the image (prefetched frame is already on disk)
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
  var displayedAssetId = null; // Immich asset_id parsed from the live JPEG bytes
  var bgRoot       = null;     // cached shadow root hosting ha-card (showBg target)
  var nullSrcStreak = 0;      // consecutive checkPhotoChange ticks returning null src
  var pendingSlideDir = 0;    // swipe-set slide direction handed from fireSwipe to reloadStream
  var _serverHistoryLoaded = false;  // Phase 4: server past-window pre-load completed

  // Pause / suppress-auto-advance state. The server (jax_stream_action.sh) is
  // the source of truth via pause_manual.txt / pause_touch.txt; these mirror it
  // for the UI. See DEVEL / TODO "Suppress auto-advance after recent touch".
  var paused        = false;   // manual pause (mirrors pause_manual.txt)
  var lastTouchArm  = 0;       // ms of last 'touch' shell call (debounce)
  var pauseIndicator = null;   // persistent quick-unpause icon (manual pause only)
  var lastPauseAt   = 0;       // ms of the last doPause (indicator mouseup guard)
  var TOUCH_ARM_DEBOUNCE_MS = 30000;  // don't re-arm the 90s window more than this often
  // Decaying countdown badge for the silent 90s touch hold (TODO touch-pause-indicator).
  // Distinct from the manual pauseIndicator: shows ONLY while a touch window is
  // armed and NOT manually paused; the radial ring sweeps over the remaining time.
  var touchIndicator   = null; // the badge element (z 99988)
  var touchDeadline    = 0;    // ms epoch when the current touch window ends (0 = none)
  var touchDismissed   = null; // photo src the badge was dismissed on (sticky per photo)
  var touchRingTimer   = null; // interval driving the ring + auto-hide on expiry
  var lastTouchDismissAt = 0;  // ms of last dismiss (ignore the compat-mouseup re-arm)
  var TOUCH_WINDOW_MS  = 90000;// server TOUCH_WINDOW_SECONDS (const.py) mirrored for the ring
  var TOUCH_RING_CIRC  = 282.7;// 2*pi*r, r=45 in the viewBox-100 ring
  // Two bars = pause action; triangle = resume action (also the indicator glyph).
  var PAUSE_SVG =
    '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 24 24">' +
    '<rect x="6" y="5" width="4" height="14" rx="1" fill="#fff"/>' +
    '<rect x="14" y="5" width="4" height="14" rx="1" fill="#fff"/></svg>';
  var RESUME_SVG =
    '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 24 24">' +
    '<polygon points="7,5 19,12 7,19" fill="#fff"/></svg>';
  // Radial ring overlay for the touch-hold badge. The faint track is full; the
  // bright .jax-ring sweeps away as the window decays (offset grows). rotate(-90)
  // starts the sweep at 12 o'clock. Encodes time with the RING, not opacity, so
  // the glyph stays readable over bright photos.
  var TOUCH_RING_SVG =
    '<svg pointer-events="none" viewBox="0 0 100 100" ' +
    'style="position:absolute;top:0;left:0;width:100%;height:100%;">' +
    '<circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="8"/>' +
    '<circle class="jax-ring" cx="50" cy="50" r="45" fill="none" stroke="#fff" ' +
    'stroke-width="8" stroke-linecap="round" stroke-dasharray="282.7" ' +
    'stroke-dashoffset="0" transform="rotate(-90 50 50)"/></svg>';

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

  // True once View Assist's screen_mode=hide_header_sidebar has taken the page
  // full-screen (kiosk). During a device reset the Lovelace header is briefly
  // visible BEFORE VA/VACA apply kiosk; gating all jax UI on this keeps the
  // jaxicon, pause indicator, and swipes from appearing over the half-loaded,
  // non-kiosk page. Detect by POSITIVE evidence of a visible header -- the
  // hui-root .header with nonzero height -- and treat that as "not yet kiosk".
  // If no header is found (HA internals changed) fall back to ready=true so the
  // feature never silently disappears.
  function inKiosk() {
    try {
      var stack = [document.documentElement];
      var guard = 0;
      while (stack.length && guard < 20000) {
        guard++;
        var node = stack.pop();
        if (!node) continue;
        if (node.nodeType === 1) {
          if (node.tagName === "HUI-ROOT" && node.shadowRoot) {
            var h = node.shadowRoot.querySelector(".header");
            if (h) return h.getBoundingClientRect().height === 0;
          }
          if (node.shadowRoot) stack.push(node.shadowRoot);
        }
        var kids = node.children;
        if (kids) for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
      }
    } catch (e) {}
    return true;
  }

  // All jax UI (jaxicon, pause indicator, swipes) gates on this: on the clock
  // view AND kiosk applied. See inKiosk() for the reset-window rationale.
  function jaxReady() { return onClockView() && inKiosk(); }

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

  function openRatingMenu(stream, currentRating, assetId) {
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
            if (!alreadyGone) fireRating(stream, stars, assetId);
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
      fireRating(stream, 0, assetId);
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

  function fireRating(stream, stars, assetId) {
    var hass = getHass();
    if (!hass) return;
    var msg = stars === 0 ? "Unrated" : ("Rated " + stars + (stars === 1 ? " star" : " stars"));
    var color = stars === 0 ? "#aaaaaa" : "#ffcc44";
    showStatus(msg, color);
    window.__jaxLastRating = { stars: stars, stream: stream, asset_id: assetId || null, t: Date.now() };
    var svcArgs = { stream: stream, rating: stars };
    if (assetId) svcArgs.asset_id = assetId;
    Promise.resolve(
      hass.callService("jax_stream", "set_rating", svcArgs)
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
    // Self-heal: showBg injects a blob URL with !important and no cleanup timer.
    // That blob blocks the STREAM_RE walk below. Clear it (works even when bgRoot
    // is null -- clearStaleRefreshStyle does a full shadow-DOM sweep as fallback).
    clearStaleRefreshStyle();
    if (historyPos >= 0) { historyPos = -1; window.__jaxHistoryPos = -1; }
    // Consume any swipe-requested slide direction (set by fireSwipe). Capture the
    // outgoing photo now, before the walk below injects the new bg. Reset the
    // module flag immediately so a non-swipe reloadStream (menu paths) never slides.
    var slideDir = pendingSlideDir; pendingSlideDir = 0;
    var slideFrom = null;
    if (slideDir) {
      var fc = findCardBg();
      if (fc) {
        // random.jpg is overwrite-in-place: jax_stream.next already replaced the
        // file, so the card's URL now resolves to the INCOMING bytes -- re-fetching
        // it would show the new photo on both layers (no visible slide). Use the
        // cached blob of the photo that was live (its true outgoing bytes) instead.
        slideFrom = {
          image: liveBlobUrl ? 'url("' + liveBlobUrl + '")' : fc.image,
          size: fc.size, position: fc.position
        };
      }
    }
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
              if (slideDir && slideFrom) { slidePhoto(fresh, slideDir, slideFrom); slideDir = 0; }
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

  // Remove any style[data-jax-refresh] that contains a blob URL. Those are
  // injected by showBg() for history nav and have no cleanup timer; they block
  // the STREAM_RE walk in reloadStream and currentPhotoSrc. Checks bgRoot first
  // (fast path), then falls back to a full shadow-DOM sweep when bgRoot is null
  // (e.g. fresh module load) -- also caches the found root into bgRoot.
  function clearStaleRefreshStyle() {
    var BLOB_RE = /url\(["']?blob:/;
    if (bgRoot && bgRoot.querySelector) {
      var st = bgRoot.querySelector("style[data-jax-refresh]");
      if (st && BLOB_RE.test(st.textContent) && st.parentNode) {
        st.parentNode.removeChild(st); return true;
      }
    }
    var stack = [document];
    var guard = 0;
    while (stack.length && guard < 5000) {
      guard++;
      var n = stack.pop();
      if (!n) continue;
      var st2 = n.querySelector && n.querySelector("style[data-jax-refresh]");
      if (st2 && BLOB_RE.test(st2.textContent) && st2.parentNode) {
        if (n !== document) bgRoot = n;
        st2.parentNode.removeChild(st2); return true;
      }
      var all = n.querySelectorAll ? n.querySelectorAll("*") : [];
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) stack.push(all[j].shadowRoot);
      }
    }
    return false;
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

  // First JPEG COM (comment) segment text, or null. Walks segments from SOI;
  // stops at SOS (pixel data) so it never reads more than the header.
  function readJpegComment(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    var i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var m = bytes[i + 1];
      // Standalone markers (no length): SOI/EOI, RST0-RST7, TEM
      if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
      if (m === 0xDA) break;                                     // SOS: pixel data
      var len = (bytes[i + 2] << 8) | bytes[i + 3];             // big-endian, includes the 2 len bytes
      if (m === 0xFE) {                                          // COM marker
        var s = '';
        for (var k = i + 4; k < i + 2 + len; k++) s += String.fromCharCode(bytes[k]);
        return s;
      }
      i += 2 + len;
    }
    return null;
  }

  // Parse JPEG COM content into {prev, self, next} neighbor Immich UUIDs.
  // Phase 2 format: "prev|self|next" (pipe-delimited; empty string -> null).
  // Phase 1 compat: bare UUID with no pipe -> {prev: null, self: uuid, next: null}.
  function parseJpegComment(com) {
    if (!com) return { prev: null, self: null, next: null };
    if (com.indexOf('|') === -1) {
      return { prev: null, self: com || null, next: null };
    }
    var parts = com.split('|');
    return {
      prev: parts[0] || null,
      self: parts[1] || null,
      next: parts[2] || null
    };
  }

  // Capture the bytes of the currently-live photo into a blob: URL so back-nav
  // can show it later, after the server has overwritten random.jpg. Idempotent
  // per source string; only the most recent capture is kept.
  // Parses the embedded Immich asset_id from the JPEG COM marker (Phase 2 pipe
  // format: prev|self|next) and stores identity + neighbor UUIDs -- they travel
  // WITH the pixels, never drift from the display state.
  function captureLive(src) {
    if (!src || src === liveBlobSrc) return;
    var m = src.match(/url\(["']?([^"')]+)/);
    var fetchUrl = m ? m[1] : src;   // keep ?v= -- fetches the bytes live RIGHT NOW
    liveBlobSrc = src;
    fetch(fetchUrl, { credentials: "include" })
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (ab) {
        if (!ab) return;
        var bytes = new Uint8Array(ab);
        var neighbors = parseJpegComment(readJpegComment(bytes));
        var b = new Blob([bytes], { type: "image/jpeg" });
        var u = URL.createObjectURL(b);
        if (liveBlobSrc === src) {
          // Replace any earlier live blob that was never pushed to history.
          if (liveBlobUrl) URL.revokeObjectURL(liveBlobUrl);
          liveBlobUrl = u;
          displayedAssetId = neighbors.self;
          window.__jaxLiveBlobUrl = u;
          window.__jaxDisplayedAssetId = neighbors.self;
          window.__jaxNeighbors = neighbors;
        } else {
          URL.revokeObjectURL(u);  // a newer photo superseded this capture
        }
      })
      .catch(function () {});
  }

  // Paint a cached blob: URL as the background. blobUrl is immutable so no
  // cache-buster is appended (a ?v= query would break the blob URL).
  function showBg(blobUrl, stream, slideDir) {
    if (!blobUrl) return;
    var root = findBgRoot(stream);
    if (!root) return;
    var fromCard = slideDir ? findCardBg() : null;  // outgoing, before the swap
    var prev = root.querySelector && root.querySelector("style[data-jax-refresh]");
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var st = document.createElement("style");
    st.setAttribute("data-jax-refresh", "1");
    st.textContent =
      'ha-card::before, ha-card::after { background-image: url("' + blobUrl + '") !important; }';
    root.appendChild(st);
    window.__jaxLastReload = { stream: stream, url: blobUrl, t: Date.now() };
    if (slideDir && fromCard) slidePhoto(blobUrl, slideDir, fromCard);
  }

  // --- Directional slide transition ----------------------------------------
  // Animate a swipe-driven photo change as a horizontal slide that follows the
  // finger. dirSign: +1 = advancing (next) -> new photo enters from the RIGHT,
  // old exits LEFT (finger swiped left). -1 = going back (previous) -> new
  // enters from the LEFT, old exits RIGHT (finger swiped right). The photo
  // lives in the ha-card ::after/::before background (size:contain), which
  // cannot be transformed directly -- so we float a fixed full-viewport overlay
  // holding the outgoing + incoming images (replicating the card's computed
  // background metrics), slide it, then let the already-painted real bg show
  // through when the overlay is torn down. Organic auto-advances never call
  // this (slideDir defaults to 0), so only swipes animate.
  var slideOverlay = null;   // active slide overlay element (one at a time)
  var slideTimer   = null;   // teardown fallback timer

  function clearSlide() {
    if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
    if (slideOverlay && slideOverlay.parentNode) {
      slideOverlay.parentNode.removeChild(slideOverlay);
    }
    slideOverlay = null;
  }

  // Find the ha-card whose ::after/::before paints the photo and return its
  // computed background image + sizing so the slide layers match exactly.
  function findCardBg() {
    var stack = [document.documentElement];
    var guard = 0;
    while (stack.length && guard < 20000) {
      guard++;
      var n = stack.pop();
      if (!n) continue;
      if (n.nodeType === 1) {
        var pseudo = null, img = "";
        try {
          var a = getComputedStyle(n, "::after").backgroundImage;
          if (a && a !== "none" && (STREAM_RE.test(a) || a.indexOf("blob:") !== -1)) {
            pseudo = "::after"; img = a;
          } else {
            var b = getComputedStyle(n, "::before").backgroundImage;
            if (b && b !== "none" && (STREAM_RE.test(b) || b.indexOf("blob:") !== -1)) {
              pseudo = "::before"; img = b;
            }
          }
        } catch (e) {}
        if (pseudo) {
          var cs = getComputedStyle(n, pseudo);
          return { image: img, size: cs.backgroundSize, position: cs.backgroundPosition };
        }
        if (n.shadowRoot) stack.push(n.shadowRoot);
      }
      var k = n.children;
      if (k) for (var j = 0; j < k.length; j++) stack.push(k[j]);
    }
    return null;
  }

  function slidePhoto(newUrl, dirSign, fromCard) {
    try {
      if (!newUrl || !dirSign) return false;
      // fromCard is the OUTGOING photo captured by the caller BEFORE it swapped
      // the real bg (the injected !important style would otherwise make us read
      // the new image as outgoing). Fall back to a live read only as a guard.
      var card = fromCard || findCardBg();
      if (!card) return false;
      clearSlide();
      var host = document.body || document.documentElement;
      var ov = document.createElement("div");
      ov.setAttribute("data-jax-slide", "1");
      ov.style.cssText =
        "position:fixed;inset:0;z-index:9000;overflow:hidden;pointer-events:none;";
      var common =
        "position:absolute;top:0;left:0;width:100%;height:100%;" +
        "background-repeat:no-repeat;background-size:" + card.size + ";" +
        "background-position:" + card.position + ";will-change:transform;";
      var outg = document.createElement("div");
      outg.style.cssText = common +
        "background-image:" + card.image + ";transform:translateX(0);";
      var inc = document.createElement("div");
      inc.style.cssText = common +
        'background-image:url("' + newUrl + '");transform:translateX(' +
        (dirSign > 0 ? "100%" : "-100%") + ");";
      ov.appendChild(outg);
      ov.appendChild(inc);
      host.appendChild(ov);
      slideOverlay = ov;
      // Record both layer images (truncated) for tests: the outgoing must be the
      // cached blob on advance (proves the random.jpg overwrite fix) and the two
      // layers must differ (proves a real two-photo slide, not the same image).
      window.__jaxLastSlide = {
        dir: dirSign,
        out: card.image.slice(0, 48),
        inc: ('url("' + newUrl + '")').slice(0, 48),
        t: Date.now()
      };
      var dur = 350;
      var ease = "cubic-bezier(.22,.61,.36,1)";
      var started = false;
      function startAnim() {
        if (started || ov !== slideOverlay) return;
        started = true;
        // Force layout so the initial transform is committed before transition.
        void ov.offsetWidth;
        outg.style.transition = "transform " + dur + "ms " + ease;
        inc.style.transition  = "transform " + dur + "ms " + ease;
        outg.style.transform = "translateX(" + (dirSign > 0 ? "-100%" : "100%") + ")";
        inc.style.transform  = "translateX(0)";
        slideTimer = setTimeout(clearSlide, dur + 250);
      }
      // Warm the incoming image so it paints in sync with the slide; fall back
      // to animating anyway if the load stalls (LAN fetch is usually instant).
      var pre = new Image();
      pre.onload = startAnim;
      pre.onerror = startAnim;
      pre.src = newUrl;
      setTimeout(startAnim, 400);
      return true;
    } catch (e) {
      clearSlide();
      return false;
    }
  }

  // Append to history, evicting + revoking the oldest blob past the cap of 10.
  function pushHistory(blobUrl, stream) {
    photoHistory.push({ blobUrl: blobUrl, stream: stream, assetId: displayedAssetId });
    if (photoHistory.length > 10) {
      var ev = photoHistory.shift();
      if (ev && ev.blobUrl) URL.revokeObjectURL(ev.blobUrl);
    }
  }

  // Phase 4: pre-load server past-window into photoHistory on init so back-nav
  // works after a page reload (in-memory blob history is lost on reload but the
  // coordinator retains M past frames in its ring buffer). Fire-and-forget --
  // any error silently degrades to "no history" so back-nav still works from
  // newly-captured photos. Only runs once per module injection.
  function loadServerPastHistory(stream) {
    if (_serverHistoryLoaded) return;
    _serverHistoryLoaded = true;
    var stateUrl = '/jax_stream_data/' + stream + '/state.json?v=' + Date.now();
    fetch(stateUrl, { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(state) {
        if (!state || !state.past_count || state.past_count < 1) {
          window.__jaxServerHistoryLoaded = true;
          return;
        }
        var pastCount = Math.min(parseInt(state.past_count, 10) || 0, 5);
        var head = parseInt(state.head, 10) || 0;
        var slotKeys = Object.keys(state.slots || {});
        var ringSize = slotKeys.length;
        if (!ringSize || pastCount < 1) { window.__jaxServerHistoryLoaded = true; return; }
        // Fetch past slots oldest-first so pushHistory appends in chronological order.
        // navBack steps from the newest entry (array end) backwards -- correct ordering.
        var ks = [];
        for (var k = pastCount; k >= 1; k--) ks.push(k);
        (function fetchNext() {
          if (!ks.length) { window.__jaxServerHistoryLoaded = true; return; }
          var k = ks.shift();
          var idx = (head - k + ringSize) % ringSize;
          var padded = idx < 10 ? '0' + idx : '' + idx;
          var url = '/jax_stream_data/' + stream + '/window/slot_' + padded + '.jpg?v=' + Date.now();
          fetch(url, { credentials: 'include' })
            .then(function(r) { return r.ok ? r.arrayBuffer() : null; })
            .then(function(ab) {
              if (ab && ab.byteLength > 4) {
                var bytes = new Uint8Array(ab);
                if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
                  var neighbors = parseJpegComment(readJpegComment(bytes));
                  var assetId = (neighbors && neighbors.self) || null;
                  var b = new Blob([bytes], { type: 'image/jpeg' });
                  var blobUrl = URL.createObjectURL(b);
                  photoHistory.push({ blobUrl: blobUrl, stream: stream, assetId: assetId });
                  if (photoHistory.length > 10) {
                    var ev = photoHistory.shift();
                    if (ev && ev.blobUrl) URL.revokeObjectURL(ev.blobUrl);
                  }
                }
              }
              fetchNext();
            })
            .catch(function() { fetchNext(); });
        }());
      })
      .catch(function() { window.__jaxServerHistoryLoaded = true; });
  }

  function navTo(historyEntryPos, stream) {
    historyPos = historyEntryPos; histNavSuppress = true;
    window.__jaxHistoryPos = historyPos;
    window.__jaxLastBack = { pos: historyPos, url: photoHistory[historyPos].blobUrl, t: Date.now() };
    showStatus("Back", "#5599ff");
    // Going to a previous photo: it enters from the LEFT (dirSign -1).
    showBg(photoHistory[historyPos].blobUrl, stream, -1);
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
    // Advancing to a next photo: it enters from the RIGHT (dirSign +1).
    if (historyPos < 0) { fireSwipe("right", stream, 1); return; }
    var nextPos = historyPos + 1;
    if (nextPos >= photoHistory.length) {
      historyPos = -1; histNavSuppress = true; window.__jaxHistoryPos = -1;
      fireSwipe("right", stream, 1); return;
    }
    historyPos = nextPos; histNavSuppress = true; window.__jaxHistoryPos = historyPos;
    showBg(photoHistory[historyPos].blobUrl, stream, 1);
  }

  function fireSwipe(direction, stream, slideDir) {
    var hass = getHass();
    if (!hass) return;
    var dismiss = showStatus(
      direction === "left" ? "Removing" : "Next",
      direction === "left" ? "#ff5555" : "#55dd55"
    );
    var delay = typeof CFG.refreshDelayMs === "number" ? CFG.refreshDelayMs : 3000;
    // __jaxLastSwipe is recorded by onEnd (the gesture owner) so it survives every
    // swipe path, including history nav. Don't clobber it here.
    var svcDomain = "jax_stream";
    var svcName   = direction === "right" ? "next" : "remove";
    var svcData   = { stream: stream };
    Promise.resolve(
      hass.callService(svcDomain, svcName, svcData)
    ).then(function () {
      setTimeout(function () {
        // Hand the slide direction to reloadStream so the fresh image slides in.
        pendingSlideDir = slideDir || 0;
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
    if (!jaxReady()) { tracking = false; return; }
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
    // Standard carousel convention so the photo follows the finger: swipe LEFT
    // advances to the NEXT photo (new enters from the right), swipe RIGHT goes
    // to the PREVIOUS photo (old returns from the left). This is the reverse of
    // the pre-slide mapping; the directional slide makes the old mapping feel
    // backwards. The slide itself is wired in navForward/navBack.
    var dir = dx < 0 ? "left" : "right";
    var action = dir === "left" ? "next" : "prev";
    window.__jaxLastSwipe = { finger: dir, action: action, stream: stream, t: now };
    if (action === "next") {
      navForward(stream);
    } else {
      navBack(stream);
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
    // Ignore the compatibility-mouseup the WebView synthesizes right after a
    // dismiss tap -- it lands on the photo behind the hidden badge and would
    // otherwise silently re-arm the window we just cleared.
    if (now - lastTouchDismissAt < 600) return;
    if (now - lastTouchArm < TOUCH_ARM_DEBOUNCE_MS) return;
    lastTouchArm = now;
    // Mirror the server: a fired touch sets the deadline now+90s. A debounced-out
    // touch returns above WITHOUT moving touchDeadline, so the ring keeps showing
    // the real remaining time (never falsely refilled by a no-op touch).
    touchDeadline = now + TOUCH_WINDOW_MS;
    firePauseAction("touch", stream);
    surfaceTouchIndicator();
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
    var ctrls = [jaxMenuTrigger, pauseIndicator, touchIndicator, jaxMenuOverlay, confirmOverlay, ratingMenuOverlay];
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
      "position:fixed;top:15px;left:11px;width:7vw;height:7vw;" +
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
    var show = paused && jaxReady();
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

  // --- Touch-hold decaying indicator ---------------------------------------
  // Built once, lazily; shares the manual indicator's spot (the two states are
  // mutually exclusive -- touch shows only when NOT manually paused). z 99988
  // sits below the manual indicator (99991) and flyout (99992).
  function ensureTouchIndicator() {
    if (touchIndicator) return;
    document.querySelectorAll("body > div").forEach(function (el) {
      if (el.style.zIndex === "99988" && el.parentNode) el.parentNode.removeChild(el);
    });
    touchIndicator = document.createElement("div");
    touchIndicator.style.cssText =
      "position:fixed;top:15px;left:11px;width:7vw;height:7vw;" +
      "transform:translateX(63px);background:rgba(0,0,0,0.45);border-radius:10px;" +
      "display:none;align-items:center;justify-content:center;" +
      "z-index:99988;cursor:pointer;user-select:none;";
    touchIndicator.innerHTML = TOUCH_RING_SVG + PAUSE_SVG;  // ring + pause-bars glyph
    function onTouchIndicatorActivate(e) { e.stopPropagation(); dismissTouchIndicator(true); }
    touchIndicator.addEventListener("touchstart", function (e) { e.stopPropagation(); }, { capture: true });
    touchIndicator.addEventListener("touchend", onTouchIndicatorActivate, { capture: true });
    touchIndicator.addEventListener("mousedown", function (e) { e.stopPropagation(); }, true);
    touchIndicator.addEventListener("mouseup", onTouchIndicatorActivate, true);
    document.body.appendChild(touchIndicator);
  }

  // Surface on a real arm, unless dismissed for this same photo (sticky per photo)
  // or manually paused (that indicator dominates).
  function surfaceTouchIndicator() {
    if (paused || !jaxReady()) return;
    if (lastPhotoSrc !== null && touchDismissed === lastPhotoSrc) return;
    ensureTouchIndicator();
    touchIndicator.style.display = "flex";
    startTouchRing();
  }

  function startTouchRing() {
    if (touchRingTimer) clearInterval(touchRingTimer);
    updateTouchRing();
    touchRingTimer = setInterval(updateTouchRing, 250);
  }

  function updateTouchRing() {
    if (!touchIndicator) return;
    var remaining = touchDeadline - Date.now();
    if (remaining <= 0 || paused) { hideTouchIndicator(); return; }
    var frac = remaining / TOUCH_WINDOW_MS;
    if (frac > 1) frac = 1;
    var ring = touchIndicator.querySelector(".jax-ring");
    if (ring) ring.setAttribute("stroke-dashoffset", (TOUCH_RING_CIRC * (1 - frac)).toFixed(1));
  }

  function hideTouchIndicator() {
    if (touchRingTimer) { clearInterval(touchRingTimer); touchRingTimer = null; }
    if (touchIndicator) touchIndicator.style.display = "none";
  }

  // Tap = resume now: hide, mark dismissed for this photo, and clear the server
  // touch window so the slideshow resumes its normal advance. resume=false is
  // the non-interactive teardown (manual pause / photo change took over).
  function dismissTouchIndicator(resume) {
    touchDismissed = lastPhotoSrc;
    lastTouchDismissAt = Date.now();
    touchDeadline = 0;
    hideTouchIndicator();
    if (resume) {
      var stream = currentStream();
      if (stream && !paused) firePauseAction("resume", stream);  // clears _touch_deadline (D-08)
    }
  }

  // Restore the badge after a VA bounce / view reload (browser state lost; the
  // file persists). pause_touch.txt holds an integer epoch deadline (0/absent =
  // not armed). Mirrors readPauseState.
  function readTouchState(stream) {
    if (!stream) return;
    fetch('/view_assist/images/jax-stream/' + stream + '/pause_touch.txt?v=' + Date.now())
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (t === null) return;
        var dl = parseInt(t, 10);
        if (!dl) return;
        touchDeadline = dl * 1000;
        if (touchDeadline - Date.now() > 0) surfaceTouchIndicator();
      })
      .catch(function () {});
  }

  // Corner menu trigger -- shown only on the clock view. Provides jax-stream
  // actions (pause, remove, rate, rotate) without depending on VA's hamburger menu API,
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
      "position:fixed;top:15px;left:11px;width:7vw;height:7vw;" +
      "background:rgba(0,0,0,0);" +
      "display:flex;align-items:center;justify-content:center;" +
      "z-index:99990;cursor:pointer;user-select:none;";
    var jaxImg = document.createElement("img");
    jaxImg.src = "/jax_stream_frontend/jaxicon.svg";
    // Opacity is blueprint-driven via --jax-icon-opacity (emitted into
    // style.css by jax_stream_action.sh write_conf). Softens the stark white
    // jaxicon toward the lighter weight of the VA menu icons. Fallback 0.8
    // applies before style.css loads or if the var is absent.
    jaxImg.style.cssText = "height:87%;width:auto;opacity:var(--jax-icon-opacity, 0.8);";
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
    if (jaxReady()) {
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
      '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 28 28" fill="none">' +
      '<rect x="1" y="4" width="26" height="20" rx="2" stroke="white" stroke-width="2" fill="rgba(255,255,255,0.08)"/>' +
      '<polyline points="3,20 9,12 15,17 20,11 27,16" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" fill="none"/>' +
      '<line x1="7" y1="8" x2="21" y2="20" stroke="#ff5555" stroke-width="3" stroke-linecap="round"/>' +
      '<line x1="21" y1="8" x2="7" y2="20" stroke="#ff5555" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>';
    var RATE_SVG =
      '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 24 24">' +
      '<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" stroke="#ffcc44" stroke-width="1.5" fill="#ffcc44"/>' +
      '</svg>';
    // Circular arrows for the rotate buttons (90 = clockwise, 270 = CCW deltas).
    var ROTCW_SVG =
      '<svg pointer-events="none" width="74%" height="74%" viewBox="0 0 24 24" fill="none">' +
      '<path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' +
      '<polyline points="20,3 20,7 16,7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    var ROTCCW_SVG =
      '<svg pointer-events="none" width="74%" height="74%" viewBox="0 0 24 24" fill="none">' +
      '<path d="M4 12a8 8 0 1 0 2.34-5.66" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' +
      '<polyline points="4,3 4,7 8,7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';

    // Rotate handler factory: delta is CW degrees (90 = CW, 270 = CCW). Captures
    // identity at tap time (same drift-prevention pattern as Remove/Rate) and
    // reloads after the service resolves -- jax_stream.rotate blocks until Immich
    // regenerated the corrected preview and the coordinator rewrote random.jpg.
    function makeRotate(delta) {
      return function() {
        if (!stream) return;
        var hass = getHass();
        if (!hass) return;
        var s = stream;
        var rotAssetId = (historyPos >= 0 && photoHistory[historyPos])
          ? photoHistory[historyPos].assetId
          : displayedAssetId;
        var dismiss = showStatus("Rotating", "#44aaff");
        var svcArgs = { stream: s, angle: delta };
        if (rotAssetId) svcArgs.asset_id = rotAssetId;
        window.__jaxLastRotate = { stream: s, asset_id: rotAssetId, angle: delta, t: Date.now() };
        Promise.resolve(
          hass.callService("jax_stream", "rotate", svcArgs)
        ).then(function() {
          reloadStream(s); setTimeout(dismiss, 800);
        }).catch(function(err) { dismiss(); console.error("[jax-stream] rotate failed:", err); });
      };
    }

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
          var s = stream;
          // Identity is embedded in the displayed JPEG bytes and captured at
          // display time -- no current.txt fetch needed, no drift possible.
          var capturedAssetId = (historyPos >= 0 && photoHistory[historyPos])
            ? photoHistory[historyPos].assetId
            : displayedAssetId;
          showConfirm(function() {
            var hass = getHass();
            if (!hass) return;
            var dismiss = showStatus("Removing", "#ff5555");
            var delay = typeof CFG.refreshDelayMs === "number" ? CFG.refreshDelayMs : 3000;
            var svcArgs = { stream: s };
            if (capturedAssetId) svcArgs.asset_id = capturedAssetId;
            window.__jaxLastRemove = { stream: s, asset_id: capturedAssetId, t: Date.now() };
            Promise.resolve(
              hass.callService("jax_stream", "remove", svcArgs)
            ).then(function() {
              setTimeout(function() { reloadStream(s); setTimeout(dismiss, 800); }, delay);
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
          // Capture identity at tap time -- same drift-prevention pattern as Remove.
          var ratingAssetId = (historyPos >= 0 && photoHistory[historyPos])
            ? photoHistory[historyPos].assetId
            : displayedAssetId;
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
                openRatingMenu(s, cur, ratingAssetId);
              })
              .catch(function() { openRatingMenu(s, 0, ratingAssetId); });
          }, waitMs);
        }
      },
      { svg: ROTCCW_SVG, onTap: makeRotate(270) },
      { svg: ROTCW_SVG,  onTap: makeRotate(90)  }
    ];

    itemDefs.forEach(function(def, i) {
      var btn = document.createElement("div");
      var targetX = 63 + i * 63;
      btn.style.cssText =
        "position:fixed;top:15px;left:11px;width:7vw;height:7vw;" +
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
    if (!src) {
      // After 30 s of null src (blob injection blocking STREAM_RE with no swipe to
      // trigger reloadStream), clear the stale style so the native URL shows through.
      if (++nullSrcStreak >= 100) { nullSrcStreak = 0; clearStaleRefreshStyle(); }
      return;
    }
    nullSrcStreak = 0;
    if (lastPhotoSrc !== null && src !== lastPhotoSrc) {
      // New photo -> the touch badge's sticky dismiss resets so it can surface
      // again on the next touch. (A badge persisting across this change is always
      // a swipe re-arm, which re-surfaces for the new photo -- don't hide it.)
      touchDismissed = null;
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
    if (s) { loadStyle(s); readPauseState(s); readTouchState(s); loadServerPastHistory(s); return; }
    setTimeout(function() { var s2 = currentStream(); if (s2) { loadStyle(s2); readPauseState(s2); readTouchState(s2); loadServerPastHistory(s2); } }, 2000);
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
    liveBlobUrl = null; liveBlobSrc = null; displayedAssetId = null; window.__jaxLiveBlobUrl = null;
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
  // Test hooks for the touch-hold badge. Reset clears sticky dismiss + deadline +
  // the dismiss guard; expire forces the window past its deadline to assert
  // auto-hide without a real 90s wait. Test instrumentation only.
  window.__jaxResetTouchIndicator = function() { touchDismissed = null; touchDeadline = 0; lastTouchDismissAt = 0; hideTouchIndicator(); };
  window.__jaxExpireTouchWindow = function() { touchDeadline = Date.now() - 1; updateTouchRing(); };

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
    if (touchRingTimer) { clearInterval(touchRingTimer); touchRingTimer = null; }
    clearSlide(); pendingSlideDir = 0;
    if (touchIndicator && touchIndicator.parentNode) { touchIndicator.parentNode.removeChild(touchIndicator); touchIndicator = null; }
    touchDeadline = 0; touchDismissed = null; lastTouchDismissAt = 0;
    paused = false; lastTouchArm = 0;
    if (window.__jaxActiveToast) { try { window.__jaxActiveToast(); } catch (e) {} window.__jaxActiveToast = null; }
    revokeAllBlobs();
    photoHistory = []; historyPos = -1; histNavSuppress = false; bgRoot = null; nullSrcStreak = 0;
    delete window.__jaxHistoryPos; delete window.__jaxHistory;
    delete window.__jaxLastBack;   delete window.__jaxClearHistory;
    delete window.__jaxLiveBlobUrl;
    delete window.__jaxDisplayedAssetId;
    delete window.__jaxResetSwipeCooldown;
    delete window.__jaxResetTouchArm;
    delete window.__jaxResetTouchIndicator;
    delete window.__jaxExpireTouchWindow;
    delete window.__jaxResetPauseState;
    delete window.__jaxLastSwipe;
    delete window.__jaxLastSlide;
    delete window.__jaxLastRating;
    delete window.__jaxLastRemove;
    delete window.__jaxLastReload;
    delete window.__jaxLastMenu;
    delete window.__jaxPausePhotoWatch;
    delete window.__jaxResumePhotoWatch;
    delete window.__jaxPaused;
    delete window.__jaxLastPauseCall;
    delete window.__jaxStreamSwipeLoaded;
    delete window.__jaxStreamSwipeDestroy;
    delete window.__jaxServerHistoryLoaded;
  };

  // eslint-disable-next-line no-console
  console.info("[jax-stream-swipe] loaded");
})();
