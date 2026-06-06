"""Table-driven unit test for candidates_from_batch -- CORE-05 proof.

Tests the landscape filter port across all 8 EXIF orientations plus edge cases.
Runs with plain: python3 custom_components/jax_stream/tests/test_filter.py
No pytest, no HA, no package install required.

ASCII only -- no Unicode.
"""
import os
import sys
import unittest

# Allow direct import of immich from the jax_stream/ directory without install
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from immich import candidates_from_batch


def asset(aid, w, h, o):
    """Build a minimal Immich asset dict with EXIF dimensions and orientation."""
    return {
        "id": aid,
        "exifInfo": {
            "exifImageWidth": w,
            "exifImageHeight": h,
            "orientation": o,
        },
    }


class TestOrientationsLandscapeWide(unittest.TestCase):
    """EXIF orientations 1-4 on a wide image: all must be KEPT.

    Stored as 4000x3000 (w>h). No swap for orientations 1-4.
    """

    def _wide(self, o):
        return asset("wide_%d" % o, 4000, 3000, o)

    def test_orientation_1_wide_kept(self):
        self.assertEqual(candidates_from_batch([self._wide(1)], landscape=True), ["wide_1"])

    def test_orientation_2_wide_kept(self):
        self.assertEqual(candidates_from_batch([self._wide(2)], landscape=True), ["wide_2"])

    def test_orientation_3_wide_kept(self):
        self.assertEqual(candidates_from_batch([self._wide(3)], landscape=True), ["wide_3"])

    def test_orientation_4_wide_kept(self):
        self.assertEqual(candidates_from_batch([self._wide(4)], landscape=True), ["wide_4"])


class TestOrientationsStoredPortraitSwap(unittest.TestCase):
    """EXIF orientations 5-8 on a stored-portrait image: all must be KEPT.

    Stored as 3000x4000 (w<h in file).  Swap makes display dims 4000x3000 (w>h).
    This is the core v41 swap rule (lines 204-205): orientation 5/6/7/8 means the
    sensor was rotated 90 degrees, so W and H are reversed in the EXIF fields.
    After swap, display width is 4000 > height 3000 => landscape, keep.
    """

    def _portrait_stored(self, o):
        return asset("swap_%d" % o, 3000, 4000, o)

    def test_orientation_5_stored_portrait_kept(self):
        self.assertEqual(candidates_from_batch([self._portrait_stored(5)], landscape=True), ["swap_5"])

    def test_orientation_6_stored_portrait_kept(self):
        self.assertEqual(candidates_from_batch([self._portrait_stored(6)], landscape=True), ["swap_6"])

    def test_orientation_7_stored_portrait_kept(self):
        self.assertEqual(candidates_from_batch([self._portrait_stored(7)], landscape=True), ["swap_7"])

    def test_orientation_8_stored_portrait_kept(self):
        self.assertEqual(candidates_from_batch([self._portrait_stored(8)], landscape=True), ["swap_8"])


class TestOrientationsStoredWideSwap(unittest.TestCase):
    """EXIF orientations 5-8 on a stored-WIDE image: all must be REJECTED.

    Stored as 4000x3000 (w>h in file).  After swap (orientation 5-8), display
    dims become 3000x4000 (w<h) -- portrait in display space => rejected.
    """

    def _wide_stored(self, o):
        return asset("wide_swap_%d" % o, 4000, 3000, o)

    def test_orientation_5_wide_stored_rejected(self):
        self.assertEqual(candidates_from_batch([self._wide_stored(5)], landscape=True), [])

    def test_orientation_6_wide_stored_rejected(self):
        self.assertEqual(candidates_from_batch([self._wide_stored(6)], landscape=True), [])

    def test_orientation_7_wide_stored_rejected(self):
        self.assertEqual(candidates_from_batch([self._wide_stored(7)], landscape=True), [])

    def test_orientation_8_wide_stored_rejected(self):
        self.assertEqual(candidates_from_batch([self._wide_stored(8)], landscape=True), [])


class TestEdgeCases(unittest.TestCase):
    """Edge cases: portrait, null dims, missing id, non-numeric orientation."""

    def test_portrait_orientation_1_rejected(self):
        """True portrait (w<h, orientation 1): rejected in landscape mode."""
        a = asset("portrait_1", 3000, 4000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_exif_missing_rejected(self):
        """Asset with no exifInfo: skipped (not w or not h)."""
        a = {"id": "no_exif"}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_null_width_skipped(self):
        """Width None: skipped."""
        a = {"id": "null_w", "exifInfo": {"exifImageWidth": None, "exifImageHeight": 3000, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_null_height_skipped(self):
        """Height None: skipped."""
        a = {"id": "null_h", "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": None, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_missing_id_skipped(self):
        """Asset without 'id' key: skipped regardless of orientation."""
        a = {"exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_none_id_skipped(self):
        """Asset with id=None: skipped."""
        a = {"id": None, "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_non_numeric_orientation_treated_as_1(self):
        """Non-numeric orientation 'foo': treated as 1 (no swap), no exception raised."""
        # Wide stored (4000x3000) with orientation "foo" -> treated as 1 -> no swap -> w>h -> kept
        a = {"id": "bad_orient", "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000, "orientation": "foo"}}
        self.assertEqual(candidates_from_batch([a], landscape=True), ["bad_orient"])

    def test_orientation_missing_treated_as_1(self):
        """Missing orientation key: treated as 1 (no swap)."""
        a = {"id": "no_orient", "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000}}
        self.assertEqual(candidates_from_batch([a], landscape=True), ["no_orient"])

    def test_non_numeric_width_skipped_not_crashed(self):
        """Non-numeric width (string): asset SKIPPED, no exception (MD-02 / T-01-07)."""
        a = {"id": "bad_w", "exifInfo": {"exifImageWidth": "wide", "exifImageHeight": 3000, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_non_numeric_height_skipped_not_crashed(self):
        """Non-numeric height (string): asset SKIPPED, no exception (MD-02 / T-01-07)."""
        a = {"id": "bad_h", "exifInfo": {"exifImageWidth": 4000, "exifImageHeight": "tall", "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_malformed_dims_do_not_drop_good_assets_in_batch(self):
        """A malformed-dimension asset is skipped while a valid wide asset in the same batch is still kept."""
        bad = {"id": "bad", "exifInfo": {"exifImageWidth": "x", "exifImageHeight": "y", "orientation": 1}}
        good = asset("good", 4000, 3000, 1)
        self.assertEqual(candidates_from_batch([bad, good], landscape=True), ["good"])


class TestLandscapeFalse(unittest.TestCase):
    """landscape=False: every asset with an id passes through."""

    def test_portrait_passes_in_non_landscape_mode(self):
        """Portrait image (w<h) keeps through when landscape=False."""
        a = asset("portrait_pass", 3000, 4000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=False), ["portrait_pass"])

    def test_wide_passes_in_non_landscape_mode(self):
        """Wide image keeps through when landscape=False."""
        a = asset("wide_pass", 4000, 3000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=False), ["wide_pass"])

    def test_no_exif_passes_in_non_landscape_mode(self):
        """Asset with no exifInfo passes when landscape=False."""
        a = {"id": "no_exif_pass"}
        self.assertEqual(candidates_from_batch([a], landscape=False), ["no_exif_pass"])

    def test_missing_id_still_skipped_in_non_landscape_mode(self):
        """Missing id is always skipped, even in non-landscape mode."""
        a = {"exifInfo": {"exifImageWidth": 4000, "exifImageHeight": 3000, "orientation": 1}}
        self.assertEqual(candidates_from_batch([a], landscape=False), [])

    def test_multiple_assets_all_pass(self):
        """Multiple mixed assets all pass when landscape=False (ids present)."""
        assets = [
            asset("a1", 3000, 4000, 1),   # portrait
            asset("a2", 4000, 3000, 6),   # stored wide with swap orientation
            {"id": "a3"},                  # no exif
        ]
        self.assertEqual(candidates_from_batch(assets, landscape=False), ["a1", "a2", "a3"])


class TestBatchMix(unittest.TestCase):
    """Mixed batch: only landscape-qualifying assets returned."""

    def test_mixed_batch_landscape_mode(self):
        """Batch of portrait + wide + swap-accepted + swap-rejected: only wide + swap-accepted kept."""
        batch = [
            asset("portrait", 3000, 4000, 1),   # portrait, rejected
            asset("wide", 4000, 3000, 1),        # landscape, kept
            asset("swap_k", 3000, 4000, 6),      # stored portrait, swap -> landscape, kept
            asset("swap_r", 4000, 3000, 8),      # stored wide, swap -> portrait, rejected
        ]
        result = candidates_from_batch(batch, landscape=True)
        self.assertEqual(result, ["wide", "swap_k"])


if __name__ == "__main__":
    unittest.main()
