"""Unit tests for the per-entry stream subdir slug/uniqueness helpers (GH issue #1).

_stream.py is pure python (no HA imports), so this runs with plain stdlib
unittest -- no HA install, no pytest, no voluptuous required.

Runs with plain: python3 custom_components/jax_stream/tests/test_stream_subdir.py

ASCII only -- no Unicode.
"""
from __future__ import annotations

import os
import sys
import types
import unittest

# Add custom_components/ to path, same pattern as test_frontend_setup.py:95-98.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

# `import jax_stream._stream` would normally execute the real jax_stream/__init__.py
# first (Python always initializes the parent package before a submodule), which
# pulls in voluptuous and homeassistant -- exactly what this pure-python unit test
# is meant to avoid. Register a placeholder "jax_stream" package object with the
# real on-disk __path__ so Python's import machinery resolves jax_stream._stream
# and jax_stream.const to the REAL files without ever running jax_stream/__init__.py.
if "jax_stream" not in sys.modules:
    _pkg_dir = os.path.join(_PKG_ROOT, "jax_stream")
    _fake_pkg = types.ModuleType("jax_stream")
    _fake_pkg.__path__ = [_pkg_dir]
    sys.modules["jax_stream"] = _fake_pkg

from jax_stream._stream import slugify_stream_name, subdir_in_use  # noqa: E402
from jax_stream.const import STREAM_NAME_RE, MAX_STREAM_SUBDIR_LEN  # noqa: E402


class TestSlugifyStreamName(unittest.TestCase):
    """Case table covering the derivation rule and its security invariants."""

    CASES = [
        ("Living Room", "living-room"),
        ("Guest  Room", "guest-room"),          # double space collapses
        ("Kids_Photos", "kids_photos"),          # underscore preserved
        ("Default", "default"),                  # lowercased; caller handles collision
        ("2026", "2026"),                        # digits-only is valid
        ("", ""),
        ("   ", ""),
        ("!!!", ""),
        ("...", ""),
    ]

    def test_case_table(self):
        for name, expected in self.CASES:
            with self.subTest(name=name):
                self.assertEqual(slugify_stream_name(name), expected)

    def test_path_traversal_input_is_neutralized(self):
        result = slugify_stream_name("../../etc/passwd")
        self.assertTrue(
            STREAM_NAME_RE.match(result) if result else True,
            f"non-empty result {result!r} must match STREAM_NAME_RE",
        )
        self.assertNotIn(".", result)
        self.assertNotIn("/", result)

    def test_overlong_name_is_truncated(self):
        result = slugify_stream_name("a" * 200)
        self.assertLessEqual(len(result), MAX_STREAM_SUBDIR_LEN)
        self.assertFalse(result.endswith("-"))
        self.assertFalse(result.endswith("_"))

    def test_non_ascii_input_yields_ascii_slug(self):
        # "Cafe Photos" with an accented e (U+00E9), built via chr() so the
        # source file itself stays ASCII-only per repo policy.
        name = "Caf" + chr(0xE9) + " Photos"
        result = slugify_stream_name(name)
        self.assertTrue(result.isascii())
        if result:
            self.assertTrue(STREAM_NAME_RE.match(result))

    def test_every_nonempty_result_matches_stream_name_re(self):
        """Property-style assertion over the whole case table -- the security invariant."""
        names = [c[0] for c in self.CASES] + [
            "../../etc/passwd",
            "a" * 200,
            "Caf" + chr(0xE9) + " Photos",
            "Living Room #2!",
            "___---___",
        ]
        for name in names:
            with self.subTest(name=name):
                result = slugify_stream_name(name)
                if result:
                    self.assertTrue(
                        STREAM_NAME_RE.match(result),
                        f"{name!r} -> {result!r} does not match STREAM_NAME_RE",
                    )

    def test_non_str_and_empty_rejected(self):
        self.assertEqual(slugify_stream_name(None), "")
        self.assertEqual(slugify_stream_name(""), "")


class TestSubdirInUse(unittest.TestCase):
    def test_exact_match(self):
        self.assertTrue(subdir_in_use("default", ["default"]))

    def test_case_insensitive_match(self):
        self.assertTrue(subdir_in_use("Default", ["default"]))

    def test_no_match(self):
        self.assertFalse(subdir_in_use("den", ["default"]))

    def test_empty_existing_list(self):
        self.assertFalse(subdir_in_use("den", []))


if __name__ == "__main__":
    unittest.main()
