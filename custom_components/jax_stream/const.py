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

# ---------------------------------------------------------------------------
# Phase 3: frontend module delivery (FE-01, D-04)
# Namespaced static route served by async_register_static_paths.
# Must not start with /local (that is HA's www mount).
# ASCII only -- no Unicode.
# ---------------------------------------------------------------------------
JS_FILENAME   = "jax_stream.js"
JS_ROUTE_PATH = "/jax_stream_frontend/jax_stream.js"

# ---------------------------------------------------------------------------
# Phase 4: VA view delivery constants (VIEW-01, D-07, D-08)
# ---------------------------------------------------------------------------
# VA integration domain -- stable across VA versions (VA 2026.6.0 const.py)
VA_DOMAIN = "view_assist"
# AssetClass.VIEW value in VA assets/views.py -- matches the "views" dir
VIEW_ASSET_CLASS = "views"
# View directory name and path segment -- matches the live deployment path
VIEW_NAME = "jax-stream"
