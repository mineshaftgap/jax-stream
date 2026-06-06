"""TDD tests for Phase 3 frontend module delivery (FE-01).

Tests that async_setup registers the static route and module URL with
the correct content hash, using a minimal HA stub -- no real HA install.

RED gate: These tests fail before _compute_js_hash is added to __init__.py
and before the Phase 3 registration block is inserted in async_setup.

Runs with plain: python3 custom_components/jax_stream/tests/test_frontend_setup.py
No pytest, no HA install required.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, call

# ---------------------------------------------------------------------------
# Minimal homeassistant stubs
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
    """Stub that records calls."""
    _extra_js_calls.append(url)


_ha_frontend = types.SimpleNamespace(add_extra_js_url=_add_extra_js_url)

_HA_MOCKS = {
    "homeassistant": types.ModuleType("homeassistant"),
    "homeassistant.core": types.SimpleNamespace(
        HomeAssistant=object,
        ServiceCall=object,
        callback=lambda f: f,
    ),
    "homeassistant.const": types.SimpleNamespace(
        Platform=types.SimpleNamespace(
            IMAGE="image", BUTTON="button", SELECT="select", SWITCH="switch"
        ),
    ),
    "homeassistant.exceptions": types.SimpleNamespace(
        HomeAssistantError=Exception,
        ServiceValidationError=Exception,
    ),
    "homeassistant.helpers": types.ModuleType("homeassistant.helpers"),
    "homeassistant.helpers.update_coordinator": types.SimpleNamespace(
        DataUpdateCoordinator=object,
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
    ),
    "homeassistant.components.http": _ha_http,
    "homeassistant.components.frontend": _ha_frontend,
    "voluptuous": types.SimpleNamespace(
        Schema=lambda schema: (lambda data: data),
        Optional=lambda k: k,
        Required=lambda k: k,
        All=lambda *a: None,
        Coerce=lambda t: t,
        Range=lambda **kw: None,
    ),
}

for _k, _v in _HA_MOCKS.items():
    sys.modules[_k] = _v  # type: ignore[assignment]

# Add custom_components/ to path so jax_stream imports work as a package.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

# Prevent coordinator/immich imports from pulling in missing deps
sys.modules.setdefault("PIL", types.ModuleType("PIL"))
sys.modules.setdefault("PIL.Image", types.ModuleType("PIL.Image"))
sys.modules.setdefault("PIL.ImageOps", types.ModuleType("PIL.ImageOps"))
sys.modules.setdefault("PIL.ExifTags", types.ModuleType("PIL.ExifTags"))
sys.modules.setdefault("aiohttp", types.ModuleType("aiohttp"))

import jax_stream  # noqa: E402  (the __init__.py under test)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_hass(js_path: str) -> MagicMock:
    """Return a minimal hass stub with the APIs Phase 3 needs."""
    hass = MagicMock()
    hass.data = {}
    hass.services = MagicMock()
    hass.services.async_register = MagicMock()

    # async_add_executor_job: runs fn(*args) synchronously inside an awaitable
    async def _executor(fn, *args):
        return fn(*args)

    hass.async_add_executor_job = _executor

    # hass.http.async_register_static_paths: records the call
    http_mock = MagicMock()
    http_mock.async_register_static_paths = AsyncMock(return_value=None)
    hass.http = http_mock

    return hass


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestComputeJsHash(unittest.TestCase):
    """_compute_js_hash must return first 12 hex chars of sha256 of file bytes."""

    def test_hash_matches_sha256(self):
        content = b"test content for hash"
        expected = hashlib.sha256(content).hexdigest()[:12]
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(content)
            fname = f.name
        try:
            result = jax_stream._compute_js_hash(fname)
            self.assertEqual(result, expected)
        finally:
            os.unlink(fname)

    def test_hash_is_12_chars(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"abc")
            fname = f.name
        try:
            result = jax_stream._compute_js_hash(fname)
            self.assertEqual(len(result), 12)
        finally:
            os.unlink(fname)

    def test_different_bytes_give_different_hash(self):
        with tempfile.NamedTemporaryFile(delete=False) as f1, \
             tempfile.NamedTemporaryFile(delete=False) as f2:
            f1.write(b"version one")
            f2.write(b"version two")
            n1, n2 = f1.name, f2.name
        try:
            h1 = jax_stream._compute_js_hash(n1)
            h2 = jax_stream._compute_js_hash(n2)
            self.assertNotEqual(h1, h2)
        finally:
            os.unlink(n1)
            os.unlink(n2)


class TestAsyncSetupRegistration(unittest.TestCase):
    """async_setup must compute hash, register static path, and call add_extra_js_url."""

    def setUp(self):
        _extra_js_calls.clear()

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_static_path_registered(self):
        """async_register_static_paths called with correct url_path."""
        content = b"jax stream js bytes"
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(content)
            js_tmp = f.name
        try:
            # Patch the file location the integration will use
            original_file = jax_stream.__file__
            jax_stream.__file__ = os.path.join(os.path.dirname(js_tmp), "__init__.py")
            # Temporarily put the JS file at JS_FILENAME relative to __file__
            import shutil
            js_dest = os.path.join(
                os.path.dirname(js_tmp),
                jax_stream.JS_FILENAME,  # must equal "jax_stream.js"
            )
            shutil.copy(js_tmp, js_dest)
            try:
                hass = _make_hass(js_dest)
                self._run(jax_stream.async_setup(hass, {}))
                calls = hass.http.async_register_static_paths.call_args_list
                self.assertEqual(len(calls), 1,
                    "async_register_static_paths must be called exactly once")
                configs = calls[0][0][0]  # first positional arg (list)
                self.assertEqual(len(configs), 1)
                cfg = configs[0]
                self.assertEqual(cfg.url_path, jax_stream.JS_ROUTE_PATH)
                self.assertTrue(cfg.cache_headers)
            finally:
                if os.path.exists(js_dest):
                    os.unlink(js_dest)
                jax_stream.__file__ = original_file
        finally:
            if os.path.exists(js_tmp):
                os.unlink(js_tmp)

    def test_add_extra_js_url_called_with_hash(self):
        """add_extra_js_url called once with ?v={sha256[:12]} in the URL."""
        content = b"deterministic bytes"
        expected_hash = hashlib.sha256(content).hexdigest()[:12]
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(content)
            js_tmp = f.name
        try:
            original_file = jax_stream.__file__
            import shutil
            js_dest = os.path.join(
                os.path.dirname(js_tmp),
                jax_stream.JS_FILENAME,
            )
            shutil.copy(js_tmp, js_dest)
            jax_stream.__file__ = os.path.join(os.path.dirname(js_dest), "__init__.py")
            try:
                hass = _make_hass(js_dest)
                self._run(jax_stream.async_setup(hass, {}))
                self.assertEqual(len(_extra_js_calls), 1,
                    "add_extra_js_url must be called exactly once")
                url = _extra_js_calls[0]
                self.assertIn(jax_stream.JS_ROUTE_PATH, url)
                self.assertIn("?v=", url)
                self.assertTrue(url.endswith(expected_hash),
                    f"URL {url!r} must end with hash {expected_hash!r}")
            finally:
                if os.path.exists(js_dest):
                    os.unlink(js_dest)
                jax_stream.__file__ = original_file
        finally:
            if os.path.exists(js_tmp):
                os.unlink(js_tmp)

    def test_add_extra_js_url_not_awaited(self):
        """add_extra_js_url stub is sync (not a coroutine); calling it must not raise."""
        # If the code incorrectly does "await add_extra_js_url(...)", the sync stub
        # would return None and awaiting None raises TypeError. A passing test confirms
        # the implementation does NOT await the call.
        content = b"bytes"
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(content)
            js_tmp = f.name
        try:
            original_file = jax_stream.__file__
            import shutil
            js_dest = os.path.join(os.path.dirname(js_tmp), jax_stream.JS_FILENAME)
            shutil.copy(js_tmp, js_dest)
            jax_stream.__file__ = os.path.join(os.path.dirname(js_dest), "__init__.py")
            try:
                hass = _make_hass(js_dest)
                # Must not raise TypeError from awaiting a non-coroutine
                self._run(jax_stream.async_setup(hass, {}))
            finally:
                if os.path.exists(js_dest):
                    os.unlink(js_dest)
                jax_stream.__file__ = original_file
        finally:
            if os.path.exists(js_tmp):
                os.unlink(js_tmp)


if __name__ == "__main__":
    unittest.main()
