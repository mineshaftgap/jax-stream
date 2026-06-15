"""DataUpdateCoordinator for Jax Stream.

Drives the timed fetch loop (CORE-03):
  1. Promote the next pre-fetched ring slot into random.jpg (hot path).
     If the ring is empty (first boot or stale restart), fall back to an
     on-demand Immich fetch (degraded path).
  2. Atomically write random.jpg to the v41 disk path in the executor.
  3. Bump image_bytes + image_last_updated so the ImageEntity state changes.
  4. Kick the backfill task to refill any consumed slot.

Ring buffer (Phase 1 prefetch-window-restore):
  Window dir: <config>/jax_stream/<stream>/window/
  Slot files: slot_00.jpg .. slot_{ring_size-1}.jpg (ring_size = N+1+M;
    N=prefetch_count future, 1 current, M=past_count past -- Phase 4 past-window)
  state.json: {head, past_count, slots} persisted beside the window dir.

Keeps the last-good photo on Immich failure (D-12, "never blank").
Seeds last-good bytes from on-disk random.jpg on restart (D-13).
Guards the stream subdir against path traversal (Security V5).

ASCII only -- no Unicode.
"""
from __future__ import annotations

import asyncio
import json
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
    BACKFILL_RETRY_CAP,
    BRIDGE_RATE_CURRENT,
    DEFAULT_PAST_COUNT,
    DEFAULT_PREFETCH_COUNT,
    DEFAULT_STREAM_SUBDIR,
    DISK_FILENAME,
    DISK_PATH_SEGMENTS,
    DOMAIN,
    JPEG_MAGIC,
    JPEG_QUALITY,
    ROTATE_REGEN_POLL_S,
    ROTATE_REGEN_TIMEOUT_S,
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


def _transpose_jpeg(raw: bytes, asset_id: str = "") -> bytes:
    """EXIF-transpose raw JPEG bytes and re-encode at JPEG_QUALITY.

    Port of v41 download_asset lines 247-254 (PIL block).
    Must run in the executor -- Image.open + exif_transpose + save are
    synchronous C calls that block the event loop (Pitfall 2).

    asset_id is embedded as a JPEG COM (comment) marker in pipe-delimited
    Phase 2 format: prev|self|next (empty prev and next at write time; next
    is patched in by _backfill after the successor slot is filled).
    JS reads {prev, self, next} from the COM for neighbor identity.
    """
    from PIL import Image, ImageOps  # Pillow; pinned in manifest.json

    img = Image.open(BytesIO(raw))
    img = ImageOps.exif_transpose(img)           # bake orientation in (matches v41)
    buf = BytesIO()
    kw = {"quality": JPEG_QUALITY}
    if asset_id:
        kw["comment"] = f"|{asset_id}|".encode()  # Phase 2: prev|self|next (empty ends)
    img.convert("RGB").save(buf, "JPEG", **kw)  # exact v41 format (D-02)
    return buf.getvalue()


def _patch_jpeg_com(data: bytes, new_comment: bytes) -> bytes:
    """Splice new_comment into the JPEG COM (FF FE) segment.

    Replaces an existing COM segment in-place (regardless of old content or
    length) or inserts one immediately after SOI when none exists.  Pure bytes
    splice -- no PIL re-encode.  Safe to run in the executor.

    Handles Phase 1 bare-UUID COMs transparently: the caller supplies the full
    new_comment in the pipe-delimited Phase 2 format; the old content is simply
    overwritten.

    Raises ValueError when data does not begin with FF D8 (not a JPEG).
    """
    if not data or data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")

    i = 2
    com_start = com_end = None
    while i + 3 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        # Standalone markers (no length field): SOI, EOI, RST0-RST7, TEM
        if m in (0xD8, 0xD9, 0x01) or (0xD0 <= m <= 0xD7):
            i += 2
            continue
        if m == 0xDA:           # SOS: pixel data begins; stop walking
            break
        seg_len = (data[i + 2] << 8) | data[i + 3]  # big-endian, includes the 2 len bytes
        if m == 0xFE:           # COM marker
            com_start = i
            com_end = i + 2 + seg_len
            break
        i += 2 + seg_len

    n = len(new_comment)
    new_seg = bytes([0xFF, 0xFE, (n + 2) >> 8, (n + 2) & 0xFF]) + new_comment

    if com_start is not None:
        return data[:com_start] + new_seg + data[com_end:]
    # No existing COM -- insert immediately after SOI.
    return data[:2] + new_seg + data[2:]


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


def _compact_past_slots(slot_path_fn, head: int, ring_size: int, past_count: int) -> int:
    """Close the past-window hole left by removing the CURRENT photo.

    After async_next() advances off a removed current photo, that photo sits at
    slot head-1 with the older history at head-2, head-3, ...  Rename each older
    slot FILE forward by one (slot(head-2) -> slot(head-1), slot(head-3) ->
    slot(head-2), ...), overwriting the removed photo's bytes and keeping the
    remaining history CONTIGUOUS from head-1 -- so deep back-nav survives a
    remove (only the removed photo drops out, not the whole back stack).

    Stops at the first missing source file (honouring the contiguous-from-head-1
    invariant the rest of the system relies on) and returns the number of slots
    that remain valid -- the new past_count. The slot vacated by the last move
    is removed from disk. Must run in the executor -- file I/O is blocking.
    """
    moved = 0
    for k in range(1, past_count):
        src = slot_path_fn((head - (k + 1)) % ring_size)
        dst = slot_path_fn((head - k) % ring_size)
        if not os.path.exists(src):
            break
        os.replace(src, dst)
        moved += 1
    vacated = slot_path_fn((head - (moved + 1)) % ring_size)
    try:
        os.remove(vacated)
    except FileNotFoundError:
        pass
    return moved


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


def _read_state_json(path: str) -> dict | None:
    """Read and parse state.json; return dict or None on any error."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def _write_state_json(path: str, head: int, slot_uuids: list, past_count: int = 0) -> None:
    """Atomically write state.json with head index, past_count, and slot uuid list.

    slot_uuids is a list where slot_uuids[i] is the UUID string for slot i,
    or None if the slot is empty. Written on every promote and every backfill
    slot fill so restart recovery can validate which slots are still valid.
    past_count is the number of valid past slots (Phase 4 past-window).
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    slot_map = {f"slot_{i:02d}": slot_uuids[i] for i in range(len(slot_uuids))}
    data = {"head": head, "past_count": past_count, "slots": slot_map}
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Coordinator
# ---------------------------------------------------------------------------


class JaxStreamCoordinator(DataUpdateCoordinator[bytes]):
    """Fetch loop + disk-write shim for one Jax Stream config entry.

    One instance per config entry (stream).  Drives CORE-03 (timed fetch)
    and the D-01/D-02 disk-write bridge that keeps the live LineageOS devices
    working through the migration with zero VA changes.

    Phase 1 prefetch: a ring buffer of N future frames in the window dir lets
    both the organic timer and jax_stream.next promote instantly from disk
    without an Immich round-trip on the hot path.
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
                        retry_cap (int),
                        prefetch_count (int, optional, default 3).
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

        # Adjacent-slot image entities (pub/sub adjacent slot migration).
        # image.jax_stream_<stream>_next_image serves slot (head+1); _previous_image
        # serves slot (head-1). Backs the JS prefetch + carousel left/right panels
        # with subscription-driven entity_picture URLs, replacing the state.json +
        # slot_XX.jpg polling in prefetchNext. None until the adjacent slot exists.
        self._next_bytes: bytes | None = None
        self._prev_bytes: bytes | None = None
        self.next_image_last_updated = None   # datetime | None
        self.prev_image_last_updated = None   # datetime | None

        # Security V5 / T-01-01: validate stream subdir before joining into a path.
        # Port of v41 lines 112-116 which reject names not matching [A-Za-z0-9_-]+.
        stream_subdir = getattr(settings, "stream_subdir", DEFAULT_STREAM_SUBDIR) or DEFAULT_STREAM_SUBDIR
        if not STREAM_NAME_RE.match(stream_subdir):
            raise ValueError(
                f"Invalid stream subdir {stream_subdir!r}: must match [A-Za-z0-9_-]+"
            )

        self._stream_subdir: str = stream_subdir

        # Build the disk path once using hass.config.path (never hardcode /config).
        self.disk_path: str = hass.config.path(
            *DISK_PATH_SEGMENTS, stream_subdir, DISK_FILENAME
        )

        # Phase 2 pause-gate state (D-05/D-06/D-07/D-08). Three-state v41 model:
        #   _manual_paused  -> switch entity (indefinite hold)
        #   _touch_deadline -> sensor.jax_stream_<stream>_touch_deadline
        #                      (wall-clock epoch; 0 = not armed)
        self._manual_paused: bool = False
        self._touch_deadline: float = 0.0
        self._force_refresh: bool = False          # explicit-call gate bypass (used by handle_refresh)
        self.current_asset_id: str | None = None
        self._current_rating: int = 0
        self._current_is_favorite: bool = False
        self._current_photo_info: dict = {}
        self._album_name: str = ""
        # Photo-rotate: absolute angle (0/90/180/270) applied per asset this
        # session. asset.edit.read is not granted so the current edit cannot be
        # read back from Immich -- track in memory so CW/CCW taps accumulate.
        self._rotate_angles: dict[str, int] = {}
        # Bridge files live in the same validated dir as random.jpg (subdir already
        # passed STREAM_NAME_RE above -- Security V5; no new path-traversal surface).
        self._bridge_dir: str = os.path.dirname(self.disk_path)

        # Ring buffer state (Phase 1 prefetch-window-restore; Phase 4 past-window).
        # ring_size = N + 1 + M (N future + 1 current + M past).
        self._prefetch_count: int = int(
            getattr(settings, "prefetch_count", DEFAULT_PREFETCH_COUNT)
        )
        self._past_size: int = int(getattr(settings, "past_count", DEFAULT_PAST_COUNT))
        self._ring_size: int = self._prefetch_count + 1 + self._past_size
        self._head: int = 0              # index of the current slot
        self._future_count: int = 0     # how many consecutive valid future slots exist
        self._past_count: int = 0       # how many valid past slots exist (max _past_size)
        self._window_dir: str = hass.config.path("jax_stream", stream_subdir, "window")
        self._state_json_path: str = hass.config.path("jax_stream", stream_subdir, "state.json")
        # Per-slot UUID (index -> uuid | None). None = empty/stale.
        self._slot_uuids: list[str | None] = [None] * self._ring_size
        # Per-slot rating cached at backfill time (index -> int).
        self._slot_ratings: list[int] = [0] * self._ring_size
        # Per-slot photo info cached at backfill time (index -> dict | None).
        self._slot_photo_info: list[dict | None] = [None] * self._ring_size
        # Backfill task state.
        self._backfill_task: asyncio.Task | None = None
        self._backfill_running: bool = False

        # Sequential (shuffle=False) state: ordered asset list and current index.
        # Populated lazily on first advance; refreshed on wrap-around.
        self._ordered_assets: list[str] = []
        self._ordered_index: int = 0

    @property
    def menu_order_list(self) -> list[str]:
        """Return the jaxmenu icon order as a list of action-key strings.

        Parsed from the comma-separated settings.menu_order value. Falls back
        to the full default order if unset or malformed.
        """
        from .const import DEFAULT_MENU_ORDER, MENU_ORDER_KEYS
        raw = getattr(self.settings, "menu_order", DEFAULT_MENU_ORDER) or DEFAULT_MENU_ORDER
        keys = [k.strip() for k in raw.split(",") if k.strip() and k.strip() in MENU_ORDER_KEYS]
        if not keys:
            return list(MENU_ORDER_KEYS)
        return keys

    def _slot_path(self, index: int) -> str:
        """Return the absolute path for ring slot `index`."""
        return os.path.join(self._window_dir, f"slot_{index:02d}.jpg")

    async def _refresh_adjacent_bytes(self) -> None:
        """Reload _next_bytes/_prev_bytes from the slots adjacent to head.

        Backs image.jax_stream_<stream>_next_image (slot head+1) and
        _previous_image (slot head-1). Bumps the matching last_updated only when
        the bytes actually change, so the entity_picture access token (and the
        JS state_changed subscription) fires exactly when a neighbor changes --
        no spurious frontend refetches.

        When a neighbor's slot is absent the entity must serve NO image rather
        than a stale one. For the past edge (past_count == 0) we therefore CLEAR
        _prev_bytes and bump the timestamp (token rotates -> JS re-fetches, gets
        a non-ok proxy response, and drops its prev panel). Without this the
        previous_image entity keeps serving the last real prev photo, so a
        back-swipe at the past-window edge slides the stale photo in (the
        black-panel / stale-photo flash). The next edge (future_count == 0) is
        left untouched: prefetch keeps the future window full so it effectively
        never occurs, and forward swipes do not flash. We intentionally do NOT
        mirror the current photo into _prev_bytes -- a current-as-previous panel
        would be a confusing phantom on the very first photo after boot.

        Per the image-entity pub/sub contract, bump last_updated ONLY when the
        bytes actually change, so the entity_picture token (and the JS
        state_changed subscription) fires exactly when a neighbor changes -- no
        spurious frontend refetches.
        """
        next_idx = (self._head + 1) % self._ring_size
        if self._future_count > 0:
            data = await self.hass.async_add_executor_job(
                _read_if_exists, self._slot_path(next_idx)
            )
            if data and data[:3] == JPEG_MAGIC and data != self._next_bytes:
                self._next_bytes = data
                self.next_image_last_updated = dt_util.utcnow()

        prev_idx = (self._head - 1 + self._ring_size) % self._ring_size
        if self._past_count > 0:
            data = await self.hass.async_add_executor_job(
                _read_if_exists, self._slot_path(prev_idx)
            )
            if data and data[:3] == JPEG_MAGIC and data != self._prev_bytes:
                self._prev_bytes = data
                self.prev_image_last_updated = dt_util.utcnow()
        elif self._prev_bytes is not None:
            # Past-window edge: no real previous photo -> serve nothing.
            self._prev_bytes = None
            self.prev_image_last_updated = dt_util.utcnow()

    def _kick_backfill(self) -> None:
        """Spawn (or no-op if already running) the background backfill task."""
        if self._backfill_running:
            return
        self._backfill_task = self.hass.async_create_task(self._backfill())

    async def _async_setup(self) -> None:
        """Seed last-good bytes and restore ring buffer state from disk.

        D-13: seed last-good bytes from on-disk random.jpg before the first
        refresh to eliminate the blank-flash on HA restart.

        Ring recovery: read state.json; validate each future slot's file for
        JPEG magic; set _future_count to the number of still-valid future slots.
        Empty/stale slots will be refilled by backfill. On first boot (no
        state.json) all slots are empty and backfill seeds them from scratch.
        """
        # Create window dir (safe no-op if it already exists).
        await self.hass.async_add_executor_job(
            lambda: os.makedirs(self._window_dir, exist_ok=True)
        )

        # Try to restore ring state from a previous run.
        state = await self.hass.async_add_executor_job(
            _read_state_json, self._state_json_path
        )
        if state:
            saved_head = int(state.get("head", 0)) % self._ring_size
            saved_slots = state.get("slots", {})
            self._head = saved_head
            # Restore the current-slot UUID (no file validation needed -- it was
            # already promoted to random.jpg before the state was written).
            curr_key = f"slot_{self._head:02d}"
            self._slot_uuids[self._head] = saved_slots.get(curr_key)
            # Validate future slots (k=1..N only -- past slots live at k=N+1..N+M).
            # Must have a UUID AND a readable JPEG on disk AND still exist in Immich.
            for k in range(1, self._prefetch_count + 1):
                slot_idx = (self._head + k) % self._ring_size
                slot_key = f"slot_{slot_idx:02d}"
                uuid = saved_slots.get(slot_key)
                if not uuid:
                    continue
                slot_file = self._slot_path(slot_idx)
                data = await self.hass.async_add_executor_job(_read_if_exists, slot_file)
                if not (data and data[:3] == JPEG_MAGIC):
                    _LOGGER.debug(
                        "Ring slot %d failed validation on restart (missing or bad JPEG)", slot_idx
                    )
                    continue
                # Phase 3: confirm the asset still exists in Immich (external delete
                # detection).  A 404 means deleted; keep the slot on connection errors
                # (benefit of the doubt -- backfill will catch issues at fetch time).
                try:
                    exists = await self.client.check_asset_exists(uuid)
                except ImmichError:
                    exists = True  # network/auth error; don't discard
                if not exists:
                    _LOGGER.debug(
                        "Ring slot %d UUID %.8s not found in Immich; treating as stale",
                        slot_idx, uuid,
                    )
                    continue
                self._slot_uuids[slot_idx] = uuid
                self._future_count += 1

            # Phase 4: restore past slots (k=1..M from head, reading backwards).
            # Past slots only need JPEG magic validation -- no Immich check since
            # deleted-in-Immich past photos are intentionally still displayable.
            # Break on the first gap: past window must be contiguous from head-1.
            saved_past_count = int(state.get("past_count", 0))
            for k in range(1, min(saved_past_count + 1, self._past_size + 1)):
                slot_idx = (self._head - k + self._ring_size) % self._ring_size
                slot_key = f"slot_{slot_idx:02d}"
                uuid = saved_slots.get(slot_key)
                if not uuid:
                    break  # gap in past window; stop here
                slot_file = self._slot_path(slot_idx)
                data = await self.hass.async_add_executor_job(_read_if_exists, slot_file)
                if not (data and data[:3] == JPEG_MAGIC):
                    _LOGGER.debug(
                        "Past slot %d failed JPEG validation on restart; truncating past_count",
                        slot_idx,
                    )
                    break
                self._slot_uuids[slot_idx] = uuid
                self._past_count += 1

        # D-13: seed last-good bytes from on-disk random.jpg.
        seeded = await self.hass.async_add_executor_job(_read_if_exists, self.disk_path)
        if seeded:
            self.image_bytes = seeded
            self.image_last_updated = dt_util.utcnow()

        # Seed adjacent-slot entity bytes so image.jax_stream_<stream>_next_image /
        # _previous_image have content the moment the platform creates them.
        await self._refresh_adjacent_bytes()

        # Fetch album name once at setup so the photo info overlay can display it.
        try:
            self._album_name = await self.client.get_album_name(self.settings.album_id)
        except ImmichError:
            self._album_name = ""

    async def _async_update_data(self) -> bytes:
        """Organic-timer advance: promote the next ring slot into random.jpg.

        This is the ONLY path for the organic timer. async_next does NOT call
        this method -- it inlines its own promote so the service call returns
        only after random.jpg is already updated.

        D-07: gate check at top. When manual-paused or inside the 90s touch
        window, skip the advance entirely; return last-good bytes unchanged.

        Hot path (future_count > 0): promote the next slot. No Immich call.
        Degraded path (future_count == 0): inline on-demand Immich fetch,
        write into the next slot, then promote.

        D-12 keep-last-good: on Immich failure, log a warning and return the
        last-good bytes rather than raising UpdateFailed.  Only raise on the
        cold-start case where there is nothing at all to show.
        """
        force = self._force_refresh
        self._force_refresh = False
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
            jpeg, asset_id, rating, photo_info = await self._fetch_next_slot()
        except (ImmichError, NoLandscapeSurvivor) as err:
            _LOGGER.warning("Jax Stream refresh failed, keeping last photo: %s", err)
            if self.image_bytes is None:
                raise UpdateFailed(str(err)) from err
            return self.image_bytes

        # Advance head and promote.
        self._head = (self._head + 1) % self._ring_size
        if self._future_count > 0:
            self._future_count -= 1
        self._slot_uuids[self._head] = asset_id
        self._slot_ratings[self._head] = rating
        self._slot_photo_info[self._head] = photo_info
        # Credit the outgoing photo as the nearest past slot (see async_next's
        # SIDE EFFECT docstring) -- this is what makes deep back-nav possible; a
        # remove must compact it back out (async_remove Case 1).
        self._past_count = min(self._past_count + 1, self._past_size)  # Phase 4

        await self.hass.async_add_executor_job(_atomic_write, self.disk_path, jpeg)
        self.current_asset_id = asset_id
        self._current_rating = rating
        self._current_is_favorite = bool(photo_info.get("isFavorite", False))
        self._current_photo_info = photo_info
        self.image_bytes = jpeg
        self.image_last_updated = dt_util.utcnow()
        await self._write_content_bridges(asset_id, rating)
        await self.hass.async_add_executor_job(
            _write_state_json, self._state_json_path, self._head, self._slot_uuids, self._past_count
        )
        # Refresh adjacent entities BEFORE returning -- the post-return
        # _handle_coordinator_update on the next/prev image entities will pick up
        # the new last_updated timestamps in the same tick.
        await self._refresh_adjacent_bytes()
        self._kick_backfill()
        self.hass.bus.async_fire(f"{DOMAIN}_advance", {"stream": self._stream_subdir})
        return jpeg

    async def _fetch_next_slot(self) -> tuple[bytes, str, int, dict]:
        """Return (jpeg_bytes, asset_id, rating, photo_info) for the next advance.

        Hot path: read from the pre-filled next slot file (no Immich call).
        Degraded path: on-demand Immich fetch when the ring is empty.
        Both paths validate JPEG magic before returning.

        Raises ImmichError / NoLandscapeSurvivor on degraded-path failure.
        """
        next_slot = (self._head + 1) % self._ring_size
        if self._future_count > 0:
            # Hot path: slot is pre-filled.
            slot_file = self._slot_path(next_slot)
            data = await self.hass.async_add_executor_job(_read_if_exists, slot_file)
            if data and data[:3] == JPEG_MAGIC:
                uuid = self._slot_uuids[next_slot] or ""
                rating = self._slot_ratings[next_slot]
                photo_info = self._slot_photo_info[next_slot] or {}
                return data, uuid, rating, photo_info
            # File vanished post-crash or JPEG invalid -- fall through to on-demand.
            # Do NOT decrement _future_count here: the caller decrements once after
            # the advance. The on-demand fetch overwrites this slot and replaces it,
            # so any remaining future slots are still valid.

        # Degraded path: on-demand fetch.
        asset_id = await self._next_asset_id()
        try:
            info = await self.client.get_asset_info(asset_id)
        except ImmichError:
            info = {"rating": 0, "isEdited": False}
        raw = await self.client.download_thumbnail(asset_id, edited=info["isEdited"])
        jpeg = await self.hass.async_add_executor_job(_transpose_jpeg, raw, asset_id)
        # Write the fetched bytes into the slot file so future back-nav (Phase 4)
        # and state.json can reference it.
        slot_file = self._slot_path(next_slot)
        await self.hass.async_add_executor_job(_atomic_write, slot_file, jpeg)
        self._slot_uuids[next_slot] = asset_id
        self._slot_ratings[next_slot] = info["rating"]
        self._slot_photo_info[next_slot] = info
        return jpeg, asset_id, info["rating"], info

    async def _next_asset_id(self) -> str:
        """Return the next asset ID based on shuffle setting.

        shuffle=True:  random via /api/search/random (existing behavior).
        shuffle=False: sequential via album order from /api/albums/{id}.
                       Fetches and caches the full asset list on first call;
                       refreshes on wrap-around so new photos appear eventually.
        """
        if getattr(self.settings, "shuffle", True):
            return await self.client.random_landscape(self.settings)

        if not self._ordered_assets or self._ordered_index >= len(self._ordered_assets):
            self._ordered_assets = await self.client.get_album_asset_ids(
                self.settings.album_id
            )
            self._ordered_index = 0
            if not self._ordered_assets:
                raise NoLandscapeSurvivor(self.settings.album_id)

        asset_id = self._ordered_assets[self._ordered_index]
        self._ordered_index += 1
        return asset_id

    # -----------------------------------------------------------------------
    # Bridge file helpers
    # -----------------------------------------------------------------------

    async def _write_content_bridges(self, asset_id: str, rating: int) -> None:
        """Write rate_current.txt bridge file."""
        await self.hass.async_add_executor_job(
            _atomic_write, os.path.join(self._bridge_dir, BRIDGE_RATE_CURRENT),
            f"{rating}\n".encode(),
        )

    # -----------------------------------------------------------------------
    # Phase 2 action methods (D-06 through D-12)
    # -----------------------------------------------------------------------

    async def async_next(self) -> None:
        """D-08 swipe matrix: bypass gate, lift manual hold, re-arm 90s window.

        Inline promote: reads the next ring slot and writes it to random.jpg
        BEFORE returning, so the Promise from callService resolves only after
        the new frame is already on disk. The frontend can then reload
        immediately -- no Immich round-trip on the hot path.

        Follows the async_rotate precedent (coordinator.py:426-429 in the old
        version) of setting image_bytes / image_last_updated / calling
        async_update_listeners() directly, bypassing the DataUpdateCoordinator
        return-value path.

        SIDE EFFECT (load-bearing for back-nav): advancing CREDITS the outgoing
        photo (the old head) as the nearest past slot -- _past_count is bumped so
        a later async_previous / swipe-right can promote it back. That is what
        powers deep back-nav, but it means any caller that must NOT leave the
        outgoing photo reachable has to purge it AFTER calling async_next (see
        async_remove Case 1, which compacts the removed photo out of the past
        window). Removing this credit would silently break back-nav.
        """
        self._manual_paused = False
        self._touch_deadline = time.time() + TOUCH_WINDOW_SECONDS

        try:
            jpeg, asset_id, rating, photo_info = await self._fetch_next_slot()
        except (ImmichError, NoLandscapeSurvivor) as err:
            _LOGGER.warning("async_next fetch failed, keeping last photo: %s", err)
            self.async_update_listeners()
            return

        # Advance head.
        self._head = (self._head + 1) % self._ring_size
        if self._future_count > 0:
            self._future_count -= 1
        self._slot_uuids[self._head] = asset_id
        self._slot_ratings[self._head] = rating
        self._slot_photo_info[self._head] = photo_info
        # Credit the outgoing photo as the nearest past slot (see async_next's
        # SIDE EFFECT docstring) -- this is what makes deep back-nav possible; a
        # remove must compact it back out (async_remove Case 1).
        self._past_count = min(self._past_count + 1, self._past_size)  # Phase 4

        await self.hass.async_add_executor_job(_atomic_write, self.disk_path, jpeg)
        self.current_asset_id = asset_id
        self._current_rating = rating
        self._current_is_favorite = bool(photo_info.get("isFavorite", False))
        self._current_photo_info = photo_info
        self.image_bytes = jpeg
        self.image_last_updated = dt_util.utcnow()
        await self._write_content_bridges(asset_id, rating)
        await self.hass.async_add_executor_job(
            _write_state_json, self._state_json_path, self._head, self._slot_uuids, self._past_count
        )
        await self._refresh_adjacent_bytes()
        self.async_update_listeners()
        self._kick_backfill()
        self.hass.bus.async_fire(f"{DOMAIN}_advance", {"stream": self._stream_subdir})
        # Do NOT call async_request_refresh() -- the display is already updated.

    async def async_previous(self) -> None:
        """Go back one step: promote the previous past slot to random.jpg.

        Mirrors async_next but in reverse. Raises ServiceValidationError when
        no past slot is available (past_count == 0 or slot file missing/bad).
        Does not touch pause state -- callers handle resume/touch separately.
        """
        if self._past_count == 0:
            raise ServiceValidationError("No previous photo")

        prev_slot = (self._head - 1 + self._ring_size) % self._ring_size
        slot_file = self._slot_path(prev_slot)
        data = await self.hass.async_add_executor_job(_read_if_exists, slot_file)
        if not (data and data[:3] == JPEG_MAGIC):
            raise ServiceValidationError("Previous photo slot is missing or invalid")

        uuid = self._slot_uuids[prev_slot] or ""
        rating = self._slot_ratings[prev_slot]
        photo_info = self._slot_photo_info[prev_slot] or {}

        # Move head backward; old head becomes the first future slot.
        self._head = prev_slot
        self._future_count += 1   # old head is now slot head+1 (valid JPEG)
        self._past_count -= 1

        await self.hass.async_add_executor_job(_atomic_write, self.disk_path, data)
        self.current_asset_id = uuid or None
        self._current_rating = rating
        self._current_is_favorite = bool(photo_info.get("isFavorite", False))
        self._current_photo_info = photo_info
        self.image_bytes = data
        self.image_last_updated = dt_util.utcnow()
        await self._write_content_bridges(uuid, rating)
        await self.hass.async_add_executor_job(
            _write_state_json, self._state_json_path, self._head, self._slot_uuids, self._past_count
        )
        await self._refresh_adjacent_bytes()
        self.async_update_listeners()
        self.hass.bus.async_fire(f"{DOMAIN}_advance", {"stream": self._stream_subdir})

    async def async_set_paused(self, paused: bool) -> None:
        """Switch turn_on(True)/turn_off(False). turn_off is FULL resume: clears both (D-08)."""
        self._manual_paused = paused
        if not paused:
            self._touch_deadline = 0.0
        self.async_update_listeners()

    async def async_touch(self) -> None:
        """D-06: arm the 90s window. Does NOT lift manual hold.

        Fires async_update_listeners so sensor.jax_stream_<stream>_touch_deadline
        pushes the new deadline to subscribed frontends (cross-device ring sync,
        post-bounce restore).
        """
        self._touch_deadline = time.time() + TOUCH_WINDOW_SECONDS
        self.async_update_listeners()

    async def async_set_rating(self, rating: int, asset_id: str | None = None) -> None:
        """Rate the current photo 0-5 (D-09). 0 = Unrate.

        asset_id overrides current_asset_id when provided (JS display-time cache,
        same drift-prevention pattern as async_remove).
        """
        if not asset_id:
            asset_id = self.current_asset_id
        if not asset_id:
            raise ServiceValidationError("No current asset to rate")
        await self.client.set_rating(asset_id, rating)
        self._current_rating = rating
        self.async_update_listeners()

    async def async_toggle_favorite(self, asset_id: str | None = None) -> None:
        """Toggle isFavorite on the current photo (asset.update scope).

        asset_id overrides current_asset_id when provided (JS display-time cache,
        same drift-prevention pattern as set_rating / remove).
        """
        if not asset_id:
            asset_id = self.current_asset_id
        if not asset_id:
            raise ServiceValidationError("No current asset to favorite")
        new_state = not self._current_is_favorite
        await self.client.toggle_favorite(asset_id, new_state)
        self._current_is_favorite = new_state
        self.async_update_listeners()

    async def async_remove(self, asset_id: str | None = None) -> None:
        """Remove current photo with recovery-first fail-safe, then advance (D-12).

        Uses caller-provided asset_id (JS tap-time snapshot) when available to prevent
        the race where auto-advance fires during the confirm dialog window and updates
        current_asset_id before the user confirms. Falls back to self.current_asset_id.

        ORDER IS LOAD-BEARING (Pitfall 3): add-to-recovery must succeed BEFORE source delete.

        Phase 3 ring integration (two cases):
          1. Removed asset is the currently displayed photo (head slot): call async_next()
             to inline-promote the next slot and kick backfill.
          2. Removed asset is a future slot: drop its UUID, truncate future_count to just
             before the gap, and kick backfill to refill.  No display advance.
          3. UUID not in ring (stale caller id or already replaced): fall through to async_next().
        """
        if not asset_id:
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

        # Phase 3/4: ring-aware advance.
        if self._slot_uuids[self._head] == asset_id:
            # Case 1: currently displayed photo removed -- advance to the next
            # slot, then PURGE the removed photo from the past window so it is not
            # reachable by back-nav.
            #
            # async_next() advances head and (by design, for back-nav) credits the
            # OLD head as the nearest past slot -- so without this purge the
            # removed photo would be the very next swipe-right / async_previous
            # target (it left the album but not the photo stream). We COMPACT
            # rather than truncate: the removed photo is now head-1; shifting the
            # older past slots forward by one closes the hole and PRESERVES deep
            # back-nav (M=DEFAULT_PAST_COUNT) to the photos before it. Compacting
            # keeps the "past window is contiguous from head-1" invariant the rest
            # of the system depends on (restore, _refresh_adjacent_bytes), so only
            # async_remove changes.
            await self.async_next()
            moved = await self.hass.async_add_executor_job(
                _compact_past_slots, self._slot_path, self._head,
                self._ring_size, self._past_count,
            )
            # Mirror the on-disk slot shift in the in-memory uuid/rating arrays
            # (k=1..moved, head-ward, so each source is read before it is itself
            # overwritten as a later destination -- no temp copy needed).
            for k in range(1, moved + 1):
                src = (self._head - (k + 1)) % self._ring_size
                dst = (self._head - k) % self._ring_size
                self._slot_uuids[dst] = self._slot_uuids[src]
                self._slot_ratings[dst] = self._slot_ratings[src]
                self._slot_photo_info[dst] = self._slot_photo_info[src]
            vacated = (self._head - (moved + 1)) % self._ring_size
            self._slot_uuids[vacated] = None
            self._slot_ratings[vacated] = 0
            self._slot_photo_info[vacated] = None
            self._past_count = moved
            await self.hass.async_add_executor_job(
                _write_state_json, self._state_json_path, self._head,
                self._slot_uuids, self._past_count,
            )
            await self._refresh_adjacent_bytes()
            self.async_update_listeners()
        else:
            # Case 2: search future and past slots for the removed UUID.
            dropped = False
            for k in range(1, self._ring_size):
                slot_idx = (self._head + k) % self._ring_size
                if self._slot_uuids[slot_idx] == asset_id:
                    self._slot_uuids[slot_idx] = None
                    self._slot_ratings[slot_idx] = 0
                    self._slot_photo_info[slot_idx] = None
                    if k <= self._future_count:
                        # Future slot: truncate to just before the gap.
                        self._future_count = k - 1
                    else:
                        # Phase 4: past slot removed -- recount contiguous past slots
                        # from head-1 to reflect the gap.
                        new_past = 0
                        for j in range(1, self._past_size + 1):
                            p_idx = (self._head - j + self._ring_size) % self._ring_size
                            if self._slot_uuids[p_idx] is not None:
                                new_past = j
                            else:
                                break
                        self._past_count = new_past
                    await self.hass.async_add_executor_job(
                        _write_state_json, self._state_json_path, self._head,
                        self._slot_uuids, self._past_count,
                    )
                    self._kick_backfill()
                    _LOGGER.debug(
                        "Phase 3/4: dropped slot %d (uuid=%.8s); future_count=%d past_count=%d",
                        slot_idx, asset_id, self._future_count, self._past_count,
                    )
                    dropped = True
                    break
            if not dropped:
                # Case 3: UUID not found in ring (already replaced or stale caller id).
                _LOGGER.debug("Phase 3: uuid=%.8s not in ring; advancing past current", asset_id)
                await self.async_next()

    async def async_rotate(self, delta: int, asset_id: str | None = None) -> None:
        """Rotate the current photo via Immich non-destructive edit, then show
        the corrected rendition in place WITHOUT advancing to a new photo.

        delta is the CW rotation in degrees (90 = CW, 270 = CCW); the absolute
        angle is accumulated per asset in self._rotate_angles (replaceAll
        semantics + no asset.edit.read -- see const.py). asset_id overrides
        current_asset_id when provided (JS display-time snapshot, same
        drift-prevention pattern as set_rating / remove).

        The edited preview is regenerated by an async Immich worker (~2.5s
        observed). Snapshot the current edited bytes, then poll edited=true
        until they change (capped at ROTATE_REGEN_TIMEOUT_S) so the displayed
        photo flips to the corrected orientation; on timeout, fall back to
        whatever edited=true returns rather than hanging.
        """
        if not asset_id:
            asset_id = self.current_asset_id
        if not asset_id:
            raise ServiceValidationError("No current asset to rotate")

        new_angle = (self._rotate_angles.get(asset_id, 0) + delta) % 360

        # Snapshot the pre-rotate edited rendition (falls back to the original
        # when the asset has no edit yet) so we can detect when regen lands.
        try:
            before = await self.client.download_thumbnail(asset_id, edited=True)
        except ImmichError:
            before = None

        await self.client.rotate(asset_id, new_angle)
        self._rotate_angles[asset_id] = new_angle

        deadline = time.monotonic() + ROTATE_REGEN_TIMEOUT_S
        new_bytes = None
        while True:
            try:
                cand = await self.client.download_thumbnail(asset_id, edited=True)
            except ImmichError:
                cand = None
            if cand is not None and cand != before:
                new_bytes = cand
                break
            if time.monotonic() >= deadline:
                # Regen not observed in time; use whatever edited=true returns.
                new_bytes = cand
                _LOGGER.warning(
                    "rotate: regenerated preview not confirmed for '%s' within %ss",
                    asset_id, ROTATE_REGEN_TIMEOUT_S,
                )
                break
            await asyncio.sleep(ROTATE_REGEN_POLL_S)

        if not new_bytes:
            raise HomeAssistantError(f"Rotated preview unavailable for {asset_id}")

        # Re-encode through the same path as the fetch loop so the COM marker is
        # embedded (JS reads identity from the displayed bytes) and the on-disk
        # random.jpg matches what the entity serves.
        jpeg = await self.hass.async_add_executor_job(_transpose_jpeg, new_bytes, asset_id)
        # Phase 2: patch COM to add next neighbor UUID so JS preloads identity.
        next_slot = (self._head + 1) % self._ring_size
        next_uuid = self._slot_uuids[next_slot] or ""
        if next_uuid:
            try:
                jpeg = await self.hass.async_add_executor_job(
                    _patch_jpeg_com, jpeg, f"|{asset_id}|{next_uuid}".encode()
                )
            except Exception as _e:
                _LOGGER.debug("Phase 2 COM patch for rotate skipped: %s", _e)
        await self.hass.async_add_executor_job(_atomic_write, self.disk_path, jpeg)
        self.image_bytes = jpeg
        self.image_last_updated = dt_util.utcnow()
        self.async_update_listeners()

    # -----------------------------------------------------------------------
    # Backfill task
    # -----------------------------------------------------------------------

    async def _backfill(self) -> None:
        """Background task: keep the ring full by downloading future slots.

        Loops until future_count == prefetch_count (ring full) or the retry
        cap is hit. A boolean guard prevents concurrent runs. Cancelled on
        coordinator unload via the stored Task reference.

        asyncio is single-threaded: ring deque and future_count are only
        touched from the event loop -- no locks needed. Executor jobs handle
        disk I/O; mutations happen only after await returns.
        """
        if self._backfill_running:
            return
        self._backfill_running = True
        try:
            attempts = 0
            while self._future_count < self._prefetch_count:
                attempts += 1
                if attempts > BACKFILL_RETRY_CAP:
                    _LOGGER.warning(
                        "Backfill: giving up after %d attempts (ring at %d/%d)",
                        BACKFILL_RETRY_CAP, self._future_count, self._prefetch_count,
                    )
                    break
                # Target slot: first empty future slot after the current furthest-future.
                target_slot = (self._head + self._future_count + 1) % self._ring_size
                slot_file = self._slot_path(target_slot)
                try:
                    asset_id = await self._next_asset_id()
                    try:
                        info = await self.client.get_asset_info(asset_id)
                    except ImmichError:
                        info = {"rating": 0, "isEdited": False}
                    raw = await self.client.download_thumbnail(
                        asset_id, edited=info["isEdited"]
                    )
                    jpeg = await self.hass.async_add_executor_job(
                        _transpose_jpeg, raw, asset_id
                    )
                    if jpeg[:3] != JPEG_MAGIC:
                        _LOGGER.warning("Backfill slot %d: bad JPEG magic; retrying", target_slot)
                        continue
                    await self.hass.async_add_executor_job(_atomic_write, slot_file, jpeg)
                    self._slot_uuids[target_slot] = asset_id
                    self._slot_ratings[target_slot] = info["rating"]
                    self._slot_photo_info[target_slot] = info
                    await self.hass.async_add_executor_job(
                        _write_state_json, self._state_json_path,
                        self._head, self._slot_uuids, self._past_count,
                    )
                    self._future_count += 1
                    _LOGGER.debug(
                        "Backfill slot %d filled (uuid=%s, future_count=%d/%d)",
                        target_slot, asset_id[:8], self._future_count, self._prefetch_count,
                    )
                    # Phase 2: patch the prev slot's COM to embed next = asset_id.
                    # prev_idx = (head + old_future_count) = (head + new_future_count - 1).
                    prev_idx = (self._head + self._future_count - 1) % self._ring_size
                    prev_uuid = self._slot_uuids[prev_idx] or ""
                    if prev_uuid:
                        new_com = f"|{prev_uuid}|{asset_id}".encode()
                        if prev_idx == self._head:
                            # Patch the currently-displayed bytes and random.jpg.
                            if self.image_bytes:
                                try:
                                    patched = await self.hass.async_add_executor_job(
                                        _patch_jpeg_com, self.image_bytes, new_com
                                    )
                                    await self.hass.async_add_executor_job(
                                        _atomic_write, self.disk_path, patched
                                    )
                                    self.image_bytes = patched
                                    _LOGGER.debug(
                                        "Phase 2 COM patch: random.jpg next=%s", asset_id[:8]
                                    )
                                except Exception as _e:
                                    _LOGGER.debug("Phase 2 COM patch for random.jpg skipped: %s", _e)
                        else:
                            # Patch the future slot file on disk.
                            prev_file = self._slot_path(prev_idx)
                            prev_data = await self.hass.async_add_executor_job(
                                _read_if_exists, prev_file
                            )
                            if prev_data:
                                try:
                                    patched = await self.hass.async_add_executor_job(
                                        _patch_jpeg_com, prev_data, new_com
                                    )
                                    await self.hass.async_add_executor_job(
                                        _atomic_write, prev_file, patched
                                    )
                                    _LOGGER.debug(
                                        "Phase 2 COM patch: slot %d next=%s",
                                        prev_idx, asset_id[:8]
                                    )
                                except Exception as _e:
                                    _LOGGER.debug(
                                        "Phase 2 COM patch for slot %d skipped: %s", prev_idx, _e
                                    )
                    # A backfill that filled slot head+1 changes the next-image
                    # entity. Refresh its bytes and push to listeners so the JS
                    # state_changed subscription re-prefetches without polling.
                    if target_slot == (self._head + 1) % self._ring_size:
                        await self._refresh_adjacent_bytes()
                        self.async_update_listeners()
                except asyncio.CancelledError:
                    raise
                except (ImmichError, NoLandscapeSurvivor) as exc:
                    _LOGGER.warning(
                        "Backfill slot %d attempt %d failed: %s", target_slot, attempts, exc
                    )
                    await asyncio.sleep(2.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Backfill task unexpected error: %s", exc)
        finally:
            self._backfill_running = False
