"""Jax Stream integration entry-point.

Wires together ImmichClient, JaxStreamCoordinator, and the image platform.
One config entry = one stream = one coordinator = one image entity.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import hashlib
import logging
import shutil
import types
from pathlib import Path
from typing import TYPE_CHECKING

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import (
    HomeAssistantError,
    ServiceNotFound,
    ServiceValidationError,
)
from homeassistant.helpers import entity_registry, config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    BATCH_SIZE,
    CONF_ALBUM_ID,
    CONF_ALLOW_INSECURE,
    CONF_API_KEY,
    CONF_INTERVAL,
    CONF_LANDSCAPE_ONLY,
    CONF_REMOVE_TO_ALBUM_ID,
    CONF_SHUFFLE,
    CONF_URL,
    DEFAULT_INTERVAL,
    DEFAULT_STREAM_SUBDIR,
    DOMAIN,
    JS_FILENAME,
    JS_ROUTE_PATH,
    CARD_FILENAME,
    CARD_ROUTE_PATH,
    SVG_FILENAME,
    SVG_ROUTE_PATH,
    RETRY_CAP,
    SERVICE_NEXT,
    SERVICE_PAUSE,
    SERVICE_PREVIOUS,
    SERVICE_REMOVE,
    SERVICE_RESUME,
    SERVICE_ROTATE,
    SERVICE_SET_RATING,
    SERVICE_TOUCH,
    ROTATE_ALLOWED_DELTAS,
    VA_DOMAIN,
    VIEW_ASSET_CLASS,
    VIEW_NAME,
)
from .coordinator import JaxStreamCoordinator
from .immich import ImmichClient

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

_LOGGER = logging.getLogger(__name__)

# Typed config entry alias: ConfigEntry[JaxStreamCoordinator].
# entry.runtime_data is JaxStreamCoordinator -- one per stream.

PLATFORMS: list[Platform] = [Platform.IMAGE, Platform.BUTTON, Platform.NUMBER, Platform.SELECT, Platform.SENSOR, Platform.SWITCH]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# Bundled view YAML shipped as package data (D-04/D-06).
# Path(__file__).parent resolves to custom_components/jax_stream/.
_SOURCE_VIEW = Path(__file__).parent / "views" / "jax-stream.yaml"


def _copy_view_yaml(src: Path, dest: Path) -> None:
    """Copy bundled view YAML into VA's views dir (blocking file I/O).
    dest.parent.mkdir handles the fresh-install case where VA has not yet
    created the jax-stream/ subdir. Runs in the executor (Pitfall 3)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dest))

# ---------------------------------------------------------------------------
# Service schemas
# ---------------------------------------------------------------------------

SCHEMA_STREAM_TARGET = vol.Schema(
    {
        vol.Optional("entity_id"): cv.entity_id,
        vol.Optional("stream"): cv.string,
    }
)

SCHEMA_SET_RATING = vol.Schema(
    {
        vol.Optional("entity_id"): cv.entity_id,
        vol.Optional("stream"): cv.string,
        vol.Required("rating"): vol.All(vol.Coerce(int), vol.Range(min=0, max=5)),
        vol.Optional("asset_id"): cv.string,
    }
)

SCHEMA_REMOVE = vol.Schema(
    {
        vol.Optional("entity_id"): cv.entity_id,
        vol.Optional("stream"): cv.string,
        vol.Optional("asset_id"): cv.string,
    }
)

SCHEMA_ROTATE = vol.Schema(
    {
        vol.Optional("entity_id"): cv.entity_id,
        vol.Optional("stream"): cv.string,
        # delta CW degrees: 90 = CW, 270 = CCW, 180 = flip
        vol.Required("angle"): vol.All(vol.Coerce(int), vol.In(ROTATE_ALLOWED_DELTAS)),
        vol.Optional("asset_id"): cv.string,
    }
)


def _compute_js_hash(path: str) -> str:
    """Return first 12 hex chars of sha256 of the file at path.

    Executor-safe (blocking I/O). Called via async_add_executor_job in async_setup.
    ASCII only -- no Unicode.
    """
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the jax_stream services once per domain.

    Called by HA before any config entries are loaded (standard two-step).
    Service handlers use a dual-path resolver: entity_id (via entity registry)
    or stream name (via hass.data[DOMAIN] dict populated in async_setup_entry).

    T-2-07: set_rating schema rejects out-of-range values before the handler runs.
    T-2-08: stream resolves via hass.data[DOMAIN] dict lookup (registered coordinators only).
    T-2-09: entity_id resolution requires a real config_entry_id.
    T-2-01: service data containing api_key is not accepted; api_key never logged.
    """
    hass.data.setdefault(DOMAIN, {})

    async def _resolve_coordinator(call: ServiceCall) -> JaxStreamCoordinator:
        """Resolve a coordinator from entity_id or stream name in service data."""
        entity_id = call.data.get("entity_id")
        if entity_id:
            er = entity_registry.async_get(hass)
            ref = er.async_get(entity_id)
            if not ref or not ref.config_entry_id:
                raise ServiceValidationError(
                    f"Entity {entity_id} not found or has no config entry"
                )
            cfg = hass.config_entries.async_get_entry(ref.config_entry_id)
            if not cfg or not getattr(cfg, "runtime_data", None):
                raise ServiceValidationError("Config entry not loaded")
            return cfg.runtime_data  # type: ignore[return-value]
        stream = call.data.get("stream")
        if stream:
            coord = hass.data.get(DOMAIN, {}).get(stream)
            if coord is None:
                raise ServiceValidationError(
                    f"No stream loaded for stream='{stream}'"
                )
            return coord  # type: ignore[return-value]
        raise ServiceValidationError("Provide entity_id (target) or stream (data)")

    async def handle_next(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        await coord.async_next()

    async def handle_previous(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        await coord.async_previous()

    async def handle_remove(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        asset_id = call.data.get("asset_id") or None
        await coord.async_remove(asset_id)

    async def handle_set_rating(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        rating = call.data["rating"]
        asset_id = call.data.get("asset_id") or None
        await coord.async_set_rating(rating, asset_id)

    async def handle_rotate(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        angle = call.data["angle"]
        asset_id = call.data.get("asset_id") or None
        await coord.async_rotate(angle, asset_id)

    async def handle_touch(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        await coord.async_touch()

    async def handle_pause(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        await coord.async_set_paused(True)

    async def handle_resume(call: ServiceCall) -> None:
        coord = await _resolve_coordinator(call)
        await coord.async_set_paused(False)

    hass.services.async_register(DOMAIN, SERVICE_NEXT, handle_next, schema=SCHEMA_STREAM_TARGET)
    hass.services.async_register(DOMAIN, SERVICE_PREVIOUS, handle_previous, schema=SCHEMA_STREAM_TARGET)
    hass.services.async_register(DOMAIN, SERVICE_REMOVE, handle_remove, schema=SCHEMA_REMOVE)
    hass.services.async_register(DOMAIN, SERVICE_SET_RATING, handle_set_rating, schema=SCHEMA_SET_RATING)
    hass.services.async_register(DOMAIN, SERVICE_ROTATE, handle_rotate, schema=SCHEMA_ROTATE)
    hass.services.async_register(DOMAIN, SERVICE_TOUCH, handle_touch, schema=SCHEMA_STREAM_TARGET)
    hass.services.async_register(DOMAIN, SERVICE_PAUSE, handle_pause, schema=SCHEMA_STREAM_TARGET)
    hass.services.async_register(DOMAIN, SERVICE_RESUME, handle_resume, schema=SCHEMA_STREAM_TARGET)

    # Phase 3 (FE-01): compute content hash, register static path, add module URL.
    # Runs once per domain per HA startup (before any async_setup_entry).
    # add_extra_js_url is SYNC -- no await. Hash compute is blocking I/O -- executor.
    js_path = str(Path(__file__).parent / JS_FILENAME)
    content_hash = await hass.async_add_executor_job(_compute_js_hash, js_path)

    await hass.http.async_register_static_paths([
        StaticPathConfig(
            url_path=JS_ROUTE_PATH,
            path=js_path,
            cache_headers=True,
        )
    ])

    add_extra_js_url(hass, f"{JS_ROUTE_PATH}?v={content_hash}")

    # Lovelace custom card: same serve+inject pattern as the kiosk module.
    # Loading via add_extra_js_url registers <jax-stream-card> on every frontend
    # page, so it appears in the Add-card picker with no manual resource step.
    card_path = str(Path(__file__).parent / CARD_FILENAME)
    card_hash = await hass.async_add_executor_job(_compute_js_hash, card_path)
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            url_path=CARD_ROUTE_PATH,
            path=card_path,
            cache_headers=True,
        )
    ])
    add_extra_js_url(hass, f"{CARD_ROUTE_PATH}?v={card_hash}")

    svg_path = str(Path(__file__).parent / SVG_FILENAME)
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            url_path=SVG_ROUTE_PATH,
            path=svg_path,
            cache_headers=True,
        )
    ])

    # Prefetch ring buffer: serve <config>/jax_stream/ at /jax_stream_data/ so
    # tests can fetch slot files for content-equality proofs (DoD: assert new
    # random.jpg hash equals a pre-recorded slot hash). No sensitive data lives here.
    jax_data_path = hass.config.path("jax_stream")
    await hass.async_add_executor_job(
        lambda: __import__("os").makedirs(jax_data_path, exist_ok=True)
    )
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            url_path="/jax_stream_data",
            path=jax_data_path,
            cache_headers=False,  # slot files change; no caching
        )
    ])

    return True


async def async_setup_entry(hass: HomeAssistant, entry: "ConfigEntry") -> bool:
    """Set up a Jax Stream config entry.

    Builds the ImmichClient + JaxStreamCoordinator on the shared session,
    does the first refresh, stores the coordinator on entry.runtime_data,
    registers the stream in hass.data for service resolution,
    and forwards the image + button + select + switch platforms.

    Open Q1 resolution (RESEARCH A3): {**entry.data, **entry.options} merge
    so options-flow edits win over entry.data values after a reload.
    """
    # Merge data + options so options-flow edits take effect on reload.
    # T-01-03: never log merged -- it contains the api_key.
    merged = {**entry.data, **entry.options}

    allow_insecure = merged.get(CONF_ALLOW_INSECURE, False)

    # D-08 seam: verify_ssl is derived from allow_insecure (Pattern 5).
    # Do NOT pass verify_ssl to ImageEntity -- that is a different SSL context (Pitfall 6).
    session = async_get_clientsession(hass, verify_ssl=not allow_insecure)

    client = ImmichClient(session, merged[CONF_URL], merged[CONF_API_KEY])

    # Build a settings namespace carrying runtime tunables to the coordinator.
    # stream_subdir defaults to DEFAULT_STREAM_SUBDIR ("default") so the live
    # VA rotate_background_path keeps working with zero VA changes (Pitfall 5 / A2).
    # Slugified per-stream subdirs are deferred to Phase 4 (D-05 out of scope now).
    # remove_to_album_id: optional per-stream recovery album (D-10). Merged options win.
    settings = types.SimpleNamespace(
        album_id=merged[CONF_ALBUM_ID],
        landscape=merged.get(CONF_LANDSCAPE_ONLY, True),
        interval=int(merged.get(CONF_INTERVAL, DEFAULT_INTERVAL)),
        batch_size=BATCH_SIZE,
        retry_cap=RETRY_CAP,
        stream_subdir=DEFAULT_STREAM_SUBDIR,  # fixed; per-stream subdirs deferred to backlog (D-08)
        remove_to_album_id=merged.get(CONF_REMOVE_TO_ALBUM_ID) or None,
        shuffle=merged.get(CONF_SHUFFLE, True),
    )

    coordinator = JaxStreamCoordinator(hass, entry, client, settings)

    # _async_setup seeds last-good bytes from on-disk random.jpg (D-13) so there is no
    # blank flash on HA restart. async_config_entry_first_refresh then fetches a fresh photo.
    await coordinator.async_config_entry_first_refresh()

    # Store on entry.runtime_data (State-of-the-Art).
    entry.runtime_data = coordinator

    # Phase 4: VIEW-01 -- auto-copy + register the jax-stream view in VA.
    # Best-effort (D-03/D-07): never kill the config entry; engine + entities
    # work without the view. Always-overwrite (D-04): integration is source of truth.
    dest_view = Path(
        hass.config.path("view_assist", "views", "jax-stream", "jax-stream.yaml")
    )
    try:
        await hass.async_add_executor_job(_copy_view_yaml, _SOURCE_VIEW, dest_view)
        try:
            await hass.services.async_call(
                VA_DOMAIN,
                "load_asset",
                {
                    "asset_class": VIEW_ASSET_CLASS,
                    "name": VIEW_NAME,
                    "download_from_repo": False,
                },
                blocking=True,
            )
        except ServiceNotFound as exc:
            _LOGGER.warning("jax_stream: view_assist.load_asset not available: %s", exc)
        except HomeAssistantError:
            # VA's known 500-on-success: the view IS registered before this
            # fires (VA's GitHub version check fails -- jax-stream is not upstream).
            pass
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("jax_stream: view_assist.load_asset raised unexpected: %s", exc)
    except Exception as exc:  # noqa: BLE001
        _LOGGER.warning("jax_stream: view delivery failed: %s", exc)

    # Register the stream in hass.data for service-name resolution (T-2-08).
    # Service handlers resolve coordinator by stream=stream_subdir via this dict.
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][settings.stream_subdir] = coordinator

    # Cancel any in-flight backfill task on entry unload so it doesn't outlive
    # the coordinator (Phase 1 prefetch-window-restore).
    def _cancel_backfill() -> None:
        task = coordinator._backfill_task
        if task and not task.done():
            task.cancel()
    entry.async_on_unload(_cancel_backfill)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: "ConfigEntry") -> bool:
    """Unload a Jax Stream config entry."""
    # Pop the stream from the resolver registry before unloading platforms.
    hass.data.get(DOMAIN, {}).pop(entry.runtime_data.settings.stream_subdir, None)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
