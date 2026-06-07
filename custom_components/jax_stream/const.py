"""Constants for the Jax Stream integration.

Ported from shell_scripts/jax_stream_action.sh v41 engine defaults.
ASCII only -- no Unicode.
"""
import re

DOMAIN = "jax_stream"

# ---------------------------------------------------------------------------
# Config-entry keys (used by config_flow.py and coordinator.py)
# ---------------------------------------------------------------------------
CONF_NAME = "name"
CONF_URL = "url"
CONF_API_KEY = "api_key"
CONF_ALBUM_ID = "album_id"
CONF_INTERVAL = "interval"
CONF_LANDSCAPE_ONLY = "landscape_only"
CONF_ALLOW_INSECURE = "allow_insecure"

# ---------------------------------------------------------------------------
# Engine constants -- ported verbatim from v41
# ---------------------------------------------------------------------------
# v41 JAX_BATCH_SIZE (line 60): over-fetch size for the landscape filter pass
BATCH_SIZE = 25

# v41 JAX_RETRY_CAP (line 61): max batch attempts before giving up
RETRY_CAP = 4

# v41 thumbnail size parameter (line 245): "preview" yields the large JPEG
THUMB_SIZE = "preview"

# v41 download_asset save quality (line 252)
JPEG_QUALITY = 95

# ---------------------------------------------------------------------------
# Interval bounds for the config-flow NumberSelector
# ---------------------------------------------------------------------------
DEFAULT_INTERVAL = 60     # seconds; v41 default refresh cadence
MIN_INTERVAL = 10
MAX_INTERVAL = 3600

# ---------------------------------------------------------------------------
# Disk-path constants (mirrors v41 JAX_BASE_DIR / rotate_background_path)
# ---------------------------------------------------------------------------
# Default stream subdir: must match the live VA rotate_background_path (Pitfall 5)
DEFAULT_STREAM_SUBDIR = "default"

# Path segments joined via hass.config.path() -- never hardcode /config
DISK_PATH_SEGMENTS = ("view_assist", "images", "jax-stream")

# Final filename written under the stream subdir
DISK_FILENAME = "random.jpg"

# ---------------------------------------------------------------------------
# Security: path-traversal guard (port of v41 lines 112-116)
# Stream subdir must match [A-Za-z0-9_-]+ before being joined into a disk path.
# ---------------------------------------------------------------------------
STREAM_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# ---------------------------------------------------------------------------
# Phase 2: bridge file names (D-05, D-11, D-16)
# Coordinator keeps writing these so the unchanged jaxmenu JS keeps polling
# pause/rate state until Phase 3 rewires reads onto entity state.
# ---------------------------------------------------------------------------
BRIDGE_CURRENT_TXT  = "current.txt"
BRIDGE_PAUSE_MANUAL = "pause_manual.txt"
BRIDGE_PAUSE_TOUCH  = "pause_touch.txt"
BRIDGE_RATE_CURRENT = "rate_current.txt"
BRIDGE_RATE_PENDING = "rate_pending.txt"

# ---------------------------------------------------------------------------
# Phase 2: pause gate (D-06) -- port of v41 90s post-touch suppression window
# ---------------------------------------------------------------------------
TOUCH_WINDOW_SECONDS = 90

# ---------------------------------------------------------------------------
# Phase 2: options config key (D-10) -- per-stream recovery album,
# direct port of v41 REMOVE_TO_ALBUM_ID (swipe.conf)
# ---------------------------------------------------------------------------
CONF_REMOVE_TO_ALBUM_ID = "remove_to_album_id"

# ---------------------------------------------------------------------------
# Phase 2: service names (registered in __init__.async_setup)
# ---------------------------------------------------------------------------
SERVICE_REFRESH    = "refresh"
SERVICE_NEXT       = "next"
SERVICE_REMOVE     = "remove"
SERVICE_SET_RATING = "set_rating"
SERVICE_TOUCH      = "touch"
SERVICE_PAUSE      = "pause"
SERVICE_RESUME     = "resume"
SERVICE_ROTATE     = "rotate"

# ---------------------------------------------------------------------------
# Photo rotate (Immich non-destructive edit). Verified against live Immich
# 2.5.6 (probe 2026-06-07 -- see DEVEL/immich-api.md "Non-destructive rotate"):
#   - PUT /api/assets/{id}/edits {"edits":[{"action":"rotate",...}]} needs
#     the asset.edit.create scope; angle is ABSOLUTE (replaceAll semantics).
#   - The rotated rendition is served ONLY via ?edited=true; the plain
#     /thumbnail?size=preview always returns the ORIGINAL orientation.
#   - Regen is async (worker queue; ~2.5s observed) -- poll edited=true until
#     the bytes change, capped by ROTATE_REGEN_TIMEOUT_S.
# Menu sends a delta (90 = CW, 270 = CCW); the coordinator tracks the
# absolute angle per asset in memory (asset.edit.read is not granted, so the
# current edit cannot be read back from the server).
# ---------------------------------------------------------------------------
ROTATE_ALLOWED_DELTAS = (90, 180, 270)
ROTATE_REGEN_TIMEOUT_S = 6.0
ROTATE_REGEN_POLL_S = 0.5

# ---------------------------------------------------------------------------
# Phase 3: frontend module delivery (FE-01, D-04)
# Namespaced static route served by async_register_static_paths.
# Must not start with /local (that is HA's www mount).
# ASCII only -- no Unicode.
# ---------------------------------------------------------------------------
JS_FILENAME   = "jax_stream.js"
JS_ROUTE_PATH = "/jax_stream_frontend/jax_stream.js"

# ---------------------------------------------------------------------------
# Prefetch ring buffer (Phase 1 of prefetch-window-restore)
# ---------------------------------------------------------------------------
# N future slots pre-downloaded. ring_size = N + 1 (N future + 1 current).
DEFAULT_PREFETCH_COUNT = 3
CONF_PREFETCH_COUNT = "prefetch_count"

# Max total attempts per backfill task before giving up (avoids infinite retries
# when Immich is down). Next kick (on next advance) will retry fresh.
BACKFILL_RETRY_CAP = 6

# JPEG SOI magic bytes used to validate slot files before promoting.
JPEG_MAGIC = b"\xff\xd8\xff"

# Phase 4 (past-window): past slots retained for reload-resilient back-nav.
# M past frames are stored so a freshly-reloaded client can recover back-nav
# history even after the in-memory blob cache is cleared.
# ring_size = N + 1 + M (N future + 1 current + M past).
DEFAULT_PAST_COUNT = 2
CONF_PAST_COUNT = "past_count"

# ---------------------------------------------------------------------------
# Phase 4: VA view delivery constants (VIEW-01, D-07, D-08)
# ---------------------------------------------------------------------------
# VA integration domain -- stable across VA versions (VA 2026.6.0 const.py)
VA_DOMAIN = "view_assist"
# AssetClass.VIEW value in VA assets/views.py -- matches the "views" dir
VIEW_ASSET_CLASS = "views"
# View directory name and path segment -- matches the live deployment path
VIEW_NAME = "jax-stream"
