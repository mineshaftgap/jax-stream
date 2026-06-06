"""RED-phase test for Task 2 (immich.py).

Minimal failing test that verifies candidates_from_batch behavior.
Runs with: python3 custom_components/jax_stream/tests/test_immich_red.py
"""
import os
import sys
import unittest

# Allow importing from the jax_stream package without install
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from immich import candidates_from_batch


class TestCandidatesFromBatchBasic(unittest.TestCase):
    """Minimal RED gate: portrait rejected, landscape-wide accepted."""

    def _asset(self, aid, w, h, o):
        return {"id": aid, "exifInfo": {"exifImageWidth": w, "exifImageHeight": h, "orientation": o}}

    def test_landscape_wide_accepted(self):
        a = self._asset("abc", 4000, 3000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=True), ["abc"])

    def test_portrait_rejected_in_landscape_mode(self):
        a = self._asset("xyz", 3000, 4000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=True), [])

    def test_orientation_6_swap_accepts_stored_portrait(self):
        # EXIF 6: stored 3000x4000 -> after swap 4000x3000 -> landscape, keep
        a = self._asset("swap6", 3000, 4000, 6)
        self.assertEqual(candidates_from_batch([a], landscape=True), ["swap6"])

    def test_no_landscape_filter_passes_everything(self):
        a = self._asset("p", 3000, 4000, 1)
        self.assertEqual(candidates_from_batch([a], landscape=False), ["p"])


if __name__ == "__main__":
    unittest.main()
