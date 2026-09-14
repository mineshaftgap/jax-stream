"""TDD tests for the first Jax Stream config-entry migration (GH issue #1).

Pre-fix entries wrote to the literal "default" disk subdir and their View
Assist Dashboard Options point at that path -- async_migrate_entry stamps
data["stream_subdir"] = "default" on any entry that does not already carry
one, using setdefault (never assignment) so an already-migrated or freshly
created entry's real slug is never clobbered.

Runs with plain: python3 custom_components/jax_stream/tests/test_migration.py
No pytest, no HA install required.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types
import unittest
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Minimal homeassistant stubs -- must cover every name jax_stream/__init__.py
# imports at module scope, or "import jax_stream" dies before any test body
# runs. Copied from the repaired test_frontend_setup.py stub (Task 0) plus
# ConfigEntryError (added by Task 4) so this file does not need a second
# stub-repair pass when Task 4 lands.
# ---------------------------------------------------------------------------


class _StaticPathConfig:
    """Stub for homeassistant.components.http.StaticPathConfig."""
    def __init__(self, url_path, path, cache_headers=True):
        self.url_path = url_path
        self.path = path
        self.cache_headers = cache_headers


_ha_http = types.SimpleNamespace(StaticPathConfig=_StaticPathConfig)

_extra_js_calls = []


def _add_extra_js_url(hass, url, es5=False):
    _extra_js_calls.append(url)


_ha_frontend = types.SimpleNamespace(add_extra_js_url=_add_extra_js_url)


class _FakeDUC:
    """Minimal DataUpdateCoordinator stub -- supports the
    DataUpdateCoordinator[bytes] generic subscript coordinator.py uses as a
    base class."""
    def __class_getitem__(cls, item):
        return cls


_HA_MOCKS = {
    "homeassistant": types.ModuleType("homeassistant"),
    "homeassistant.core": types.SimpleNamespace(
        HomeAssistant=object,
        ServiceCall=object,
        callback=lambda f: f,
    ),
    "homeassistant.const": types.SimpleNamespace(
        Platform=types.SimpleNamespace(
            IMAGE="image", BUTTON="button", NUMBER="number",
            SELECT="select", SENSOR="sensor", SWITCH="switch",
        ),
    ),
    # Must list every name __init__.py imports from homeassistant.exceptions,
    # or "import jax_stream" dies before any test body runs. ConfigEntryError
    # is added by Task 4; present here so Task 4 does not need to revisit this
    # stub.
    "homeassistant.exceptions": types.SimpleNamespace(
        HomeAssistantError=Exception,
        ServiceNotFound=Exception,
        ServiceValidationError=Exception,
        ConfigEntryError=Exception,
    ),
    "homeassistant.helpers": types.ModuleType("homeassistant.helpers"),
    "homeassistant.helpers.update_coordinator": types.SimpleNamespace(
        DataUpdateCoordinator=_FakeDUC,
        UpdateFailed=Exception,
    ),
    "homeassistant.helpers.aiohttp_client": types.SimpleNamespace(
        async_get_clientsession=lambda hass, verify_ssl=True: None,
    ),
    "homeassistant.helpers.entity_registry": types.SimpleNamespace(
        async_get=lambda hass: None,
    ),
    "homeassistant.helpers.config_validation": types.SimpleNamespace(
        entity_id=str,
        string=str,
        config_entry_only_config_schema=lambda domain: (lambda data: data),
    ),
    # __init__.py imports async_dispatcher_connect for the VACA gesture hook.
    "homeassistant.helpers.dispatcher": types.SimpleNamespace(
        async_dispatcher_connect=lambda *a, **k: (lambda: None),
    ),
    "homeassistant.util": types.ModuleType("homeassistant.util"),
    "homeassistant.util.dt": types.SimpleNamespace(utcnow=lambda: object()),
    "homeassistant.components.http": _ha_http,
    "homeassistant.components.frontend": _ha_frontend,
    "voluptuous": types.SimpleNamespace(
        Schema=lambda schema: (lambda data: data),
        Optional=lambda k: k,
        Required=lambda k: k,
        All=lambda *a: None,
        Coerce=lambda t: t,
        Range=lambda **kw: None,
        In=lambda container: None,
    ),
}

for _k, _v in _HA_MOCKS.items():
    sys.modules[_k] = _v  # type: ignore[assignment]

# Add custom_components/ to path so jax_stream imports work as a package.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

# Prevent coordinator/immich imports from pulling in missing deps.
sys.modules.setdefault("PIL", types.ModuleType("PIL"))
sys.modules.setdefault("PIL.Image", types.ModuleType("PIL.Image"))
sys.modules.setdefault("PIL.ImageOps", types.ModuleType("PIL.ImageOps"))
sys.modules.setdefault("PIL.ExifTags", types.ModuleType("PIL.ExifTags"))
sys.modules.setdefault("aiohttp", types.ModuleType("aiohttp"))

import jax_stream  # noqa: E402  (the __init__.py under test)
from jax_stream.const import CONF_STREAM_SUBDIR, DEFAULT_STREAM_SUBDIR  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeEntry:
    """Minimal ConfigEntry stand-in: version, minor_version, data, options."""

    def __init__(self, version, minor_version, data):
        self.version = version
        self.minor_version = minor_version
        self.data = dict(data)
        self.options = {}
        self.entry_id = "test_entry_id"
        self.title = "Test Stream"


class _FakeConfigEntries:
    """Fake hass.config_entries -- async_update_entry writes kwargs onto the entry."""

    def async_update_entry(self, entry, **kw):
        if "data" in kw:
            entry.data = kw["data"]
        if "version" in kw:
            entry.version = kw["version"]
        if "minor_version" in kw:
            entry.minor_version = kw["minor_version"]


def _make_hass():
    hass = MagicMock()
    hass.config_entries = _FakeConfigEntries()
    return hass


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAsyncMigrateEntry(unittest.TestCase):
    def test_pre_fix_entry_stamps_default(self):
        """version=1, minor_version=1, no stream_subdir -> stamped to "default"."""
        hass = _make_hass()
        entry = _FakeEntry(
            version=1, minor_version=1,
            data={"url": "http://x", "api_key": "k", "album_id": "a"},
        )
        result = _run(jax_stream.async_migrate_entry(hass, entry))
        self.assertTrue(result)
        self.assertEqual(entry.data[CONF_STREAM_SUBDIR], DEFAULT_STREAM_SUBDIR)
        self.assertEqual(entry.minor_version, 2)
        self.assertEqual(entry.version, 1)
        # No other data key lost or altered.
        self.assertEqual(entry.data["url"], "http://x")
        self.assertEqual(entry.data["api_key"], "k")
        self.assertEqual(entry.data["album_id"], "a")

    def test_already_migrated_entry_not_overwritten(self):
        """minor_version=2 with a real slug -> value is NOT overwritten to default."""
        hass = _make_hass()
        entry = _FakeEntry(
            version=1, minor_version=2,
            data={"url": "http://x", CONF_STREAM_SUBDIR: "guest-room"},
        )
        result = _run(jax_stream.async_migrate_entry(hass, entry))
        self.assertTrue(result)
        self.assertEqual(entry.data[CONF_STREAM_SUBDIR], "guest-room")

    def test_entry_with_slug_at_minor_version_1_not_clobbered(self):
        """Defensive: an entry that already carries a slug at minor_version=1
        (e.g. hand-edited .storage) keeps its value -- setdefault never clobbers."""
        hass = _make_hass()
        entry = _FakeEntry(
            version=1, minor_version=1,
            data={"url": "http://x", CONF_STREAM_SUBDIR: "guest-room"},
        )
        result = _run(jax_stream.async_migrate_entry(hass, entry))
        self.assertTrue(result)
        self.assertEqual(entry.data[CONF_STREAM_SUBDIR], "guest-room")
        self.assertEqual(entry.minor_version, 2)

    def test_future_version_downgrade_unsupported(self):
        """version=2 (newer major) -> returns False, data is not mutated."""
        hass = _make_hass()
        original_data = {"url": "http://x"}
        entry = _FakeEntry(version=2, minor_version=1, data=original_data)
        result = _run(jax_stream.async_migrate_entry(hass, entry))
        self.assertFalse(result)
        self.assertEqual(entry.data, original_data)
        self.assertNotIn(CONF_STREAM_SUBDIR, entry.data)


class TestSourceWiring(unittest.TestCase):
    """Source-contract assertions for Task 4's async_setup_entry rewiring.

    Reading __init__.py's own bytes (a grep-equivalent) rather than driving a
    full async_setup_entry run -- the latter needs a much heavier hass/coordinator
    fake for no extra confidence here. This confirms the DEFAULT_STREAM_SUBDIR
    hardcode is gone and entry.data is read directly; the behavioral proof that
    two entries actually resolve to distinct, isolated disk paths on real
    hardware is Task 7's on-device multi-stream suite.
    """

    def test_init_reads_stream_subdir_from_entry_data(self):
        init_path = os.path.join(_PKG_ROOT, "jax_stream", "__init__.py")
        with open(init_path, "r") as f:
            src = f.read()
        self.assertIn("entry.data.get(CONF_STREAM_SUBDIR)", src)
        self.assertNotIn("stream_subdir=DEFAULT_STREAM_SUBDIR", src)


if __name__ == "__main__":
    unittest.main()
