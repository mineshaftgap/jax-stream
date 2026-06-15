"""Pure-Python gate state-machine unit tests for JaxStreamCoordinator.

Tests the pause gate, _force_refresh bypass, bridge file writes, and
recovery-first fail-safe ordering -- without constructing the full HA object.

Approach (A): builds a minimal stub object with gate attributes and calls the
coordinator's unbound methods with the stub as self.  Stubs hass, client, and
coordinator-protocol methods (async_request_refresh, async_update_listeners).

Runs with plain: python3 custom_components/jax_stream/tests/test_gate.py
No pytest, no HA install required.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import AsyncMock, MagicMock

# ---------------------------------------------------------------------------
# Fake homeassistant namespace -- installed BEFORE coordinator is imported
# so that `from homeassistant.X import Y` resolves to our stubs.
# ---------------------------------------------------------------------------


class _HomeAssistantError(Exception):
    """Stub for homeassistant.exceptions.HomeAssistantError."""


class _ServiceValidationError(Exception):
    """Stub for homeassistant.exceptions.ServiceValidationError."""


class _FakeDUC:
    """Minimal DataUpdateCoordinator stub -- absorbs __init__ kwargs."""
    def __init__(self, hass, logger, *, name, config_entry, update_interval):
        self.hass = hass
        self.logger = logger

    def __class_getitem__(cls, item):
        """Support DataUpdateCoordinator[bytes] generic subscript."""
        return cls


_ha_exc = types.SimpleNamespace(
    HomeAssistantError=_HomeAssistantError,
    ServiceValidationError=_ServiceValidationError,
)
_ha_uc = types.SimpleNamespace(
    DataUpdateCoordinator=_FakeDUC,
    UpdateFailed=Exception,
)

_ha_cv = types.SimpleNamespace(
    entity_id=str,   # stub: validator that accepts a string
    string=str,
)

_ha_er = types.SimpleNamespace(
    async_get=lambda hass: None,
)

_ha_helpers = types.ModuleType("homeassistant.helpers")
_ha_helpers.entity_registry = _ha_er      # type: ignore[attr-defined]
_ha_helpers.config_validation = _ha_cv    # type: ignore[attr-defined]

_HA_MOCKS = {
    "homeassistant": types.ModuleType("homeassistant"),
    "homeassistant.core": types.SimpleNamespace(
        HomeAssistant=object,
        ServiceCall=object,
        callback=lambda f: f,
    ),
    "homeassistant.const": types.SimpleNamespace(
        Platform=types.SimpleNamespace(IMAGE="image", BUTTON="button", SELECT="select", SWITCH="switch"),
    ),
    "homeassistant.exceptions": _ha_exc,
    "homeassistant.helpers": _ha_helpers,
    "homeassistant.helpers.update_coordinator": _ha_uc,
    "homeassistant.helpers.aiohttp_client": types.SimpleNamespace(
        async_get_clientsession=lambda hass: None,
    ),
    "homeassistant.helpers.entity_registry": _ha_er,
    "homeassistant.helpers.config_validation": _ha_cv,
    "homeassistant.util": types.ModuleType("homeassistant.util"),
    "homeassistant.util.dt": types.SimpleNamespace(utcnow=lambda: object()),
}

for _k, _v in _HA_MOCKS.items():
    sys.modules[_k] = _v  # type: ignore[assignment]

# After stubs are installed, import exception classes that coordinator will use
# (they MUST be the same objects coordinator's raise statements use).
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError  # noqa: E402

# ---------------------------------------------------------------------------
# Import coordinator and ImmichError from the package directory
# ---------------------------------------------------------------------------

# Add custom_components/ to path so jax_stream imports work as a package.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

# Pre-inject a bare jax_stream package (with __path__) so importing
# jax_stream.coordinator resolves the submodule WITHOUT executing the real
# __init__.py -- which pulls homeassistant.components.frontend/http + voluptuous
# that are absent in the plain-python3 test env (DEVEL/testing.md). Relative
# imports inside coordinator.py (from .const / .immich) resolve from __path__.
_jax_pkg = types.ModuleType("jax_stream")
_jax_pkg.__path__ = [os.path.join(_PKG_ROOT, "jax_stream")]
sys.modules["jax_stream"] = _jax_pkg

from jax_stream.coordinator import JaxStreamCoordinator  # noqa: E402
from jax_stream.immich import ImmichError               # noqa: E402


# ---------------------------------------------------------------------------
# Executor side-effect: handles _transpose_jpeg; no-ops disk writes/removes
# ---------------------------------------------------------------------------

async def _fake_executor(fn, *args):
    """Return fake-jpeg for _transpose_jpeg; None for atomic write/remove."""
    if fn.__name__ == "_transpose_jpeg":
        return b"fake-jpeg"
    return None


# ---------------------------------------------------------------------------
# Stub factory
# ---------------------------------------------------------------------------

def _make_stub(
    image_bytes=None,
    manual_paused=False,
    touch_deadline=0.0,
    force=False,
    current_asset_id="asset-abc",
    recovery_album_id="album-recovery",
):
    """Return a SimpleNamespace with all attributes coordinator methods need."""
    stub = types.SimpleNamespace()

    # Gate state
    stub._manual_paused = manual_paused
    stub._touch_deadline = touch_deadline
    stub._force_refresh = force
    stub.current_asset_id = current_asset_id
    stub._current_rating = 0
    stub._current_photo_info = {}
    stub._album_name = ""
    stub._rotate_angles = {}
    stub._bridge_dir = "/tmp/jax_test_bridge"
    stub.disk_path = "/tmp/jax_test_bridge/random.jpg"
    stub.image_bytes = image_bytes
    stub.image_last_updated = None

    # Ring buffer state (Phase 1 prefetch). _future_count=0 -> degraded path,
    # which calls _fetch_next_slot (mocked below). The ring fields are needed
    # by _async_update_data and async_next.
    stub._head = 0
    stub._ring_size = 4
    stub._future_count = 0
    stub._past_size = 3
    stub._past_count = 0
    stub._slot_uuids = [None] * 4
    stub._slot_ratings = [0] * 4
    stub._slot_photo_info = [None] * 4
    stub._state_json_path = "/tmp/jax_test_state.json"

    # Mock hass: async_add_executor_job returns awaitable via AsyncMock side_effect
    hass = MagicMock()
    hass.async_add_executor_job = AsyncMock(side_effect=_fake_executor)
    stub.hass = hass

    # Mock client
    client = MagicMock()
    client.random_landscape = AsyncMock(return_value="asset-xyz")
    client.download_thumbnail = AsyncMock(return_value=b"raw-bytes")
    client.get_asset_rating = AsyncMock(return_value=3)
    client.get_asset_info = AsyncMock(return_value={"rating": 3, "isEdited": False, "date": "", "city": "", "country": "", "camera": ""})
    client.set_rating = AsyncMock(return_value=None)
    client.rotate = AsyncMock(return_value=None)
    client.add_to_album = AsyncMock(return_value=None)
    client.remove_from_album = AsyncMock(return_value=None)
    stub.client = client

    # Mock settings
    stub.settings = types.SimpleNamespace(
        album_id="album-src",
        remove_to_album_id=recovery_album_id,
    )

    # Coordinator protocol methods (mocked -- do not run real HA machinery)
    stub.async_request_refresh = AsyncMock(return_value=None)
    stub.async_update_listeners = MagicMock()

    # Ring buffer method stubs: _fetch_next_slot is the new advance entry point
    # (replaces direct client.random_landscape calls in _async_update_data).
    # Returns (jpeg_bytes, asset_id, rating, photo_info) as the real implementation does.
    stub._stream_subdir = "test-stream"
    stub._fetch_next_slot = AsyncMock(return_value=(b"fake-jpeg", "asset-xyz", 3, {}))
    stub._write_content_bridges = AsyncMock(return_value=None)
    stub._refresh_adjacent_bytes = AsyncMock(return_value=None)
    stub._kick_backfill = MagicMock()
    stub.async_next = AsyncMock(return_value=None)

    return stub


# ---------------------------------------------------------------------------
# Tests: gate suppression
# ---------------------------------------------------------------------------


class TestGateSuppression(unittest.IsolatedAsyncioTestCase):
    """Gate blocks advance when manual-paused or inside the 90s touch window."""

    async def test_manual_paused_skips_advance(self):
        """_manual_paused=True -> return last bytes, no random_landscape call."""
        stub = _make_stub(image_bytes=b"last-photo", manual_paused=True)
        result = await JaxStreamCoordinator._async_update_data(stub)
        self.assertEqual(result, b"last-photo")
        stub.client.random_landscape.assert_not_called()
        # image_last_updated must NOT be bumped (frozen per D-07)
        self.assertIsNone(stub.image_last_updated)

    async def test_touch_window_active_skips_advance(self):
        """touch_deadline in the future -> suppress advance."""
        future_deadline = time.time() + 60
        stub = _make_stub(image_bytes=b"held-photo", touch_deadline=future_deadline)
        result = await JaxStreamCoordinator._async_update_data(stub)
        self.assertEqual(result, b"held-photo")
        stub.client.random_landscape.assert_not_called()

    async def test_no_gate_advance_proceeds(self):
        """Neither paused nor in-window -> advance calls _fetch_next_slot."""
        stub = _make_stub(image_bytes=b"old-photo")
        result = await JaxStreamCoordinator._async_update_data(stub)
        stub._fetch_next_slot.assert_called_once()
        self.assertEqual(result, b"fake-jpeg")

    async def test_force_refresh_bypasses_manual_pause(self):
        """_force_refresh=True -> advance even when manual-paused."""
        stub = _make_stub(image_bytes=b"old-photo", manual_paused=True, force=True)
        result = await JaxStreamCoordinator._async_update_data(stub)
        stub._fetch_next_slot.assert_called_once()
        self.assertEqual(result, b"fake-jpeg")

    async def test_force_refresh_consumed_once(self):
        """After one forced advance, _force_refresh is False (consumed once).
        The second tick (gate re-engaged) returns the UPDATED image_bytes (not old)
        because the first advance set image_bytes = fake-jpeg."""
        stub = _make_stub(image_bytes=b"old-photo", manual_paused=True, force=True)
        await JaxStreamCoordinator._async_update_data(stub)
        # Flag must be reset to False before any await (T-2-05 pitfall 2)
        self.assertFalse(stub._force_refresh)
        # First advance updated image_bytes to the new photo
        self.assertEqual(stub.image_bytes, b"fake-jpeg")
        # Second tick with manual still paused: gate re-engages, no advance
        stub._fetch_next_slot.reset_mock()
        result2 = await JaxStreamCoordinator._async_update_data(stub)
        stub._fetch_next_slot.assert_not_called()
        # Gate returns the current image_bytes (the photo fetched in the first tick)
        self.assertEqual(result2, b"fake-jpeg")


# ---------------------------------------------------------------------------
# Tests: action methods (state mutations + listener notification)
# ---------------------------------------------------------------------------


class TestActionMethods(unittest.IsolatedAsyncioTestCase):
    """Gate-state mutations and listener notification."""

    async def test_async_set_paused_true_sets_manual(self):
        """async_set_paused(True) sets _manual_paused and calls async_update_listeners."""
        stub = _make_stub()
        await JaxStreamCoordinator.async_set_paused(stub, True)
        self.assertTrue(stub._manual_paused)
        stub.async_update_listeners.assert_called_once()

    async def test_async_set_paused_false_full_resume(self):
        """async_set_paused(False) clears BOTH manual hold AND touch deadline (D-08)."""
        stub = _make_stub(manual_paused=True, touch_deadline=time.time() + 60)
        await JaxStreamCoordinator.async_set_paused(stub, False)
        self.assertFalse(stub._manual_paused)
        self.assertEqual(stub._touch_deadline, 0.0)
        stub.async_update_listeners.assert_called_once()

    async def test_async_next_lifts_manual_and_rearms_window(self):
        """async_next clears manual hold, re-arms 90s window, and inline-promotes.
        _force_refresh is NOT set (Phase 1: promote is inline, no request_refresh).
        async_update_listeners() is called after the promote."""
        stub = _make_stub(manual_paused=True)
        before = time.time()
        await JaxStreamCoordinator.async_next(stub)
        self.assertFalse(stub._manual_paused)
        self.assertGreater(stub._touch_deadline, before)
        # Phase 1: inline promote does NOT use _force_refresh
        self.assertFalse(stub._force_refresh)
        stub._fetch_next_slot.assert_called_once()
        stub.async_update_listeners.assert_called_once()
        # Backfill kicked, async_request_refresh NOT called
        stub._kick_backfill.assert_called_once()
        stub.async_request_refresh.assert_not_called()

    async def test_async_touch_arms_window_only(self):
        """async_touch arms the 90s window but does NOT lift manual hold.

        Fires async_update_listeners so the touch_deadline sensor pushes the new
        deadline to subscribed frontends.
        """
        stub = _make_stub(manual_paused=True)
        before = time.time()
        await JaxStreamCoordinator.async_touch(stub)
        self.assertGreater(stub._touch_deadline, before)
        # manual hold unchanged
        self.assertTrue(stub._manual_paused)
        stub.async_update_listeners.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: recovery fail-safe (T-2-04)
# ---------------------------------------------------------------------------


class TestRecoveryFailSafe(unittest.IsolatedAsyncioTestCase):
    """async_remove recovery-first ordering -- add-to-recovery before source delete."""

    async def test_recovery_failure_aborts_source_delete(self):
        """add_to_album raising ImmichError -> HomeAssistantError raised;
        remove_from_album call_count must be 0 (source not touched)."""
        stub = _make_stub()
        stub.client.add_to_album = AsyncMock(side_effect=ImmichError("recovery down"))
        with self.assertRaises(HomeAssistantError):
            await JaxStreamCoordinator.async_remove(stub)
        self.assertEqual(stub.client.remove_from_album.call_count, 0)

    async def test_no_current_asset_remove_raises_service_validation_error(self):
        """async_remove with no current asset raises ServiceValidationError."""
        stub = _make_stub(current_asset_id=None)
        with self.assertRaises(ServiceValidationError):
            await JaxStreamCoordinator.async_remove(stub)

    async def test_no_current_asset_rate_raises_service_validation_error(self):
        """async_set_rating with no current asset raises ServiceValidationError."""
        stub = _make_stub(current_asset_id=None)
        with self.assertRaises(ServiceValidationError):
            await JaxStreamCoordinator.async_set_rating(stub, 4)

    async def test_remove_without_recovery_album_skips_add_to_album(self):
        """When recovery_album_id is None, add_to_album is not called at all."""
        stub = _make_stub(recovery_album_id=None)
        await JaxStreamCoordinator.async_remove(stub)
        self.assertEqual(stub.client.add_to_album.call_count, 0)
        stub.client.remove_from_album.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: async_rotate (Immich non-destructive edit + in-place corrected re-show)
# ---------------------------------------------------------------------------


class TestRotate(unittest.IsolatedAsyncioTestCase):
    """async_rotate: cumulative absolute angle, edited-rendition poll, no advance."""

    async def test_no_current_asset_rotate_raises(self):
        """async_rotate with no current asset raises ServiceValidationError."""
        stub = _make_stub(current_asset_id=None)
        with self.assertRaises(ServiceValidationError):
            await JaxStreamCoordinator.async_rotate(stub, 90)

    async def test_rotate_cw_puts_absolute_angle_and_accumulates(self):
        """First CW (90) PUTs 90; second CW PUTs 180 (cumulative, mod 360)."""
        stub = _make_stub(current_asset_id="asset-rot")
        # before-snapshot returns old edited bytes; each poll returns NEW bytes.
        stub.client.download_thumbnail = AsyncMock(
            side_effect=[b"old-edit", b"new-edit-1", b"old-edit", b"new-edit-2"]
        )
        await JaxStreamCoordinator.async_rotate(stub, 90)
        self.assertEqual(stub.client.rotate.call_args[0], ("asset-rot", 90))
        self.assertEqual(stub._rotate_angles["asset-rot"], 90)
        await JaxStreamCoordinator.async_rotate(stub, 90)
        self.assertEqual(stub.client.rotate.call_args[0], ("asset-rot", 180))
        self.assertEqual(stub._rotate_angles["asset-rot"], 180)

    async def test_rotate_ccw_wraps_modulo_360(self):
        """CCW (delta 270) from 0 yields absolute 270; from 270 yields 180."""
        stub = _make_stub(current_asset_id="asset-rot")
        stub._rotate_angles = {"asset-rot": 270}
        stub.client.download_thumbnail = AsyncMock(side_effect=[b"old", b"new"])
        await JaxStreamCoordinator.async_rotate(stub, 270)  # 270 + 270 = 540 % 360 = 180
        self.assertEqual(stub.client.rotate.call_args[0], ("asset-rot", 180))

    async def test_rotate_updates_image_in_place_without_advancing(self):
        """Successful rotate updates image_bytes/last_updated and notifies
        listeners, but does NOT set _force_refresh or call async_request_refresh
        (the corrected photo stays in place; no advance to a new image)."""
        stub = _make_stub(current_asset_id="asset-rot", image_bytes=b"sideways")
        stub.client.download_thumbnail = AsyncMock(side_effect=[b"old-edit", b"new-edit"])
        await JaxStreamCoordinator.async_rotate(stub, 90)
        self.assertEqual(stub.image_bytes, b"fake-jpeg")   # re-encoded via _transpose_jpeg
        self.assertIsNotNone(stub.image_last_updated)
        stub.async_update_listeners.assert_called_once()
        self.assertFalse(stub._force_refresh)
        stub.async_request_refresh.assert_not_called()

    async def test_rotate_uses_caller_asset_id_over_current(self):
        """asset_id arg overrides current_asset_id (drift-prevention)."""
        stub = _make_stub(current_asset_id="auto-advanced")
        stub.client.download_thumbnail = AsyncMock(side_effect=[b"old", b"new"])
        await JaxStreamCoordinator.async_rotate(stub, 90, asset_id="tap-time-id")
        self.assertEqual(stub.client.rotate.call_args[0][0], "tap-time-id")


# ---------------------------------------------------------------------------
# Tests: _refresh_adjacent_bytes past-window edge clearing (black-panel flash)
# ---------------------------------------------------------------------------


class TestRefreshAdjacentBytesPastEdge(unittest.IsolatedAsyncioTestCase):
    """At the past-window edge (_past_count == 0) the previous_image entity must
    serve NO bytes, not a stale prev photo. Otherwise a back-swipe slides the
    stale/black panel in (the black-panel/stale-photo flash). Proves the
    coordinator clears _prev_bytes and bumps the token only when it changes."""

    def _edge_stub(self):
        """Stub parked at the past edge: no future, no past, real prev bytes."""
        stub = _make_stub()
        stub._future_count = 0       # skip the next branch entirely
        stub._past_count = 0         # past edge -> prev must be cleared
        stub._next_bytes = b"\xff\xd8\xff next"
        stub.next_image_last_updated = None
        return stub

    async def test_clears_stale_prev_and_bumps_token(self):
        """A leftover prev photo is dropped and the token is rotated so the
        frontend refetches (gets a non-ok proxy response) and removes its panel."""
        stub = self._edge_stub()
        stub._prev_bytes = b"\xff\xd8\xff stale-prev"
        stub.prev_image_last_updated = None
        await JaxStreamCoordinator._refresh_adjacent_bytes(stub)
        self.assertIsNone(stub._prev_bytes)
        self.assertIsNotNone(stub.prev_image_last_updated)   # token rotated

    async def test_no_spurious_bump_when_already_empty(self):
        """When prev is already None, do NOT bump last_updated -- no phantom
        state_changed -> no spurious frontend refetch (pub/sub contract)."""
        stub = self._edge_stub()
        stub._prev_bytes = None
        sentinel = object()
        stub.prev_image_last_updated = sentinel
        await JaxStreamCoordinator._refresh_adjacent_bytes(stub)
        self.assertIsNone(stub._prev_bytes)
        self.assertIs(stub.prev_image_last_updated, sentinel)  # unchanged


class TestRemovePurgesFromRing(unittest.IsolatedAsyncioTestCase):
    """Removing the CURRENTLY displayed photo must purge it from the past-window
    ring, not just the album -- otherwise swipe-right / async_previous promotes
    the just-removed photo right back (it left the album but not the stream).

    The purge COMPACTS the ring (shifts older past slots forward to close the
    hole) so deep back-nav to the photos BEFORE the removed one is PRESERVED.
    These tests run the real async_next + on-disk _compact_past_slots, so they
    use a temp window dir with real slot files."""

    JPEG = b"\xff\xd8\xff"  # JPEG magic so any slot validation passes

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="jax_ring_test_")

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _slot_file(self, idx):
        return os.path.join(self._tmp, "window", f"slot_{idx:02d}.jpg")

    async def _real_exec(self, fn, *args):
        """Executor that actually runs the file-I/O helpers (compact, writes)."""
        return fn(*args)

    def _ring_stub(self, ring_size, head, slot_uuids, future_count, past_count):
        """Stub viewing slot_uuids[head] at head, with real slot files on disk and
        the REAL async_next so the advance mutates the ring like production."""
        stub = _make_stub(current_asset_id=slot_uuids[head])
        stub._ring_size = ring_size
        stub._past_size = 20
        stub._head = head
        stub._slot_uuids = list(slot_uuids)
        stub._slot_ratings = [0] * ring_size
        stub._slot_photo_info = [None] * ring_size
        stub._future_count = future_count
        stub._past_count = past_count
        stub._window_dir = os.path.join(self._tmp, "window")
        stub.disk_path = os.path.join(self._tmp, "random.jpg")
        stub._state_json_path = os.path.join(self._tmp, "state.json")
        # Real file I/O so _compact_past_slots and the writes actually run.
        stub.hass.async_add_executor_job = AsyncMock(side_effect=self._real_exec)
        # Bind the real slot-path + advance so production logic executes.
        stub._slot_path = lambda i: JaxStreamCoordinator._slot_path(stub, i)
        stub.async_next = lambda: JaxStreamCoordinator.async_next(stub)
        # New current comes from _fetch_next_slot -- a fresh uuid, never a ring id.
        stub._fetch_next_slot = AsyncMock(return_value=(self.JPEG + b"Y", "Y", 0, {}))
        # Lay down a slot file for every populated slot.
        os.makedirs(stub._window_dir, exist_ok=True)
        for i, uid in enumerate(slot_uuids):
            if uid is not None:
                with open(self._slot_file(i), "wb") as fh:
                    fh.write(self.JPEG + uid.encode())
        return stub

    async def test_compact_preserves_deep_back_nav(self):
        """Removing the current photo drops only it; the older history shifts
        forward and stays reachable (past_count preserved, no gap)."""
        # ring_size 8, head=3 viewing X; behind: P1(2), P2(1); ahead: F1(4).
        stub = self._ring_stub(
            ring_size=8, head=3,
            slot_uuids=[None, "P2", "P1", "X", "F1", None, None, None],
            future_count=1, past_count=2,
        )
        await JaxStreamCoordinator.async_remove(stub)
        # Advanced off X to the fetched next photo.
        self.assertEqual(stub._head, 4)
        self.assertEqual(stub.current_asset_id, "Y")
        # X is gone from every slot...
        self.assertNotIn("X", stub._slot_uuids)
        # ...and the back stack is intact: head-1 == P1, head-2 == P2.
        self.assertEqual(stub._slot_uuids[(stub._head - 1) % 8], "P1")
        self.assertEqual(stub._slot_uuids[(stub._head - 2) % 8], "P2")
        self.assertEqual(stub._past_count, 2)  # depth preserved, not truncated
        # Files moved too -- head-1 file carries P1's bytes, X's bytes overwritten.
        with open(self._slot_file((stub._head - 1) % 8), "rb") as fh:
            self.assertEqual(fh.read(), self.JPEG + b"P1")
        # Source album removal fired for the right asset.
        stub.client.remove_from_album.assert_called_once()
        self.assertEqual(stub.client.remove_from_album.call_args[0][1], "X")

    async def test_remove_current_no_prior_history(self):
        """With no past slots before the remove, the removed photo is the only
        thing async_next credits; compact must drive past_count back to 0."""
        stub = self._ring_stub(
            ring_size=8, head=3,
            slot_uuids=[None, None, None, "X", "F1", None, None, None],
            future_count=1, past_count=0,
        )
        await JaxStreamCoordinator.async_remove(stub)
        self.assertEqual(stub._past_count, 0)
        self.assertNotIn("X", stub._slot_uuids)
        # X's old slot file is gone (removed, not left dangling).
        self.assertFalse(os.path.exists(self._slot_file(3)))


if __name__ == "__main__":
    unittest.main()
