"""DataUpdateCoordinator for Jax Stream.

Drives the timed fetch loop (CORE-03):
  1. Fetch one landscape asset ID via ImmichClient.random_landscape
  2. Download thumbnail bytes via ImmichClient.download_thumbnail
  3. Run PIL EXIF transpose + JPEG encode in the executor (Pillow blocking C call)
  4. Atomically write random.jpg to the v41 disk path in the executor (disk I/O)
  5. Bump image_bytes + image_last_updated so the ImageEntity state changes

Keeps the last-good photo on Immich failure (D-12, "never blank").
Seeds last-good bytes from on-disk random.jpg on restart (D-13).
Guards the stream subdir against path traversal (Security V5).

ASCII only -- no Unicode.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import timedelta
from io import BytesIO
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import (
    BRIDGE_CURRENT_TXT,
    BRIDGE_PAUSE_MANUAL,
    BRIDGE_PAUSE_TOUCH,
    BRIDGE_RATE_CURRENT,
    BRIDGE_RATE_PENDING,
    DEFAULT_STREAM_SUBDIR,
    DISK_FILENAME,
    DISK_PATH_SEGMENTS,
    DOMAIN,
    JPEG_QUALITY,
    STREAM_NAME_RE,
    TOUCH_WINDOW_SECONDS,
)
from .immich import ImmichError, ImmichClient, NoLandscapeSurvivor

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Executor helpers (blocking C / disk -- run via async_add_executor_job)
# ---------------------------------------------------------------------------


def _transpose_jpeg(raw: bytes) -> bytes:
    """EXIF-transpose raw JPEG bytes and re-encode at JPEG_QUALITY.

    Port of v41 download_asset lines 247-254 (PIL block).
    Must run in the executor -- Image.open + exif_transpose + save are
    synchronous C calls that block the event loop (Pitfall 2).
    """
    from PIL import Image, ImageOps  # Pillow; pinned in manifest.json

    img = Image.open(BytesIO(raw))
    img = ImageOps.exif_transpose(img)           # bake orientation in (matches v41)
    buf = BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY)  # exact v41 format (D-02)
    return buf.getvalue()


def _atomic_write(dest: str, data: bytes) -> None:
    """Write data to dest atomically via a .tmp intermediate.

    Port of v41 atomic mv pattern (download_asset line 255, write_id line 262).
    The LineageOS WebView CSS background-image must never read a partial JPEG.
    Must run in the executor -- file I/O is blocking (Pitfall 2).
    """
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, dest)   # atomic rename; atomic so the view reads complete files


def _remove_if_exists(path: str) -> None:
    """Remove path if present; no error if absent. Executor-only (blocking I/O)."""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _read_if_exists(path: str) -> bytes | None:
    """Return file bytes if path exists, else None.

    Used by _async_setup to seed last-good bytes from the on-disk random.jpg
    so there is no blank flash across an HA restart (D-13).
    Must run in the executor -- file I/O is blocking (Pitfall 2).
    """
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Coordinator
# ---------------------------------------------------------------------------


class JaxStreamCoordinator(DataUpdateCoordinator[bytes]):
    """Fetch loop + disk-write shim for one Jax Stream config entry.

    One instance per config entry (stream).  Drives CORE-03 (timed fetch)
    and the D-01/D-02 disk-write bridge that keeps the live LineageOS devices
    working through the migration with zero VA changes.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        entry: "ConfigEntry",
        client: ImmichClient,
        settings: object,
    ) -> None:
        """Set up the coordinator.

        Args:
            hass:     Home Assistant instance.
            entry:    The config entry this coordinator belongs to.
            client:   Constructed ImmichClient (session + host + api_key).
            settings: Object with attributes:
                        interval (int seconds),
                        stream_subdir (str, default "default"),
                        album_id (str),
                        landscape (bool),
                        batch_size (int),
                        retry_cap (int).
        """
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            config_entry=entry,
            update_interval=timedelta(seconds=settings.interval),
        )
        self.client = client
        self.settings = settings

        # Volatile state shared with image.py
        self.image_bytes: bytes | None = None
        self.image_last_updated = None   # datetime | None

        # Security V5 / T-01-01: validate stream subdir before joining into a path.
        # Port of v41 lines 112-116 which reject names not matching [A-Za-z0-9_-]+.
        stream_subdir = getattr(settings, "stream_subdir", DEFAULT_STREAM_SUBDIR) or DEFAULT_STREAM_SUBDIR
        if not STREAM_NAME_RE.match(stream_subdir):
            raise ValueError(
                f"Invalid stream subdir {stream_subdir!r}: must match [A-Za-z0-9_-]+"
            )

        # Build the disk path once using hass.config.path (never hardcode /config).
        self.disk_path: str = hass.config.path(
            *DISK_PATH_SEGMENTS, stream_subdir, DISK_FILENAME
        )

        # Phase 2 pause-gate state (D-05/D-06/D-07/D-08). Three-state v41 model:
        #   _manual_paused  -> pause_manual.txt (indefinite hold)
        #   _touch_deadline -> pause_touch.txt  (wall-clock epoch; 0 = not armed)
        self._manual_paused: bool = False
        self._touch_deadline: float = 0.0
        self._force_refresh: bool = False          # explicit-call gate bypass (Pitfall 2)
        self.current_asset_id: str | None = None
        self._current_rating: int = 0
        # Bridge files live in the same validated dir as random.jpg (subdir already
        # passed STREAM_NAME_RE above -- Security V5; no new path-traversal surface).
        self._bridge_dir: str = os.path.dirname(self.disk_path)

    async def _async_setup(self) -> None:
        """D-13: seed last-good bytes from on-disk random.jpg before the first refresh.

        Eliminates the blank-flash on HA restart: the entity serves the previous
        photo immediately while the first coordinator tick fetches a new one.
        """
        seeded = await self.hass.async_add_executor_job(_read_if_exists, self.disk_path)
        if seeded:
            self.image_bytes = seeded
            self.image_last_updated = dt_util.utcnow()

    async def _async_update_data(self) -> bytes:
        """Fetch one landscape photo, transpose, write to disk, return bytes.

        D-07: gate check at top. When manual-paused or inside the 90s touch
        window, skip the advance entirely; return last-good bytes unchanged.
        D-12 keep-last-good: on Immich failure, log a warning and return the
        last-good bytes rather than raising UpdateFailed.  Only raise on the
        cold-start case where there is nothing at all to show (prevents flapping
        the entity to unavailable and blanking the screen -- Pitfall 1).
        """
        force = self._force_refresh
        self._force_refresh = False  # consume immediately so the next timer tick re-checks
        if not force:
            now = time.time()
            in_window = self._touch_deadline > 0 and now < self._touch_deadline
            if self._manual_paused or in_window:
                _LOGGER.debug(
                    "Gate active (manual=%s window=%s); skipping advance (D-07)",
                    self._manual_paused, in_window,
                )
                return self.image_bytes or b""

        try:
            asset_id = await self.client.random_landscape(self.settings)
            raw = await self.client.download_thumbnail(asset_id)

            # PIL encode and file write are blocking -- run in the thread pool
            jpeg = await self.hass.async_add_executor_job(_transpose_jpeg, raw)
            await self.hass.async_add_executor_job(_atomic_write, self.disk_path, jpeg)

            # D-11: prefetch current asset id + rating; write bridge files.
            self.current_asset_id = asset_id
            await self.hass.async_add_executor_job(
                _atomic_write, os.path.join(self._bridge_dir, BRIDGE_CURRENT_TXT),
                f"{asset_id}\n".encode(),
            )
            try:
                rating = await self.client.get_asset_rating(asset_id)
            except ImmichError:
                rating = 0  # non-fatal; overlay opens with 0 stars
            self._current_rating = rating
            await self.hass.async_add_executor_job(
                _atomic_write, os.path.join(self._bridge_dir, BRIDGE_RATE_CURRENT),
                f"{rating}\n".encode(),
            )
            await self.hass.async_add_executor_job(
                _atomic_write, os.path.join(self._bridge_dir, BRIDGE_RATE_PENDING),
                f"{int(time.time())}\n".encode(),
            )

            self.image_bytes = jpeg
            self.image_last_updated = dt_util.utcnow()  # CORE-04: bump -> entity state change
            return jpeg

        except (ImmichError, NoLandscapeSurvivor) as err:
            # D-12: never blank. Keep last-good bytes, stay available, log, do not raise.
            _LOGGER.warning("Jax Stream refresh failed, keeping last photo: %s", err)
            if self.image_bytes is None:
                # Cold-start with no disk seed and no fetched photo -- nothing to show.
                raise UpdateFailed(str(err)) from err
            return self.image_bytes

    # -----------------------------------------------------------------------
    # Phase 2 action methods (D-06 through D-12)
    # -----------------------------------------------------------------------

    async def _write_pause_bridge(self) -> None:
        """Sync pause_manual.txt to _manual_paused; sync pause_touch.txt to _touch_deadline (D-05)."""
        manual_path = os.path.join(self._bridge_dir, BRIDGE_PAUSE_MANUAL)
        touch_path  = os.path.join(self._bridge_dir, BRIDGE_PAUSE_TOUCH)
        if self._manual_paused:
            await self.hass.async_add_executor_job(_atomic_write, manual_path, b"")
        else:
            await self.hass.async_add_executor_job(_remove_if_exists, manual_path)
        if self._touch_deadline > 0:
            val = f"{int(self._touch_deadline)}\n".encode()
            await self.hass.async_add_executor_job(_atomic_write, touch_path, val)
        else:
            await self.hass.async_add_executor_job(_remove_if_exists, touch_path)

    async def _write_touch_bridge(self) -> None:
        """Write pause_touch.txt only (touch does not change manual hold)."""
        touch_path = os.path.join(self._bridge_dir, BRIDGE_PAUSE_TOUCH)
        val = f"{int(self._touch_deadline)}\n".encode()
        await self.hass.async_add_executor_job(_atomic_write, touch_path, val)

    async def async_next(self) -> None:
        """D-08 swipe matrix: bypass gate, lift manual hold, re-arm 90s window."""
        self._manual_paused = False
        self._touch_deadline = time.time() + TOUCH_WINDOW_SECONDS
        await self._write_pause_bridge()
        self._force_refresh = True
        await self.async_request_refresh()
        self.async_update_listeners()

    async def async_set_paused(self, paused: bool) -> None:
        """Switch turn_on(True)/turn_off(False). turn_off is FULL resume: clears both (D-08)."""
        self._manual_paused = paused
        if not paused:
            self._touch_deadline = 0.0
        await self._write_pause_bridge()
        self.async_update_listeners()

    async def async_touch(self) -> None:
        """D-06: arm the 90s window. Does NOT lift manual hold."""
        self._touch_deadline = time.time() + TOUCH_WINDOW_SECONDS
        await self._write_touch_bridge()

    async def async_set_rating(self, rating: int) -> None:
        """Rate the current photo 0-5 (D-09). 0 = Unrate."""
        asset_id = self.current_asset_id
        if not asset_id:
            raise ServiceValidationError("No current asset to rate")
        await self.client.set_rating(asset_id, rating)
        self._current_rating = rating
        self.async_update_listeners()

    async def async_remove(self) -> None:
        """Remove current photo with recovery-first fail-safe, then advance (D-12).

        ORDER IS LOAD-BEARING (Pitfall 3): add-to-recovery must succeed BEFORE source delete.
        """
        asset_id = self.current_asset_id
        if not asset_id:
            raise ServiceValidationError("No current asset to remove")
        album_id = self.settings.album_id
        recovery_album_id = getattr(self.settings, "remove_to_album_id", None)
        if recovery_album_id:
            try:
                await self.client.add_to_album(recovery_album_id, asset_id)
            except ImmichError as err:
                _LOGGER.warning(
                    "recovery add to '%s' FAILED for asset '%s'; NOT removing from source",
                    recovery_album_id, asset_id,
                )
                raise HomeAssistantError(
                    f"Recovery album add failed for {asset_id}; source not removed (fail-safe)"
                ) from err
        try:
            await self.client.remove_from_album(album_id, asset_id)
        except ImmichError as err:
            _LOGGER.warning("remove_from_album failed for '%s': %s -- advancing anyway", asset_id, err)
        self._force_refresh = True
        await self.async_request_refresh()
