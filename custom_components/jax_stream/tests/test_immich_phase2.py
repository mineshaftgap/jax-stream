"""Phase 2 unit tests for new ImmichClient methods.

Tests: list_albums, set_rating, add_to_album, remove_from_album, get_asset_rating.
Runs with plain: python3 custom_components/jax_stream/tests/test_immich_phase2.py
No pytest, no HA, no package install required.

ASCII only -- no Unicode.
"""
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Allow direct import from the jax_stream/ directory without install
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from immich import ImmichAuthError, ImmichClient, ImmichConnError


def _make_client(session):
    """Return an ImmichClient wired to a mock session."""
    return ImmichClient(session, "https://immich.example.com", "test-api-key")


def _mock_resp(status=200, ok=True, json_data=None):
    """Build an aiohttp-style response mock."""
    resp = MagicMock()
    resp.status = status
    resp.ok = ok
    resp.json = AsyncMock(return_value=json_data if json_data is not None else {})
    return resp


def _session_with(method_name, resp):
    """Return a mock session whose named method returns an async context manager."""
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    getattr(session, method_name).return_value = cm
    return session


class TestGetAssetRating(unittest.IsolatedAsyncioTestCase):
    """get_asset_rating reads from exifInfo.rating, not top-level rating."""

    async def test_returns_exif_rating_integer(self):
        resp = _mock_resp(json_data={"exifInfo": {"rating": 4}})
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_rating("abc")
        self.assertEqual(result, 4)

    async def test_exif_none_returns_zero(self):
        resp = _mock_resp(json_data={"exifInfo": None})
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_rating("abc")
        self.assertEqual(result, 0)

    async def test_no_exif_key_returns_zero(self):
        resp = _mock_resp(json_data={})
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_rating("abc")
        self.assertEqual(result, 0)

    async def test_top_level_rating_ignored(self):
        # Pitfall 4: rating at top-level is irrelevant; exifInfo.rating wins.
        resp = _mock_resp(json_data={"rating": 5})
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_rating("abc")
        self.assertEqual(result, 0)


class TestSetRating(unittest.IsolatedAsyncioTestCase):
    """set_rating issues PUT /api/assets/{id} with {"rating": N}."""

    async def test_put_url_and_body(self):
        resp = _mock_resp()
        session = _session_with("put", resp)
        client = _make_client(session)
        await client.set_rating("abc", 3)
        call_kwargs = session.put.call_args
        self.assertTrue(
            call_kwargs[0][0].endswith("/api/assets/abc"),
            f"URL did not end with /api/assets/abc: {call_kwargs[0][0]}",
        )
        self.assertEqual(call_kwargs[1]["json"], {"rating": 3})


class TestAddToAlbum(unittest.IsolatedAsyncioTestCase):
    """add_to_album issues PUT /api/albums/{album_id}/assets with {"ids":[asset_id]}."""

    async def test_put_url_and_body(self):
        resp = _mock_resp()
        session = _session_with("put", resp)
        client = _make_client(session)
        await client.add_to_album("alb", "abc")
        call_kwargs = session.put.call_args
        self.assertTrue(
            call_kwargs[0][0].endswith("/api/albums/alb/assets"),
            f"URL did not end with /api/albums/alb/assets: {call_kwargs[0][0]}",
        )
        self.assertEqual(call_kwargs[1]["json"], {"ids": ["abc"]})


class TestRemoveFromAlbum(unittest.IsolatedAsyncioTestCase):
    """remove_from_album issues DELETE /api/albums/{album_id}/assets."""

    async def test_delete_url_and_body(self):
        resp = _mock_resp()
        session = _session_with("delete", resp)
        client = _make_client(session)
        await client.remove_from_album("alb", "abc")
        call_kwargs = session.delete.call_args
        self.assertTrue(
            call_kwargs[0][0].endswith("/api/albums/alb/assets"),
            f"URL did not end with /api/albums/alb/assets: {call_kwargs[0][0]}",
        )
        self.assertEqual(call_kwargs[1]["json"], {"ids": ["abc"]})


class TestListAlbums(unittest.IsolatedAsyncioTestCase):
    """list_albums issues GET /api/albums and returns the parsed list."""

    async def test_returns_album_list(self):
        albums = [{"id": "a1", "albumName": "Vacation"}]
        resp = _mock_resp(json_data=albums)
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.list_albums()
        call_kwargs = session.get.call_args
        self.assertTrue(
            call_kwargs[0][0].endswith("/api/albums"),
            f"URL did not end with /api/albums: {call_kwargs[0][0]}",
        )
        self.assertEqual(result, albums)


class TestGetAssetInfo(unittest.IsolatedAsyncioTestCase):
    """get_asset_info returns rating (from exifInfo) AND isEdited (top-level)."""

    async def test_returns_rating_and_isedited(self):
        resp = _mock_resp(json_data={
            "exifInfo": {"rating": 2, "make": "Apple", "model": "iPhone 15"},
            "isEdited": True,
            "localDateTime": "2024-03-15T10:00:00.000Z",
        })
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_info("abc")
        self.assertEqual(result["rating"], 2)
        self.assertEqual(result["isEdited"], True)
        self.assertEqual(result["date"], "2024-03-15T10:00:00.000Z")
        self.assertEqual(result["camera"], "Apple iPhone 15")

    async def test_defaults_when_fields_absent(self):
        resp = _mock_resp(json_data={})
        session = _session_with("get", resp)
        client = _make_client(session)
        result = await client.get_asset_info("abc")
        self.assertEqual(result["rating"], 0)
        self.assertEqual(result["isEdited"], False)
        self.assertEqual(result["date"], "")
        self.assertEqual(result["camera"], "")


class TestRotate(unittest.IsolatedAsyncioTestCase):
    """rotate issues PUT /api/assets/{id}/edits with an absolute rotate action."""

    async def test_put_url_and_body(self):
        resp = _mock_resp(json_data={"assetId": "abc"})
        session = _session_with("put", resp)
        client = _make_client(session)
        await client.rotate("abc", 90)
        call_kwargs = session.put.call_args
        self.assertTrue(
            call_kwargs[0][0].endswith("/api/assets/abc/edits"),
            f"URL did not end with /api/assets/abc/edits: {call_kwargs[0][0]}",
        )
        self.assertEqual(
            call_kwargs[1]["json"],
            {"edits": [{"action": "rotate", "parameters": {"angle": 90}}]},
        )


class TestDownloadThumbnailEdited(unittest.IsolatedAsyncioTestCase):
    """download_thumbnail(edited=True) appends &edited=true; falls back on error."""

    async def test_edited_true_appends_query(self):
        resp = _mock_resp(json_data=None)
        resp.read = AsyncMock(return_value=b"edited-bytes")
        session = _session_with("get", resp)
        client = _make_client(session)
        out = await client.download_thumbnail("abc", edited=True)
        self.assertEqual(out, b"edited-bytes")
        url = session.get.call_args[0][0]
        self.assertIn("size=preview", url)
        self.assertIn("edited=true", url)

    async def test_plain_has_no_edited_query(self):
        resp = _mock_resp(json_data=None)
        resp.read = AsyncMock(return_value=b"plain-bytes")
        session = _session_with("get", resp)
        client = _make_client(session)
        out = await client.download_thumbnail("abc")
        self.assertEqual(out, b"plain-bytes")
        self.assertNotIn("edited=true", session.get.call_args[0][0])

    async def test_edited_404_falls_back_to_original(self):
        # First (edited) call 404s -> ImmichConnError; second (plain) call succeeds.
        edited_resp = _mock_resp(status=404, ok=False)
        plain_resp = _mock_resp()
        plain_resp.read = AsyncMock(return_value=b"original-bytes")
        cm_edited = MagicMock()
        cm_edited.__aenter__ = AsyncMock(return_value=edited_resp)
        cm_edited.__aexit__ = AsyncMock(return_value=False)
        cm_plain = MagicMock()
        cm_plain.__aenter__ = AsyncMock(return_value=plain_resp)
        cm_plain.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.get.side_effect = [cm_edited, cm_plain]
        client = _make_client(session)
        out = await client.download_thumbnail("abc", edited=True)
        self.assertEqual(out, b"original-bytes")
        self.assertEqual(session.get.call_count, 2)


class TestErrorHandling(unittest.IsolatedAsyncioTestCase):
    """403 raises ImmichAuthError; 500 raises ImmichConnError."""

    async def test_403_raises_auth_error(self):
        resp = _mock_resp(status=403, ok=False)
        session = _session_with("put", resp)
        client = _make_client(session)
        with self.assertRaises(ImmichAuthError):
            await client.set_rating("abc", 3)

    async def test_500_raises_conn_error(self):
        resp = _mock_resp(status=500, ok=False)
        session = _session_with("get", resp)
        client = _make_client(session)
        with self.assertRaises(ImmichConnError):
            await client.list_albums()


if __name__ == "__main__":
    unittest.main()
