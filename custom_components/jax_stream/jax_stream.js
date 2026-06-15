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
 * scrollTop=1 on html/body (SwipeRefreshLayout bypass -- see DEVEL/README.md).
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
  var infoOverlay = null;
  var _currentRating = 0;
  var _currentIsFavorite = false;
  var _currentPhotoInfo = null;
  var lastPhotoSrc = null;
  // Photos are all served as the same overwrite-in-place file (random.jpg); the
  // live photo therefore has no stable server URL once it advances. captureLive
  // caches the BYTES of the photo currently on screen into an in-memory blob: URL
  // so the slide animation can show the true outgoing pixels (the server file
  // already holds the incoming bytes) and the carousel center panel can paint
  // without a re-fetch. Adjacent (prev/next) frames arrive via pub/sub entities.
  var liveBlobUrl  = null;     // blob: URL of the photo currently live on screen
  var liveBlobSrc  = null;     // the computed bg string liveBlobUrl was captured from
  var nextBlobUrl  = null;     // prefetched blob: URL of the next ring slot (image.*_next_image)
  var prevBlobUrl  = null;     // blob: URL of the previous ring slot (image.*_previous_image)
  var _nextPrefetchId = 0;     // generation counter; guards stale next-entity fetch resolves
  var _prevPrefetchId = 0;     // generation counter; guards stale prev-entity fetch resolves
  var displayedAssetId = null; // Immich asset_id parsed from the live JPEG bytes
  var bgRoot       = null;     // cached shadow root hosting ha-card (showBg target)
  var nullSrcStreak = 0;      // consecutive checkPhotoChange ticks returning null src
  var pendingSlideDir = 0;    // swipe-set slide direction handed from fireSwipe to reloadStream
  // Live-drag gesture state. Created on touchmove, snapped or cancelled on touchend.
  var gestureSuppressSlide = false; // when true, slidePhoto returns immediately (one-shot)
  var carouselLeft   = null; // left panel (prev photo)
  var carouselCenter = null; // center panel (current photo)
  var carouselRight  = null; // right panel (next photo)
  var gestureDirSign = 0;   // -1 = forward (left swipe), +1 = back (right swipe)
  var gestureScreenW = 0;   // screen width captured at gesture start
  var _carouselRaf   = 0;   // pending rAF id for touchmove drag writes
  var _carouselCenterImg = null; // CSS bg-image of center panel (for __jaxLastSlide)
  var _carouselLeftCss   = null; // CSS bg-image of left panel
  var _carouselRightCss  = null; // CSS bg-image of right panel
  var _prebuiltOv     = null; // carousel overlay built in onStart at opacity:0
  var _prebuiltPanels = null; // {left, center, right} refs from pre-build
  var _prebuiltCssData = null; // {leftBlobUrl, rightBlobUrl, centerImg, leftCss, rightCss}
  var _warmOv      = null; // carousel overlay built post-swipe; GPU has full inter-swipe interval
  var _warmPanels  = null; // {left, center, right} refs from warm build
  var _warmCssData = null; // {leftBlobUrl, rightBlobUrl, centerImg, leftCss, rightCss}
  var _warmTimer   = null; // pending setTimeout id for _buildWarmOv

  // Pause / suppress-auto-advance state. The switch entity is the source of truth
  // for manual pause; sensor.jax_stream_<stream>_touch_deadline holds the
  // touch-hold deadline (epoch seconds; 0 = not armed).
  // See DEVEL / TODO "Suppress auto-advance after recent touch".
  var paused        = false;   // manual pause (mirrors switch.jax_stream_<stream>)
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
      // Anchor to the VA dashboard prefix, NOT a bare substring. The devices
      // render the kiosk views at /view-assist/clock(alt) and
      // /view-assist/jax-stream; a desktop Lovelace dashboard at
      // /lovelace/jax-stream (e.g. one holding jax-stream-cards) also contains
      // the token "jax-stream" and would otherwise false-positive, flashing the
      // jaxmenu trigger during the load window when inKiosk() falls back to true.
      var p = location.pathname.toLowerCase();
      return p.indexOf("/view-assist/clock") !== -1 ||
             p.indexOf("/view-assist/jax-stream") !== -1;
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

  // True when HA's frontend is connected and showing main content. HA 2026.6
  // keeps home-assistant-main in the shadow root at all times; it renders
  // ha-init-page inside home-assistant-main during the "Loading data" phase.
  // Check both levels so the jaxicon stays hidden through the full splash.
  function haConnected() {
    try {
      var ha = document.querySelector("home-assistant");
      if (!ha || !ha.shadowRoot) return false;
      var sr = ha.shadowRoot;
      if (sr.querySelector("ha-init-page")) return false;
      var main = sr.querySelector("home-assistant-main");
      if (!main) return false;
      if (main.shadowRoot && main.shadowRoot.querySelector("ha-init-page")) return false;
      return true;
    } catch (e) { return true; }
  }

  // All jax UI (jaxicon, pause indicator, swipes) gates on this: on the clock
  // view AND kiosk applied AND HA connected. See inKiosk() for the reset-window
  // rationale; see haConnected() for the post-restart splash rationale.
  function jaxReady() { return onClockView() && inKiosk() && haConnected(); }

  // Expose the readiness predicate so external tooling (tools/record/) can GATE
  // on real device health instead of eyeballing a screencap: kiosk=false means
  // the HA chrome is still showing (post-restart, before VACA re-applies the
  // kiosk view). Detail object names which dimension failed.
  window.__jaxHealth = function () {
    return {
      ready: jaxReady(),
      clockView: onClockView(),
      kiosk: inKiosk(),
      haConnected: haConnected(),
    };
  };

  // SwipeRefreshLayout bypass -- see DEVEL/README.md for the full explanation.
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

  // Confirm overlay for jaxmenu remove. Only one instance at a time.
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

  function openPhotoInfo(info) {
    if (infoOverlay) return;
    tracking = false;
    hideHint();
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:100000;" +
      "background:rgba(0,0,0,0.78);display:flex;flex-direction:column;" +
      "align-items:flex-start;justify-content:center;padding:6vw 8vw;gap:4.5vh;";
    overlay.addEventListener("touchstart", function(e) { e.stopPropagation(); }, { capture: true });
    overlay.addEventListener("touchmove", function(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { capture: true, passive: false });
    overlay.addEventListener("mousedown", function(e) { e.stopPropagation(); }, true);
    infoOverlay = overlay;
    var openedAt = Date.now();
    function cleanup() {
      infoOverlay = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener("touchend", function() { if (Date.now() - openedAt > 200) cleanup(); }, false);
    overlay.addEventListener("mouseup", function() { if (Date.now() - openedAt > 200) cleanup(); }, false);

    function formatDate(dt) {
      if (!dt) return null;
      var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      var m = dt.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return dt;
      return months[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
    }

    function addRow(svgPath, text) {
      if (!text) return;
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4vw;width:100%;";
      var icon = document.createElement("div");
      icon.style.cssText = "flex-shrink:0;width:7vw;height:7vw;display:flex;align-items:center;justify-content:center;opacity:0.7;";
      icon.innerHTML = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none">' + svgPath + "</svg>";
      var label = document.createElement("div");
      label.textContent = text;
      label.style.cssText = "color:#fff;font:400 4.2vh/1.35 sans-serif;flex:1;word-break:break-word;";
      row.appendChild(icon);
      row.appendChild(label);
      overlay.appendChild(row);
    }

    var dateStr = formatDate(info.date || null);
    var ICON_DATE = '<path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    var ICON_LOC  = '<path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="white" stroke-width="2"/>';
    var ICON_CAM  = '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="4" stroke="white" stroke-width="2"/>';
    var ICON_ALB  = '<rect x="2" y="3" width="20" height="18" rx="2" stroke="white" stroke-width="2"/><path d="M8 7h8M8 12h5" stroke="white" stroke-width="2" stroke-linecap="round"/>';

    var loc = [info.city, info.country].filter(Boolean).join(", ");
    addRow(ICON_DATE, dateStr);
    addRow(ICON_LOC,  loc || null);
    addRow(ICON_CAM,  info.camera || null);
    addRow(ICON_ALB,  info.album || null);

    // Show a hint if no fields are populated (first boot, before first advance).
    if (!dateStr && !loc && !info.camera && !info.album) {
      var hint = document.createElement("div");
      hint.textContent = "No photo info available yet";
      hint.style.cssText = "color:rgba(255,255,255,0.5);font:400 4vh/1 sans-serif;";
      overlay.appendChild(hint);
    }

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
              var _stContent = 'ha-card::before, ha-card::after { background-image: url("' + fresh + '") !important; }';
              if (window.__jaxGesturePendingClear && slideOverlay) {
                // Path 3 gesture teardown: old CSS removed above (opaque overlay
                // covers the bare ha-card). Preload fresh URL via Image() so the
                // ha-card has a decoded texture the instant the style tag is
                // appended; 2 rAFs then let the compositor upload it before fade.
                window.__jaxGesturePendingClear = false;
                if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
                if (slideDir && slideFrom) { slidePhoto(fresh, slideDir, slideFrom); slideDir = 0; }
                (function(_st, _content, _root, _fresh, _ov) {
                  var _img = new Image();
                  _img.onload = _img.onerror = function() {
                    _st.textContent = _content;
                    _root.appendChild(_st);
                    window.__jaxLastReload = { stream: stream, url: _fresh, t: Date.now() };
                    (function(s) {
                      setTimeout(function() { if (s && s.parentNode) s.parentNode.removeChild(s); }, 65000);
                    })(_st);
                    requestAnimationFrame(function() {
                      requestAnimationFrame(function() {
                        if (_ov && _ov.parentNode) { _ov.style.transition = "opacity 80ms linear"; _ov.style.opacity = "0"; }
                        slideTimer = setTimeout(function() {
                          if (slideOverlay === _ov) slideOverlay = null;
                          if (_ov && _ov.parentNode) _ov.parentNode.removeChild(_ov);
                          slideTimer = null;
                          _scheduleWarmBuild(500);
                        }, 100);
                        gestureSuppressSlide = false;
                      });
                    });
                  };
                  _img.src = _fresh;
                })(st, _stContent, root, fresh, slideOverlay);
              } else {
                st.textContent = _stContent;
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

  // Capture the bytes of the currently-live photo into a blob: URL so the slide
  // animation can show its true outgoing pixels after the server overwrites
  // random.jpg, and the carousel center panel can paint without a re-fetch.
  // Idempotent per source string; only the most recent capture is kept (the
  // previous blob is revoked when the new one resolves).
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
          prewarmBlobUrl(u);
          displayedAssetId = neighbors.self;
          window.__jaxLiveBlobUrl = u;
          window.__jaxDisplayedAssetId = neighbors.self;
          window.__jaxNeighbors = neighbors;
          var _sm = STREAM_RE.exec(src);
          if (_sm) { prefetchNext(_sm[1]); prefetchPrev(_sm[1]); }
        } else {
          URL.revokeObjectURL(u);  // a newer photo superseded this capture
        }
      })
      .catch(function () {});
  }

  // Read an image entity's entity_picture URL from hass.states (the token-signed
  // /api/image_proxy path). Returns null when the entity or picture is absent.
  function entityPictureUrl(entityId) {
    var h = getHass();
    if (!h || !h.states || !h.states[entityId]) return null;
    var attrs = h.states[entityId].attributes || {};
    return attrs.entity_picture || null;
  }

  // Fetch image.jax_stream_<stream>_next_image's bytes into nextBlobUrl so the
  // gesture overlay can show a real incoming photo immediately. The
  // entity_picture access token rotates whenever the slot changes
  // (subscription-driven invalidation) -- no manual ?v= cache-buster needed.
  // Replaces the old state.json + slot_XX.jpg two-step fetch (pub/sub migration).
  // urlOverride: fresh entity_picture from a state_changed event payload, used to
  // sidestep WebView hass.states lag.
  function prefetchNext(stream, urlOverride) {
    var myId = ++_nextPrefetchId;
    var url = urlOverride || entityPictureUrl('image.jax_stream_' + stream + '_next_image');
    if (!url) return;
    fetch(url, { credentials: 'include' })
      .then(function(r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function(ab) {
        if (!ab || myId !== _nextPrefetchId) return;
        var bytes = new Uint8Array(ab);
        if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return;
        var b = new Blob([ab], { type: 'image/jpeg' });
        var u = URL.createObjectURL(b);
        if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
        nextBlobUrl = u;
        window.__jaxNextBlobUrl = u;
        _scheduleWarmBuild(500);
      })
      .catch(function() {});
  }

  // Fetch image.jax_stream_<stream>_previous_image's bytes into prevBlobUrl so a
  // back-swipe carousel from live shows the coordinator's actual previous photo
  // (survives page reload; no in-memory history needed). A missing/invalid
  // picture (no previous photo yet) clears prevBlobUrl so no phantom left panel
  // is built -- matching the pre-migration "no history -> no left panel" behavior.
  function prefetchPrev(stream, urlOverride) {
    var myId = ++_prevPrefetchId;
    function clearPrev() {
      if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
      prevBlobUrl = null; window.__jaxPrevBlobUrl = null;
    }
    var url = urlOverride || entityPictureUrl('image.jax_stream_' + stream + '_previous_image');
    if (!url) { clearPrev(); return; }
    fetch(url, { credentials: 'include' })
      .then(function(r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function(ab) {
        if (myId !== _prevPrefetchId) return;
        if (!ab) { clearPrev(); return; }
        var bytes = new Uint8Array(ab);
        if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) { clearPrev(); return; }
        var b = new Blob([ab], { type: 'image/jpeg' });
        var u = URL.createObjectURL(b);
        if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
        prevBlobUrl = u;
        window.__jaxPrevBlobUrl = u;
        _scheduleWarmBuild(500);
      })
      .catch(function() {});
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
    var wasGesture = slideOverlay && slideOverlay.getAttribute("data-jax-gesture") === "1";
    if (slideOverlay && slideOverlay.parentNode) {
      slideOverlay.parentNode.removeChild(slideOverlay);
    }
    slideOverlay = null;
    if (wasGesture) _scheduleWarmBuild(500);
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

  // Build one slide panel containing a blur-fill layer (matching ha-card::before)
  // Pre-decode a blob URL into Chrome's image decode cache so that when carousel
  // panels later use it as background-image the GPU texture upload is fast (~1 frame
  // instead of ~7). Called immediately when a blob URL is stored, while idle.
  function prewarmBlobUrl(blobUrl) {
    if (!blobUrl || !window.Image) return;
    var img = new Image();
    img.src = blobUrl;
    if (img.decode) img.decode();
  }

  // and a sharp layer (matching ha-card::after). cssImage is a CSS background-image
  // value (e.g. 'url("blob:...")') or null for a dark placeholder panel.
  function buildGesturePanel(cssImage, card) {
    var wrap = document.createElement("div");
    wrap.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "background:black;overflow:hidden;";
    var blrCss =
      "position:absolute;inset:0;background-size:cover;background-position:center;" +
      "background-repeat:no-repeat;filter:blur(30px);transform:scale(1.1);pointer-events:none;";
    if (cssImage) blrCss += "background-image:" + cssImage + ";";
    var blr = document.createElement("div");
    blr.style.cssText = blrCss;
    var sharpCss =
      "position:absolute;inset:0;background-repeat:no-repeat;pointer-events:none;" +
      "background-size:" + (card ? card.size : "contain") + ";" +
      "background-position:" + (card ? card.position : "center") + ";";
    if (cssImage) sharpCss += "background-image:" + cssImage + ";";
    var sharp = document.createElement("div");
    sharp.style.cssText = sharpCss;
    wrap.appendChild(blr);
    wrap.appendChild(sharp);
    return wrap;
  }

  function slidePhoto(newUrl, dirSign, fromCard) {
    try {
      if (gestureSuppressSlide) { gestureSuppressSlide = false; return false; }
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
        "position:fixed;inset:0;z-index:9000;overflow:hidden;pointer-events:none;background:#1c1c1c;";
      var outg = buildGesturePanel(card.image, card);
      outg.style.transform = "translateX(0)";
      var inc = buildGesturePanel('url("' + newUrl + '")', card);
      inc.style.transform = "translateX(" + (dirSign > 0 ? "100%" : "-100%") + ")";
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
        // Promote to GPU layer now (after initial paint) so the outgoing panel
        // texture is already uploaded before compositing starts -- avoids the
        // 1-frame black flash from an uninitialized compositor layer.
        outg.style.willChange = "transform";
        inc.style.willChange  = "transform";
        // Force layout so the initial transform is committed before transition.
        void ov.offsetWidth;
        outg.style.transition = "transform " + dur + "ms " + ease;
        inc.style.transition  = "transform " + dur + "ms " + ease;
        outg.style.transform = "translateX(" + (dirSign > 0 ? "-100%" : "100%") + ")";
        inc.style.transform  = "translateX(0)";
        // Drop will-change then fade out instead of instant removeChild: the
        // ha-card behind the overlay paints cleanly during the fade, so the
        // final DOM removal is invisible and avoids a progressive-repaint sweep.
        slideTimer = setTimeout(function() {
          if (ov !== slideOverlay) return;
          outg.style.willChange = "";
          inc.style.willChange  = "";
          ov.style.transition = "opacity 80ms linear";
          ov.style.opacity = "0";
          slideTimer = setTimeout(function() { if (slideOverlay === ov) clearSlide(); }, 100);
        }, dur + 50);
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

  function fireSwipe(stream, dir) {
    var hass = getHass();
    if (!hass) return;
    // __jaxLastSwipe is recorded by onEnd (the gesture owner) so it survives every
    // swipe path, including history nav. Don't clobber it here.
    var svcName = dir > 0 ? "next" : "previous";
    pendingSlideDir = dir;
    _localAdvancePending = true;
    Promise.resolve(
      hass.callService("jax_stream", svcName, { stream: stream }, undefined, dir < 0 ? false : true)
    ).then(function() {
      _localAdvancePending = false;
      // Reload when a state_changed arrived during the call (_pendingSubscriptionReload),
      // OR when a gesture overlay is waiting for its post-advance teardown
      // (__jaxGesturePendingClear). The latter must not depend on event timing:
      // if the state_changed lands AFTER this .then(), trySubscribeAdvance sees
      // slideOverlay still up and skips the reload, leaving the overlay to the 8s
      // safety timer. Driving the reload here makes the path-3 teardown deterministic
      // (reloadStream's gesture-pending-clear branch runs while slideOverlay is set).
      if (_pendingSubscriptionReload || window.__jaxGesturePendingClear) {
        _pendingSubscriptionReload = false; reloadStream(stream);
      }
    }).catch(function(err) {
      _localAdvancePending = false; _pendingSubscriptionReload = false;
      if (dir < 0) showStatus("No previous photo", "#888888");
      // eslint-disable-next-line no-console
      console.error("[jax-stream-swipe] " + svcName + " failed:", err);
    });
  }

  function pointOf(e) {
    if (e.touches && e.touches.length) return e.touches[0];
    if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
    return e;
  }

  function _discardPrebuilt() {
    if (_prebuiltOv && _prebuiltOv.parentNode) {
      _prebuiltOv.parentNode.removeChild(_prebuiltOv);
    }
    _prebuiltOv = null; _prebuiltPanels = null; _prebuiltCssData = null;
  }

  function _discardWarm() {
    if (_warmTimer) { clearTimeout(_warmTimer); _warmTimer = null; }
    if (_warmOv && _warmOv.parentNode) {
      _warmOv.parentNode.removeChild(_warmOv);
    }
    _warmOv = null; _warmPanels = null; _warmCssData = null;
  }

  function _scheduleWarmBuild(delayMs) {
    if (_warmTimer) { clearTimeout(_warmTimer); _warmTimer = null; }
    _warmTimer = setTimeout(function() { _warmTimer = null; _buildWarmOv(); }, delayMs);
  }

  function _buildWarmOv() {
    _discardWarm();
    var stream = currentStream();
    if (!stream) return;
    var card = findCardBg();
    if (!card) return;
    var leftBlobUrl  = prevBlobUrl;  // pub/sub: image.*_previous_image (back-swipe from live)
    var rightBlobUrl = nextBlobUrl;  // pub/sub: image.*_next_image (forward-swipe from live)
    if (!leftBlobUrl && !rightBlobUrl) return;
    var host = document.body || document.documentElement;
    var ov = document.createElement("div");
    ov.setAttribute("data-jax-slide", "1");
    ov.setAttribute("data-jax-warm", "1");
    ov.style.cssText = "position:fixed;inset:0;z-index:8999;overflow:hidden;pointer-events:none;background:#1c1c1c;opacity:0;";
    var centerImg = liveBlobUrl ? 'url("' + liveBlobUrl + '")' : card.image;
    var leftCss   = leftBlobUrl  ? 'url("' + leftBlobUrl  + '")' : null;
    var rightCss  = rightBlobUrl ? 'url("' + rightBlobUrl + '")' : null;
    var pLeft   = buildGesturePanel(leftCss,   card);
    var pCenter = buildGesturePanel(centerImg,  card);
    var pRight  = buildGesturePanel(rightCss,   card);
    ov.appendChild(pLeft);
    ov.appendChild(pCenter);
    ov.appendChild(pRight);
    host.appendChild(ov);
    _warmOv      = ov;
    _warmPanels  = { left: pLeft, center: pCenter, right: pRight };
    _warmCssData = { leftBlobUrl: leftBlobUrl, rightBlobUrl: rightBlobUrl,
                     centerImg: centerImg, leftCss: leftCss, rightCss: rightCss };
  }

  function onStart(e) {
    if (e.touches && e.touches.length > 1) { tracking = false; return; }
    if (!jaxReady()) { tracking = false; return; }
    if (isJaxUi(e.target)) { tracking = false; return; }
    var p = pointOf(e);
    startX = p.clientX; startY = p.clientY; startT = Date.now();
    tracking = true;
    if (_carouselRaf) { cancelAnimationFrame(_carouselRaf); _carouselRaf = 0; }
    _discardPrebuilt();
    carouselLeft = null; carouselCenter = null; carouselRight = null;
    gestureDirSign = 0; gestureScreenW = 0;
    showHint();
    // Pre-build carousel at opacity:0 so the GPU has the gesture-recognition
    // window (~100-200ms before first qualifying onMove) to upload blob textures.
    // When onMove confirms horizontal intent it flips opacity to 1 instantly.
    var stream = currentStream();
    if (!stream) return;
    var card = findCardBg();
    if (!card) return;
    var leftBlobUrl  = prevBlobUrl;  // pub/sub: image.*_previous_image (back-swipe from live)
    var rightBlobUrl = nextBlobUrl;  // pub/sub: image.*_next_image (forward-swipe from live)
    if (!leftBlobUrl && !rightBlobUrl) return;
    var host = document.body || document.documentElement;
    var ov = document.createElement("div");
    ov.setAttribute("data-jax-slide", "1");
    ov.setAttribute("data-jax-gesture", "1");
    ov.style.cssText = "position:fixed;inset:0;z-index:9000;overflow:hidden;pointer-events:none;background:#1c1c1c;opacity:0;";
    var centerImg = liveBlobUrl ? 'url("' + liveBlobUrl + '")' : card.image;
    var leftCss   = leftBlobUrl  ? 'url("' + leftBlobUrl  + '")' : null;
    var rightCss  = rightBlobUrl ? 'url("' + rightBlobUrl + '")' : null;
    var pLeft   = buildGesturePanel(leftCss,   card);
    var pCenter = buildGesturePanel(centerImg,  card);
    var pRight  = buildGesturePanel(rightCss,   card);
    ov.appendChild(pLeft);
    ov.appendChild(pCenter);
    ov.appendChild(pRight);
    host.appendChild(ov);
    _prebuiltOv = ov;
    _prebuiltPanels = { left: pLeft, center: pCenter, right: pRight };
    _prebuiltCssData = { leftBlobUrl: leftBlobUrl, rightBlobUrl: rightBlobUrl,
                         centerImg: centerImg, leftCss: leftCss, rightCss: rightCss };
  }

  function onMove(e) {
    if (!tracking) return;
    if (e.cancelable) e.preventDefault();

    var p = pointOf(e);
    var dx = Math.round(p.clientX - startX);
    var dy = Math.round(p.clientY - startY);
    var adx = Math.abs(dx), ady = Math.abs(dy);

    // Wait for clear horizontal intent before building overlay
    if (adx < 10 || adx < ady * 1.5) return;

    var stream = currentStream();
    if (!stream) return;

    if (!carouselCenter) {
      clearSlide();
      gestureDirSign = dx > 0 ? 1 : -1;
      gestureScreenW = window.innerWidth || 360;
      var W = gestureScreenW;

      // Resolve the incoming blob for the swipe direction.
      var leftBlobUrl  = prevBlobUrl;  // pub/sub: image.*_previous_image (back-swipe from live)
      var rightBlobUrl = nextBlobUrl;  // pub/sub: image.*_next_image (forward-swipe from live)

      // Only build the carousel when the incoming panel has real content.
      // Without it the incoming panel is solid black; fall through to direct
      // nav in onEnd, which uses the slidePhoto animation path instead.
      var incomingBlob = gestureDirSign < 0 ? rightBlobUrl : leftBlobUrl;
      if (!incomingBlob) { _discardPrebuilt(); _discardWarm(); return; }

      var ov, pLeft, pCenter, pRight, centerImg, leftCss, rightCss;

      // Prefer the warm overlay (GPU had the full inter-swipe interval to upload
      // textures). Fall back to the onStart prebuilt (GPU had ~100-200ms).
      var wb = _warmCssData;
      if (_warmOv && _warmOv.parentNode && wb &&
          wb.leftBlobUrl === leftBlobUrl && wb.rightBlobUrl === rightBlobUrl) {
        ov = _warmOv;
        pLeft   = _warmPanels.left;
        pCenter = _warmPanels.center;
        pRight  = _warmPanels.right;
        centerImg = wb.centerImg;
        leftCss   = wb.leftCss;
        rightCss  = wb.rightCss;
        _warmOv = null; _warmPanels = null; _warmCssData = null;
        _discardPrebuilt();
        ov.style.opacity = "1";
      } else {
        var pb = _prebuiltCssData;
        if (_prebuiltOv && _prebuiltOv.parentNode && pb &&
            pb.leftBlobUrl === leftBlobUrl && pb.rightBlobUrl === rightBlobUrl) {
          ov = _prebuiltOv;
          pLeft   = _prebuiltPanels.left;
          pCenter = _prebuiltPanels.center;
          pRight  = _prebuiltPanels.right;
          centerImg = pb.centerImg;
          leftCss   = pb.leftCss;
          rightCss  = pb.rightCss;
          _prebuiltOv = null; _prebuiltPanels = null; _prebuiltCssData = null;
          ov.style.opacity = "1";
        } else {
          _discardPrebuilt(); _discardWarm();
        var card = findCardBg();
        if (!card) return;
        var host = document.body || document.documentElement;
        ov = document.createElement("div");
        ov.setAttribute("data-jax-slide", "1");
        ov.setAttribute("data-jax-gesture", "1");
        ov.style.cssText = "position:fixed;inset:0;z-index:9000;overflow:hidden;pointer-events:none;background:#1c1c1c;";
        centerImg = liveBlobUrl ? 'url("' + liveBlobUrl + '")' : card.image;
        leftCss   = leftBlobUrl  ? 'url("' + leftBlobUrl  + '")' : null;
        rightCss  = rightBlobUrl ? 'url("' + rightBlobUrl + '")' : null;
        pLeft   = buildGesturePanel(leftCss,   card);
        pCenter = buildGesturePanel(centerImg,  card);
        pRight  = buildGesturePanel(rightCss,   card);
        ov.appendChild(pLeft);
        ov.appendChild(pCenter);
        ov.appendChild(pRight);
        host.appendChild(ov);
        }
      }

      slideOverlay = ov;
      carouselLeft   = pLeft;
      carouselCenter = pCenter;
      carouselRight  = pRight;
      _carouselCenterImg = centerImg;
      _carouselLeftCss   = leftCss;
      _carouselRightCss  = rightCss;
    }

    // Track finger: no transition during drag
    var W = gestureScreenW;
    carouselLeft.style.transition   = "";
    carouselCenter.style.transition = "";
    carouselRight.style.transition  = "";
    carouselLeft.style.transform   = "translateX(" + (dx - W) + "px)";
    carouselCenter.style.transform = "translateX(" + dx + "px)";
    carouselRight.style.transform  = "translateX(" + (dx + W) + "px)";
  }

  function onCancel(e) {
    if (!tracking) return;
    tracking = false;
    hideHint();
    if (_carouselRaf) { cancelAnimationFrame(_carouselRaf); _carouselRaf = 0; }
    if (!carouselCenter) { _discardPrebuilt(); _discardWarm(); return; }
    if (carouselCenter) {
      var W = gestureScreenW;
      var dur = 220;
      var tr = "transform " + dur + "ms cubic-bezier(.4,0,.6,1)";
      void carouselLeft.offsetWidth;
      carouselLeft.style.willChange   = "transform";
      carouselCenter.style.willChange = "transform";
      carouselRight.style.willChange  = "transform";
      carouselLeft.style.transition   = tr;
      carouselCenter.style.transition = tr;
      carouselRight.style.transition  = tr;
      carouselLeft.style.transform   = "translateX(" + (-W) + "px)";
      carouselCenter.style.transform = "translateX(0)";
      carouselRight.style.transform  = "translateX(" + W + "px)";
      var cl = carouselLeft, cc = carouselCenter, cr = carouselRight;
      cc.addEventListener("transitionend", function() {
        cl.style.willChange = ""; cc.style.willChange = ""; cr.style.willChange = "";
      }, { once: true });
      carouselLeft = null; carouselCenter = null; carouselRight = null;
      gestureDirSign = 0; gestureScreenW = 0;
      slideTimer = setTimeout(function() {
        if (slideOverlay) { slideOverlay.style.transition = "opacity 80ms linear"; slideOverlay.style.opacity = "0"; }
        slideTimer = setTimeout(clearSlide, 100);
      }, dur + 50);
    }
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

    // If a live-drag gesture overlay is active, drive it to completion or back.
    if (_carouselRaf) { cancelAnimationFrame(_carouselRaf); _carouselRaf = 0; }
    if (carouselCenter) {
      var thresholdMet = adx >= CFG.minDistance && dt <= CFG.maxDuration &&
          adx >= ady * CFG.axisRatio;
      var cooldownOk = (Date.now() - lastFire) >= CFG.cooldownMs;
      var doComplete = thresholdMet && cooldownOk && stream;

      var snapDur  = doComplete ? 180 : 220;
      var snapEase = doComplete ? "cubic-bezier(.2,.8,.4,1)" : "cubic-bezier(.4,0,.6,1)";
      var W = gestureScreenW;
      var tr = "transform " + snapDur + "ms " + snapEase;
      void carouselLeft.offsetWidth;
      carouselLeft.style.willChange   = "transform";
      carouselCenter.style.willChange = "transform";
      carouselRight.style.willChange  = "transform";
      carouselLeft.style.transition   = tr;
      carouselCenter.style.transition = tr;
      carouselRight.style.transition  = tr;

      var cl = carouselLeft, cc = carouselCenter, cr = carouselRight;
      cc.addEventListener("transitionend", function() {
        cl.style.willChange = ""; cc.style.willChange = ""; cr.style.willChange = "";
      }, { once: true });

      if (doComplete) {
        if (gestureDirSign < 0) {
          // Forward swipe: all shift left, right panel lands at center
          carouselLeft.style.transform   = "translateX(" + (-2 * W) + "px)";
          carouselCenter.style.transform = "translateX(" + (-W) + "px)";
          carouselRight.style.transform  = "translateX(0)";
        } else {
          // Back swipe: all shift right, left panel lands at center
          carouselLeft.style.transform   = "translateX(0)";
          carouselCenter.style.transform = "translateX(" + W + "px)";
          carouselRight.style.transform  = "translateX(" + (2 * W) + "px)";
        }

        var swipeDir = gestureDirSign < 0 ? "left" : "right";
        var action   = gestureDirSign < 0 ? "next" : "prev";
        lastFire = Date.now();
        window.__jaxLastSwipe = { finger: swipeDir, action: action, stream: stream, t: lastFire };
        window.__jaxLastSlide = {
          dir: gestureDirSign < 0 ? 1 : -1,
          out: (_carouselCenterImg || '').slice(0, 48),
          inc: (gestureDirSign < 0 ? (_carouselRightCss || '') : (_carouselLeftCss || '')).slice(0, 48),
          t: lastFire
        };
        if (e.stopPropagation) e.stopPropagation();
        if (paused) autoUnpause(stream);

        var capturedDir = gestureDirSign;
        carouselLeft = null; carouselCenter = null; carouselRight = null;
        gestureDirSign = 0; gestureScreenW = 0;

        setTimeout(function() {
          gestureSuppressSlide = true;
          // Both directions defer teardown to reloadStream (driven by
          // __jaxGesturePendingClear when the new URL lands): keep the carousel
          // overlay up -- showing the destination photo at center -- until the
          // ha-card has been repainted to that SAME photo, THEN fade. Back-swipe
          // used to fade on a fixed ~132ms timer that raced the async
          // jax_stream.previous repaint: the overlay faded to reveal the ha-card
          // still on the OUTGOING photo (random.jpg not yet rewritten by the
          // coordinator), so a back-swipe flashed the old photo for ~1s before the
          // state_changed reload settled on the prev photo. Forward never raced
          // because it already deferred; back now matches it.
          if (capturedDir > 0) { prevBlobUrl = null; }  // consumed; reprefetched after the photo lands
          else { nextBlobUrl = null; }
          window.__jaxGesturePendingClear = true;
          window.__jaxLastSlide.teardown = "deferred-reload";
          fireSwipe(stream, capturedDir > 0 ? -1 : 1);
          // Safety fallback only -- reloadStream wins when the new URL lands
          // (server + coordinator + fetch ~1-3s; 8s gives wide margin).
          slideTimer = setTimeout(function() {
            window.__jaxGesturePendingClear = false;
            gestureSuppressSlide = false;
            if (slideOverlay) { slideOverlay.style.transition = "opacity 80ms linear"; slideOverlay.style.opacity = "0"; }
            slideTimer = setTimeout(clearSlide, 100);
          }, 8000);
        }, snapDur + 20);
      } else {
        // Snap back to rest positions
        carouselLeft.style.transform   = "translateX(" + (-W) + "px)";
        carouselCenter.style.transform = "translateX(0)";
        carouselRight.style.transform  = "translateX(" + W + "px)";
        carouselLeft = null; carouselCenter = null; carouselRight = null;
        gestureDirSign = 0; gestureScreenW = 0;
        slideTimer = setTimeout(clearSlide, snapDur + 50);
      }
      return;
    }

    // No gesture overlay (very fast swipe, no touchmove): fall through to direct nav.
    _discardPrebuilt(); _discardWarm();
    if (adx < CFG.minDistance) return;
    if (dt > CFG.maxDuration) return;
    if (adx < ady * CFG.axisRatio) return;

    var now = Date.now();
    if (now - lastFire < CFG.cooldownMs) return;
    if (!stream) return;

    lastFire = now;
    if (e.stopPropagation) e.stopPropagation();
    var dir = dx < 0 ? "left" : "right";
    var action = dir === "left" ? "next" : "prev";
    window.__jaxLastSwipe = { finger: dir, action: action, stream: stream, t: now };
    if (action === "next") {
      fireSwipe(stream, 1);
    } else {
      fireSwipe(stream, -1);
    }
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
    var ctrls = [jaxMenuTrigger, pauseIndicator, touchIndicator, jaxMenuOverlay, confirmOverlay, ratingMenuOverlay, infoOverlay];
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
    // Aligned with the flyout's first item (left:11 + 1 button-width) so it reads
    // as the pause control persisting just right of the jaxicon.
    pauseIndicator.style.cssText =
      "position:fixed;top:15px;left:11px;width:7vw;height:7vw;" +
      "transform:translateX(" + (Math.round(window.innerWidth * 0.07) + 4) + "px);background:rgba(0,0,0,0.45);border-radius:10px;" +
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
      "transform:translateX(" + (Math.round(window.innerWidth * 0.07) + 4) + "px);background:rgba(0,0,0,0.45);border-radius:10px;" +
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
  // entity persists). sensor.jax_stream_<stream>_touch_deadline holds an integer
  // epoch deadline (0 = not armed). Read from hass.states at init; live updates
  // arrive via trySubscribeTouchDeadline.
  function initTouchState(stream) {
    if (!stream) return;
    var h = getHass();
    if (!h || !h.states) return;
    var dlEntity = "sensor.jax_stream_" + stream + "_touch_deadline";
    if (!h.states[dlEntity]) return;
    var dl = parseInt(h.states[dlEntity].state, 10);
    if (isNaN(dl) || dl <= 0) return;
    touchDeadline = dl * 1000;
    if (touchDeadline - Date.now() > 0) surfaceTouchIndicator();
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
    var INFO_SVG =
      '<svg pointer-events="none" width="76%" height="76%" viewBox="0 0 24 24" fill="none">' +
      '<circle cx="12" cy="12" r="10" stroke="white" stroke-width="2"/>' +
      '<line x1="12" y1="10" x2="12" y2="17" stroke="white" stroke-width="2.2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="7" r="1.2" fill="white"/>' +
      '</svg>';
    // Heart path: filled (pink) when favorited, outline (white) when not.
    var HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
    var HEART_FILL_SVG =
      '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 24 24">' +
      '<path d="' + HEART_PATH + '" fill="#ff5588"/>' +
      '</svg>';
    var HEART_OUTLINE_SVG =
      '<svg pointer-events="none" width="80%" height="80%" viewBox="0 0 24 24">' +
      '<path d="' + HEART_PATH + '" fill="none" stroke="white" stroke-width="2"/>' +
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
        var rotAssetId = displayedAssetId;
        var dismiss = showStatus("Rotating", "#44aaff");
        var svcArgs = { stream: s, angle: delta };
        if (rotAssetId) svcArgs.asset_id = rotAssetId;
        window.__jaxLastRotate = { stream: s, asset_id: rotAssetId, angle: delta, t: Date.now() };
        _localAdvancePending = true;
        Promise.resolve(
          hass.callService("jax_stream", "rotate", svcArgs)
        ).then(function() {
          _localAdvancePending = false;
          if (_pendingSubscriptionReload) { _pendingSubscriptionReload = false; reloadStream(s); }
          setTimeout(dismiss, 800);
        }).catch(function(err) { _localAdvancePending = false; _pendingSubscriptionReload = false; dismiss(); console.error("[jax-stream] rotate failed:", err); });
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

    var pauseDef = paused
      ? { svg: RESUME_SVG, onTap: function() { if (stream) doResume(stream); } }
      : { svg: PAUSE_SVG,  onTap: function() { if (stream) doPause(stream); } };
    var ALL_DEFS = {
      pause: pauseDef,
      remove: {
        svg: REMOVE_SVG,
        onTap: function() {
          if (!stream) return;
          var s = stream;
          // Identity is embedded in the displayed JPEG bytes and captured at
          // display time -- no current.txt fetch needed, no drift possible.
          var capturedAssetId = displayedAssetId;
          showConfirm(function() {
            var hass = getHass();
            if (!hass) return;
            var dismiss = showStatus("Removing", "#ff5555");
            var svcArgs = { stream: s };
            if (capturedAssetId) svcArgs.asset_id = capturedAssetId;
            window.__jaxLastRemove = { stream: s, asset_id: capturedAssetId, t: Date.now() };
            _localAdvancePending = true;
            Promise.resolve(
              hass.callService("jax_stream", "remove", svcArgs)
            ).then(function() {
              _localAdvancePending = false;
              if (_pendingSubscriptionReload) { _pendingSubscriptionReload = false; reloadStream(s); }
              setTimeout(dismiss, 800);
            }).catch(function(err) { _localAdvancePending = false; _pendingSubscriptionReload = false; dismiss(); console.error("[jax-stream] remove_confirm failed:", err); });
          }, null);
        }
      },
      rate: {
        svg: RATE_SVG,
        onTap: function() {
          if (!stream) return;
          var hass = getHass();
          if (!hass) return;
          var s = stream;
          // Capture identity at tap time -- same drift-prevention pattern as Remove.
          var ratingAssetId = displayedAssetId;
          openRatingMenu(s, _currentRating, ratingAssetId);
        }
      },
      rotccw: { svg: ROTCCW_SVG, onTap: makeRotate(270) },
      rotcw:  { svg: ROTCW_SVG,  onTap: makeRotate(90)  },
      info:   { svg: INFO_SVG,   onTap: function() { openPhotoInfo(_currentPhotoInfo || {}); } },
      favorite: {
        svg: _currentIsFavorite ? HEART_FILL_SVG : HEART_OUTLINE_SVG,
        onTap: function() {
          if (!stream) return;
          var hass = getHass();
          if (!hass) return;
          var s = stream;
          var favAssetId = displayedAssetId;
          var nextFav = !_currentIsFavorite;
          var dismiss = showStatus(nextFav ? "Favorited" : "Unfavorited", nextFav ? "#ff5588" : "#aaaaaa");
          var svcArgs = { stream: s };
          if (favAssetId) svcArgs.asset_id = favAssetId;
          Promise.resolve(
            hass.callService("jax_stream", "toggle_favorite", svcArgs)
          ).then(function() {
            _currentIsFavorite = nextFav;
            setTimeout(dismiss, 800);
          }).catch(function(err) { dismiss(); console.error("[jax-stream] toggle_favorite failed:", err); });
        }
      }
    };

    // Read the configured icon order from the current_photo sensor attribute.
    // Entity ID: sensor.jax_stream_<stream>_current_photo (HA slugifies the
    // translated name "Current photo" from the "current_asset" translation key).
    // Falls back to the hardcoded default if the attribute is absent or unrecognized.
    var menuOrder = ["pause","remove","rate","rotccw","rotcw","info","favorite"];
    var _h = getHass();
    if (_h && _h.states && stream) {
      var _assetSensor = _h.states["sensor.jax_stream_" + stream + "_current_photo"];
      if (_assetSensor && _assetSensor.attributes && Array.isArray(_assetSensor.attributes.menu_order)) {
        menuOrder = _assetSensor.attributes.menu_order;
      }
    }
    var itemDefs = menuOrder.map(function(k) { return ALL_DEFS[k]; }).filter(Boolean);

    itemDefs.forEach(function(def, i) {
      var btn = document.createElement("div");
      var step = Math.round(window.innerWidth * 0.07) + 4;
      var targetX = step + i * step;
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
      // The outgoing photo's liveBlobUrl is released by captureLive below when
      // the new src resolves (it revokes the prior blob before adopting the new
      // one), so no explicit cleanup is needed here.
      if (jaxMenuItems.length || confirmOverlay || ratingMenuOverlay || infoOverlay) {
        closeJaxMenu();
        if (confirmOverlay && confirmOverlay.parentNode) { confirmOverlay.parentNode.removeChild(confirmOverlay); confirmOverlay = null; }
        if (ratingMenuOverlay && ratingMenuOverlay.parentNode) { ratingMenuOverlay.parentNode.removeChild(ratingMenuOverlay); ratingMenuOverlay = null; }
        if (infoOverlay && infoOverlay.parentNode) { infoOverlay.parentNode.removeChild(infoOverlay); infoOverlay = null; }
      }
    }
    lastPhotoSrc = src;
    // Cache the bytes of whatever photo is now live (no-op if already captured).
    captureLive(src);
  }

  // Subscribe once to state_changed events for image.jax_stream_<stream> so
  // any photo advance (HA dashboard button, service call, organic timer)
  // immediately reloads the background URL without waiting for VA's refresh.
  // Uses state_changed rather than the custom jax_stream_advance event because
  // the kiosk (non-admin) user cannot subscribe to custom events.
  var _advanceUnsub = null;
  var _lastAdvanceUpdated = null;
  var _localAdvancePending = false;      // true while THIS device's own service call is in-flight
  var _pendingSubscriptionReload = false; // state_changed arrived while guard was up; flush in .then()
  function trySubscribeAdvance() {
    if (_advanceUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var imgEntity = "image.jax_stream_" + s;
    if (h.states && h.states[imgEntity]) {
      _lastAdvanceUpdated = h.states[imgEntity].last_updated || null;
      var initAttrs = h.states[imgEntity].attributes || {};
      _currentPhotoInfo = {
        date: initAttrs.photo_date || null,
        city: initAttrs.photo_city || null,
        country: initAttrs.photo_country || null,
        camera: initAttrs.photo_camera || null,
        album: initAttrs.photo_album || null,
      };
      _currentIsFavorite = !!initAttrs.is_favorite;
    }
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== imgEntity) return;
      var upd = d.new_state && d.new_state.last_updated;
      if (!upd || upd === _lastAdvanceUpdated) return;
      _lastAdvanceUpdated = upd;
      var attrs = d.new_state.attributes || {};
      _currentPhotoInfo = {
        date: attrs.photo_date || null,
        city: attrs.photo_city || null,
        country: attrs.photo_country || null,
        camera: attrs.photo_camera || null,
        album: attrs.photo_album || null,
      };
      _currentIsFavorite = !!attrs.is_favorite;
      if (_localAdvancePending) { _pendingSubscriptionReload = true; return; }
      if (!slideOverlay) { if (!carouselLeft) pendingSlideDir = 1; reloadStream(s); }
    }, "state_changed").then(function(unsub) { _advanceUnsub = unsub; });
  }

  // Subscribe once to state_changed for switch.jax_stream_<stream> so a pause
  // or resume from any source (another device, HA dashboard, service call)
  // immediately updates the local indicator without waiting for the next poll.
  var _pauseUnsub = null;
  function trySubscribePause() {
    if (_pauseUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var switchEntity = "switch.jax_stream_" + s;
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== switchEntity) return;
      var newState = d.new_state && d.new_state.state;
      if (newState === "on")  { paused = true;  window.__jaxPaused = true;  syncPauseIndicator(); }
      if (newState === "off") { paused = false; window.__jaxPaused = false; syncPauseIndicator(); }
    }, "state_changed").then(function(unsub) { _pauseUnsub = unsub; });
  }

  var _ratingUnsub = null;
  function trySubscribeRating() {
    if (_ratingUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var ratingEntity = "number.jax_stream_" + s + "_rating";
    if (h.states && h.states[ratingEntity]) {
      var init = parseInt(h.states[ratingEntity].state, 10);
      _currentRating = (isNaN(init) || init < 0 || init > 5) ? 0 : init;
    }
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== ratingEntity) return;
      var ns = d.new_state || {};
      var val = parseInt(ns.state, 10);
      val = (isNaN(val) || val < 0 || val > 5) ? 0 : val;
      _currentRating = val;
      // Toast a rating made on ANOTHER device for the photo we are showing.
      // Two events reach the rating entity: a genuine rating ACTION (asset_id
      // attribute == the photo on screen) and the incidental rating change
      // that rides along on a stream advance (asset_id == the INCOMING photo,
      // not yet painted here, so it will not match displayedAssetId). Only the
      // former should surface a pill -- an advance must stay silent.
      var evAsset = ns.attributes && ns.attributes.asset_id;
      if (!evAsset || evAsset !== displayedAssetId) return;
      // Suppress our own echo: fireRating() already flashed the pill on the
      // device that made the change, and the same value rebounds via this sub.
      var lr = window.__jaxLastRating;
      if (lr && lr.stars === val && lr.asset_id === evAsset &&
          (Date.now() - lr.t) < 6000) return;
      var msg = val === 0 ? "Unrated" : ("Rated " + val + (val === 1 ? " star" : " stars"));
      showStatus(msg, val === 0 ? "#aaaaaa" : "#ffcc44");
    }, "state_changed").then(function(unsub) { _ratingUnsub = unsub; });
  }

  // Subscribe once to state_changed for sensor.jax_stream_<stream>_touch_deadline
  // so a tap on any device (and the coordinator's organic re-arm) surfaces or
  // clears the touch countdown ring here without waiting for a poll. The
  // coordinator pushes 0 on resume; a non-positive value tears the ring down.
  var _touchDeadlineUnsub = null;
  function trySubscribeTouchDeadline() {
    if (_touchDeadlineUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var dlEntity = "sensor.jax_stream_" + s + "_touch_deadline";
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== dlEntity) return;
      var dl = parseInt(d.new_state && d.new_state.state, 10);
      if (isNaN(dl) || dl <= 0) { touchDeadline = 0; hideTouchIndicator(); return; }
      touchDeadline = dl * 1000;
      if (touchDeadline - Date.now() > 0) surfaceTouchIndicator();
    }, "state_changed").then(function(unsub) { _touchDeadlineUnsub = unsub; });
  }

  // Subscribe once to state_changed for image.jax_stream_<stream>_next_image and
  // _previous_image so the prefetch / carousel adjacency blobs refresh the moment
  // the coordinator advances or backfills a neighbor slot -- no state.json polling.
  // The event payload carries the fresh entity_picture, sidestepping WebView
  // hass.states lag. Also fires an initial fetch so the blobs populate at load.
  var _nextImageUnsub = null;
  function trySubscribeNextImage() {
    if (_nextImageUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var nextEntity = "image.jax_stream_" + s + "_next_image";
    prefetchNext(s);  // initial populate from hass.states
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== nextEntity) return;
      var url = d.new_state && d.new_state.attributes && d.new_state.attributes.entity_picture;
      if (url) prefetchNext(s, url);
    }, "state_changed").then(function(unsub) { _nextImageUnsub = unsub; });
  }

  var _prevImageUnsub = null;
  function trySubscribePrevImage() {
    if (_prevImageUnsub) return;
    var h = getHass();
    if (!h || !h.connection || typeof h.connection.subscribeEvents !== 'function') return;
    var s = currentStream();
    if (!s) return;
    var prevEntity = "image.jax_stream_" + s + "_previous_image";
    prefetchPrev(s);  // initial populate from hass.states
    h.connection.subscribeEvents(function(event) {
      var d = event.data || {};
      if (d.entity_id !== prevEntity) return;
      var url = d.new_state && d.new_state.attributes && d.new_state.attributes.entity_picture;
      prefetchPrev(s, url || undefined);  // missing url -> clears prevBlobUrl (no previous)
    }, "state_changed").then(function(unsub) { _prevImageUnsub = unsub; });
  }

  function syncAll() { syncTouchAction(); syncJaxMenuTrigger(); syncPauseIndicator(); trySubscribeAdvance(); trySubscribePause(); trySubscribeRating(); trySubscribeTouchDeadline(); trySubscribeNextImage(); trySubscribePrevImage(); }

  syncTouchAction();
  syncJaxMenuTrigger();
  // Try to inject style.css at load; retry after 2s if jax-stream background
  // isn't in the DOM yet (button-card renders background asynchronously).
  function initPauseState(stream) {
    var h = getHass();
    var sw = "switch.jax_stream_" + stream;
    if (h && h.states && h.states[sw]) {
      paused = h.states[sw].state === "on";
      window.__jaxPaused = paused;
      syncPauseIndicator();
    }
  }
  (function tryLoadStyle() {
    var s = currentStream();
    if (s) { loadStyle(s); initPauseState(s); initTouchState(s); return; }
    setTimeout(function() { var s2 = currentStream(); if (s2) { loadStyle(s2); initPauseState(s2); initTouchState(s2); } }, 2000);
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

  // Revoke the cached live-photo blob: URL so it does not leak across
  // resets/teardown, and reset the captured identity.
  function revokeAllBlobs() {
    if (liveBlobUrl) URL.revokeObjectURL(liveBlobUrl);
    liveBlobUrl = null; liveBlobSrc = null; displayedAssetId = null; window.__jaxLiveBlobUrl = null;
  }

  // Test hook: drop the cached live blob so the next checkPhotoChange re-captures
  // it fresh (tests poll __jaxLiveBlobUrl to confirm a new capture landed). Test
  // instrumentation only, never invoked by production code paths.
  window.__jaxResetBlobs = revokeAllBlobs;
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
  // Test hook: re-run the post-bounce init readback (reads the touch_deadline
  // entity from hass.states and restores the ring). Test instrumentation only.
  window.__jaxInitTouchState = function() { initTouchState(currentStream()); };

  window.__jaxStreamSwipeDestroy = function () {
    if (_advanceUnsub) { try { _advanceUnsub(); } catch (e) {} _advanceUnsub = null; _lastAdvanceUpdated = null; } _localAdvancePending = false; _pendingSubscriptionReload = false;
    if (_pauseUnsub) { try { _pauseUnsub(); } catch (e) {} _pauseUnsub = null; }
    if (_ratingUnsub) { try { _ratingUnsub(); } catch (e) {} _ratingUnsub = null; }
    if (_touchDeadlineUnsub) { try { _touchDeadlineUnsub(); } catch (e) {} _touchDeadlineUnsub = null; }
    if (_nextImageUnsub) { try { _nextImageUnsub(); } catch (e) {} _nextImageUnsub = null; }
    if (_prevImageUnsub) { try { _prevImageUnsub(); } catch (e) {} _prevImageUnsub = null; }
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
    if (infoOverlay && infoOverlay.parentNode) { infoOverlay.parentNode.removeChild(infoOverlay); infoOverlay = null; }
    closeJaxMenu();
    if (jaxMenuTrigger && jaxMenuTrigger.parentNode) { jaxMenuTrigger.parentNode.removeChild(jaxMenuTrigger); jaxMenuTrigger = null; }
    if (pauseIndicator && pauseIndicator.parentNode) { pauseIndicator.parentNode.removeChild(pauseIndicator); pauseIndicator = null; }
    if (touchRingTimer) { clearInterval(touchRingTimer); touchRingTimer = null; }
    clearSlide(); _discardWarm(); pendingSlideDir = 0;
    if (_carouselRaf) { cancelAnimationFrame(_carouselRaf); _carouselRaf = 0; }
    carouselLeft = null; carouselCenter = null; carouselRight = null;
    gestureDirSign = 0; gestureScreenW = 0;
    gestureSuppressSlide = false; window.__jaxGesturePendingClear = false;
    if (touchIndicator && touchIndicator.parentNode) { touchIndicator.parentNode.removeChild(touchIndicator); touchIndicator = null; }
    touchDeadline = 0; touchDismissed = null; lastTouchDismissAt = 0;
    paused = false; lastTouchArm = 0;
    if (window.__jaxActiveToast) { try { window.__jaxActiveToast(); } catch (e) {} window.__jaxActiveToast = null; }
    if (nextBlobUrl) { URL.revokeObjectURL(nextBlobUrl); nextBlobUrl = null; window.__jaxNextBlobUrl = null; }
    if (prevBlobUrl) { URL.revokeObjectURL(prevBlobUrl); prevBlobUrl = null; window.__jaxPrevBlobUrl = null; }
    revokeAllBlobs();
    bgRoot = null; nullSrcStreak = 0;
    delete window.__jaxResetBlobs;
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
  };

  // eslint-disable-next-line no-console
  console.info("[jax-stream-swipe] loaded");
})();
