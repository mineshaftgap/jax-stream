/*
 * Jax Stream -- Lovelace custom card (jax-stream-card)
 *
 * Mirrors the on-device viewing experience from any HA dashboard using
 * HA-native controls (no gestures, no emulation). Shows the live photo plus
 * next/prev, pause, rate, rotate, and remove.
 *
 * It does NOT reimplement rendering: it resolves the stream's entities from the
 * device registry and composes built-in cards (picture-entity / button /
 * entities) via loadCardHelpers, so styling and behavior match stock HA.
 *
 * Served at /jax_stream_frontend/jax_stream_card.js and loaded via
 * add_extra_js_url, so it registers in the Add-card picker with no manual
 * Lovelace resource step. ASCII only.
 */
(function () {
  "use strict";

  var CARD_VERSION = "0.1.0";

  // Cache the loadCardHelpers() promise so concurrent rebuilds share one load
  // (no spamming the import, no dropped builds).
  function cardHelpers() {
    if (!cardHelpers._p) cardHelpers._p = window.loadCardHelpers();
    return cardHelpers._p;
  }

  function deviceImage(hass) {
    // Prefer an image entity owned by the jax_stream platform; fall back to the
    // jax_stream_* slug if the entity registry is unavailable.
    var ents = hass.entities || {};
    var keys = Object.keys(hass.states);
    var byPlatform = keys.filter(function (e) {
      return e.indexOf("image.") === 0 && ents[e] && ents[e].platform === "jax_stream";
    });
    if (byPlatform.length) return byPlatform[0];
    var bySlug = keys.filter(function (e) {
      return e.indexOf("image.jax_stream") === 0 && e.indexOf("_image") === -1;
    });
    return bySlug.length ? bySlug[0] : null;
  }

  // Resolve every control entity for the stream that owns `image`. Grouped by
  // the device the image belongs to (robust to the stream slug), then bucketed
  // by domain + the auto-generated object_id tokens.
  function resolve(hass, image) {
    var out = { image: image };
    if (!image) return out;
    var ents = hass.entities || {};
    var deviceId = ents[image] ? ents[image].device_id : null;

    var siblings = Object.keys(hass.states).filter(function (e) {
      if (deviceId && ents[e] && ents[e].device_id) return ents[e].device_id === deviceId;
      // Fallback when the registry is not exposed: share the jax_stream_<name> prefix.
      var slug = image.slice(image.indexOf(".") + 1);
      var stem = slug.split("_").slice(0, 3).join("_"); // e.g. jax_stream_default
      return e.slice(e.indexOf(".") + 1).indexOf(stem) === 0;
    });

    function domain(d) {
      return siblings.filter(function (e) { return e.indexOf(d + ".") === 0; });
    }
    var buttons = domain("button");
    function pick(frag) {
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].indexOf(frag) !== -1) return buttons[i];
      }
      return null;
    }
    out.previous = pick("previous");
    out.remove = pick("remove");
    out.rotateCcw = pick("counter");
    out.rotateCw = (function () {
      for (var i = 0; i < buttons.length; i++) {
        var e = buttons[i];
        if (e.indexOf("clockwise") !== -1 && e.indexOf("counter") === -1) return e;
      }
      return null;
    })();
    // Next photo is the bare-slug button (no suffix) -- whatever is left over.
    out.next = (function () {
      for (var i = 0; i < buttons.length; i++) {
        var e = buttons[i];
        if (e !== out.previous && e !== out.remove && e !== out.rotateCw && e !== out.rotateCcw) return e;
      }
      return null;
    })();

    var numbers = domain("number");
    out.rating = (function () {
      for (var i = 0; i < numbers.length; i++) {
        if (numbers[i].indexOf("rating") !== -1) return numbers[i];
      }
      return numbers.length ? numbers[0] : null;
    })();
    out.album = domain("select")[0] || null;
    out.pause = domain("switch")[0] || null;
    var sensors = domain("sensor");
    out.current = (function () {
      for (var i = 0; i < sensors.length; i++) {
        if (sensors[i].indexOf("current") !== -1) return sensors[i];
      }
      return null;
    })();
    return out;
  }

  function pressBtn(name, icon, entity) {
    return {
      type: "button",
      name: name,
      icon: icon,
      tap_action: {
        action: "perform-action",
        perform_action: "button.press",
        target: { entity_id: entity }
      }
    };
  }

  // The six button controls, in default order, with their display labels/icons.
  // The config `controls` list (and the visual editor) reorders/filters these by
  // key; `layout` decides how the chosen buttons are arranged.
  var CONTROL_KEYS = ["previous", "pause", "next", "rotate_ccw", "rotate_cw", "remove"];
  var CONTROL_LABELS = {
    previous: "Back", pause: "Pause", next: "Next",
    rotate_ccw: "Rotate left", rotate_cw: "Rotate right", remove: "Remove"
  };

  // Build the single button card for a control key, or null if its entity is
  // missing from the resolved set.
  function controlCard(key, ids) {
    switch (key) {
      case "previous": return ids.previous ? pressBtn("Back", "mdi:skip-previous", ids.previous) : null;
      case "next": return ids.next ? pressBtn("Next", "mdi:skip-next", ids.next) : null;
      case "pause": return ids.pause ? { type: "button", entity: ids.pause, name: "Pause", icon: "mdi:pause-circle" } : null;
      case "rotate_ccw": return ids.rotateCcw ? pressBtn("Rotate left", "mdi:rotate-left", ids.rotateCcw) : null;
      case "rotate_cw": return ids.rotateCw ? pressBtn("Rotate right", "mdi:rotate-right", ids.rotateCw) : null;
      case "remove":
        if (!ids.remove) return null;
        var rm = pressBtn("Remove", "mdi:trash-can", ids.remove);
        rm.tap_action.confirmation = { text: "Remove this photo from the album?" };
        return rm;
      default: return null;
    }
  }

  function composition(ids, cfg) {
    cfg = cfg || {};
    var cards = [
      {
        type: "picture-entity",
        entity: ids.image,
        show_name: false,
        show_state: false,
        tap_action: { action: "more-info" }
      }
    ];

    // Resolve the ordered control list (config wins; default = all six in order).
    var order = (cfg.controls && cfg.controls.length) ? cfg.controls : CONTROL_KEYS;
    var btns = order
      .map(function (k) { return controlCard(k, ids); })
      .filter(Boolean);

    var layout = cfg.layout || "rows";
    if (layout === "single") {
      if (btns.length) cards.push({ type: "horizontal-stack", cards: btns });
    } else if (layout === "list") {
      btns.forEach(function (b) { cards.push(b); });
    } else { // "rows" -- chunk into horizontal rows of 3
      for (var i = 0; i < btns.length; i += 3) {
        cards.push({ type: "horizontal-stack", cards: btns.slice(i, i + 3) });
      }
    }

    var rows = [];
    if (cfg.show_rating !== false && ids.rating) rows.push({ entity: ids.rating, name: "Rating" });
    if (cfg.show_album !== false && ids.album) rows.push({ entity: ids.album, name: "Album" });
    if (cfg.show_current !== false && ids.current) rows.push({ entity: ids.current, name: "Current photo" });
    if (rows.length) cards.push({ type: "entities", entities: rows });

    return { type: "vertical-stack", cards: cards };
  }

  class JaxStreamCard extends HTMLElement {
    setConfig(config) {
      this._config = config || {};
      this._inner = null; // force rebuild on next hass
      this.innerHTML = "";
      if (this._hass) this._build();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._inner) {
        this._build();
      } else {
        this._inner.hass = hass;
      }
    }

    _error(msg) {
      this.innerHTML = "";
      var card = document.createElement("ha-card");
      card.setAttribute("header", "Jax Stream");
      var div = document.createElement("div");
      div.style.padding = "16px";
      div.textContent = msg;
      card.appendChild(div);
      this.appendChild(card);
    }

    _build() {
      var self = this;
      var image = this._config.entity || deviceImage(this._hass);
      if (!image) {
        this._error("No Jax Stream image entity found. Set 'entity:' to your stream's image entity.");
        return;
      }
      // Capture this call's cfg; the latest-resolving build wins. No _building
      // early-return -- that could swallow a rebuild after a config edit and
      // leave the preview stale.
      var cfg = composition(resolve(this._hass, image), this._config);
      cardHelpers().then(function (helpers) {
        var el = helpers.createCardElement(cfg);
        el.hass = self._hass;
        self.innerHTML = "";
        self.appendChild(el);
        self._inner = el;
      }).catch(function (err) {
        self._error("Failed to build card: " + (err && err.message ? err.message : err));
      });
    }

    getCardSize() { return 7; }

    static getConfigElement() {
      return document.createElement("jax-stream-card-editor");
    }

    static getStubConfig(hass) {
      var image = deviceImage(hass);
      var cfg = {
        layout: "rows",
        controls: CONTROL_KEYS.slice(),
        show_rating: true,
        show_album: true,
        show_current: true
      };
      if (image) cfg.entity = image;
      return cfg;
    }
  }

  customElements.define("jax-stream-card", JaxStreamCard);

  // -------------------------------------------------------------------------
  // Visual editor (removes "Visual editor not supported"). The button order is
  // a real drag-to-reorder list (with show/hide checkboxes); everything else
  // (image entity, layout, info rows) is a stock ha-form. The button order the
  // user drags is persisted as the `controls` key list (order = render order).
  // -------------------------------------------------------------------------
  var EDITOR_SCHEMA = [
    { name: "entity", selector: { entity: { domain: "image" } } },
    {
      name: "layout",
      selector: {
        select: {
          mode: "dropdown",
          options: [
            { value: "rows", label: "Buttons in rows of three" },
            { value: "single", label: "All buttons in one row" },
            { value: "list", label: "Buttons stacked vertically" }
          ]
        }
      }
    },
    // Top-level booleans (NOT wrapped in a `type:"grid"` -- a grid nests the
    // values under the group name, so the card's top-level cfg.show_* reads
    // never saw them and the preview did not update).
    { name: "show_rating", selector: { boolean: {} } },
    { name: "show_album", selector: { boolean: {} } },
    { name: "show_current", selector: { boolean: {} } }
  ];
  var EDITOR_LABELS = {
    entity: "Image entity (leave empty to auto-detect)",
    layout: "Button layout",
    show_rating: "Rating row",
    show_album: "Album row",
    show_current: "Current-photo row"
  };
  var EDITOR_STYLE =
    ".jsc-title{font-size:.9em;color:var(--secondary-text-color);margin:4px 0 8px}" +
    ".jsc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;" +
    "border:1px solid var(--divider-color);border-radius:6px;" +
    "background:var(--card-background-color,var(--ha-card-background));cursor:grab}" +
    ".jsc-row.jsc-dragging{opacity:.4}" +
    ".jsc-row.jsc-over-before{border-top:2px solid var(--primary-color)}" +
    ".jsc-row.jsc-over-after{border-bottom:2px solid var(--primary-color)}" +
    ".jsc-handle{color:var(--secondary-text-color);cursor:grab}" +
    ".jsc-label{flex:1}" +
    ".jsc-controls{margin-bottom:16px}";

  class JaxStreamCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = Object.assign({}, config || {});
      this._deriveOrder();
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
    }

    // Compute the working order + checked-state from config.controls. Skip when
    // the incoming config is the echo of our own last emit (so a round-trip does
    // not clobber the user's in-place hidden buttons or interrupt a drag).
    _deriveOrder() {
      var ctrl = this._config.controls;
      if (this._lastControls != null && (ctrl || []).join(",") === this._lastControls) return;
      var inc = (ctrl && ctrl.length) ? ctrl.slice() : CONTROL_KEYS.slice();
      inc = inc.filter(function (k) { return CONTROL_KEYS.indexOf(k) !== -1; });
      var rest = CONTROL_KEYS.filter(function (k) { return inc.indexOf(k) === -1; });
      this._order = inc.concat(rest);
      this._checked = {};
      var self = this;
      this._order.forEach(function (k) { self._checked[k] = inc.indexOf(k) !== -1; });
      this._needRows = true;
    }

    _render() {
      var self = this;
      if (!this._built) {
        this._built = true;
        var style = document.createElement("style");
        style.textContent = EDITOR_STYLE;
        this.appendChild(style);

        this._section = document.createElement("div");
        this._section.className = "jsc-controls";
        this.appendChild(this._section);

        this._form = document.createElement("ha-form");
        this._form.computeLabel = function (schema) {
          return EDITOR_LABELS[schema.name] || schema.name;
        };
        this._form.addEventListener("value-changed", function (ev) {
          ev.stopPropagation();
          self._config = Object.assign({}, self._config, ev.detail.value || {});
          self._emit();
        });
        window.loadCardHelpers && window.loadCardHelpers();
        this.appendChild(this._form);
      }

      if (this._needRows) { this._buildRows(); this._needRows = false; }
      if (this._hass) this._form.hass = this._hass;
      this._form.schema = EDITOR_SCHEMA;
      this._form.data = this._config;
    }

    _buildRows() {
      var self = this;
      this._section.innerHTML = "";
      var title = document.createElement("div");
      title.className = "jsc-title";
      title.textContent = "Buttons -- drag to reorder, uncheck to hide";
      this._section.appendChild(title);

      this._order.forEach(function (key) {
        var row = document.createElement("div");
        row.className = "jsc-row";
        row.draggable = true;
        row.dataset.key = key;

        var handle = document.createElement("ha-icon");
        handle.setAttribute("icon", "mdi:drag");
        handle.className = "jsc-handle";

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!self._checked[key];
        cb.addEventListener("change", function () {
          self._checked[key] = cb.checked;
          self._emit();
        });
        // Don't let a checkbox click start a row drag.
        cb.addEventListener("dragstart", function (ev) { ev.preventDefault(); ev.stopPropagation(); });

        var label = document.createElement("span");
        label.className = "jsc-label";
        label.textContent = CONTROL_LABELS[key];

        row.appendChild(handle);
        row.appendChild(cb);
        row.appendChild(label);

        row.addEventListener("dragstart", function (ev) {
          self._dragKey = key;
          row.classList.add("jsc-dragging");
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = "move";
            try { ev.dataTransfer.setData("text/plain", key); } catch (e) { /* IE guard */ }
          }
        });
        row.addEventListener("dragend", function () {
          row.classList.remove("jsc-dragging");
        });
        row.addEventListener("dragover", function (ev) {
          ev.preventDefault();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
          var rect = row.getBoundingClientRect();
          var after = (ev.clientY - rect.top) > rect.height / 2;
          row.classList.toggle("jsc-over-after", after);
          row.classList.toggle("jsc-over-before", !after);
        });
        row.addEventListener("dragleave", function () {
          row.classList.remove("jsc-over-after", "jsc-over-before");
        });
        row.addEventListener("drop", function (ev) {
          ev.preventDefault();
          row.classList.remove("jsc-over-after", "jsc-over-before");
          var from = self._dragKey;
          if (!from || from === key) return;
          var rect = row.getBoundingClientRect();
          var after = (ev.clientY - rect.top) > rect.height / 2;
          self._reorder(from, key, after);
        });

        self._section.appendChild(row);
      });
    }

    _reorder(fromKey, toKey, after) {
      var order = this._order.slice();
      order.splice(order.indexOf(fromKey), 1);
      var ti = order.indexOf(toKey);
      order.splice(after ? ti + 1 : ti, 0, fromKey);
      this._order = order;
      this._buildRows();
      this._emit();
    }

    _emit() {
      var self = this;
      var controls = this._order.filter(function (k) { return self._checked[k]; });
      this._lastControls = controls.join(",");
      this._config = Object.assign({}, this._config, { controls: controls });
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true
      }));
    }
  }

  customElements.define("jax-stream-card-editor", JaxStreamCardEditor);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "jax-stream-card",
    name: "Jax Stream",
    description: "Watch and control a Jax Stream slideshow -- live photo plus next/prev, pause, rate, rotate, and remove.",
    preview: true,
    documentationURL: "https://github.com/mineshaftgap/jax-stream"
  });

  // eslint-disable-next-line no-console
  console.info("%c JAX-STREAM-CARD %c " + CARD_VERSION + " ", "background:#222;color:#7cf", "background:#7cf;color:#222");
})();
