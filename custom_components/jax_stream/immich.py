"""Immich HTTP client and landscape filter for Jax Stream.

Ported from shell_scripts/jax_stream_action.sh v41 engine (build_body,
candidates_from_batch, gather_candidates, download_asset HTTP half).

NO homeassistant import at module scope -- only stdlib + aiohttp -- so
candidates_from_batch stays importable and unit-testable without HA.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

# aiohttp is available inside HA at runtime; guard the import so that
# candidates_from_batch (a pure function) stays importable in unit tests
# that run without the HA/aiohttp environment installed.
try:
    import aiohttp
except ImportError:  # pragma: no cover
    aiohttp = None  # type: ignore[assignment]

# Relative import works inside the HA package; absolute fallback for unit tests
# that add the jax_stream/ dir to sys.path and import `immich` directly.
try:
    from .const import BATCH_SIZE, RETRY_CAP, THUMB_SIZE
except ImportError:
    BATCH_SIZE = 25       # v41 JAX_BATCH_SIZE
    RETRY_CAP = 4         # v41 JAX_RETRY_CAP
    THUMB_SIZE = "preview"  # v41 thumbnail size

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Error hierarchy
# ---------------------------------------------------------------------------


class ImmichError(Exception):
    """Base class for all Immich errors."""


class ImmichAuthError(ImmichError):
    """Raised on HTTP 401/403 -- maps to config_flow 'invalid_auth'."""


class ImmichConnError(ImmichError):
    """Raised on network errors or HTTP 5xx -- maps to 'cannot_connect'."""


class NoLandscapeSurvivor(ImmichError):
    """Raised when all retry attempts yielded zero landscape candidates.

    The coordinator should catch this and keep the last-good image (D-12).
    """

    def __init__(self, album_id: str) -> None:
        super().__init__(f"No landscape survivor after retries (album: {album_id})")
        self.album_id = album_id


# ---------------------------------------------------------------------------
# Pure filter function (unit-testable without HA)
# ---------------------------------------------------------------------------


def candidates_from_batch(assets: list[dict], landscape: bool) -> list[str]:
    """Return qualifying asset IDs from an Immich /api/search/random response.

    Ported VERBATIM from jax_stream_action.sh candidates_from_batch()
    lines 188-209 (the inline python3 block is already Python).

    When landscape=True:
      - Assets missing "id" are skipped.
      - Assets with null/missing EXIF width or height are skipped.
      - EXIF orientations 5,6,7,8 indicate the sensor was rotated 90 degrees;
        swapping W/H recovers the display dimensions.
      - Only assets with display W > H (landscape) are kept.

    When landscape=False:
      - Every asset with an "id" passes through unconditionally.
    """
    out: list[str] = []
    for a in assets:
        aid = a.get("id")
        if not aid:
            continue
        if landscape:
            ex = a.get("exifInfo") or {}
            # Coerce dimensions defensively: a malformed asset (non-numeric or
            # missing w/h) must be SKIPPED, never crash the batch. A raised
            # TypeError here is not an ImmichError, so it would bypass the
            # coordinator's keep-last-good guard and fail the whole tick (T-01-07).
            try:
                w = int(ex.get("exifImageWidth") or 0)
                h = int(ex.get("exifImageHeight") or 0)
            except (TypeError, ValueError):
                continue
            if not w or not h:
                continue
            try:
                o = int(ex.get("orientation") or 1)
            except (TypeError, ValueError):
                o = 1
            if o in (5, 6, 7, 8):
                w, h = h, w
            if not (w > h):
                continue
        out.append(aid)
    return out


# ---------------------------------------------------------------------------
# Async HTTP client
# ---------------------------------------------------------------------------


class ImmichClient:
    """Async Immich HTTP client using an injected aiohttp.ClientSession.

    The caller (coordinator / config_flow) is responsible for constructing
    and closing the session (typically via async_get_clientsession from HA,
    with verify_ssl=not allow_insecure per D-08).

    NEVER log api_key -- it must remain in the instance only.
    """

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        api_key: str,
    ) -> None:
        # Strip trailing slash (mirrors v41 HOST="${HOST%/}" line 58)
        self._host = host.rstrip("/")
        self._session = session
        # Build headers exactly once; api_key must never be written to logs
        self._headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json",
        }

    @property
    def host(self) -> str:
        """Immich server base URL (no trailing slash). Safe to expose -- no api_key."""
        return self._host

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _post_json(self, path: str, body: dict) -> list[dict]:
        """POST JSON body to path; return parsed JSON response.

        Raises:
            ImmichAuthError: on HTTP 401 or 403.
            ImmichConnError: on network error, timeout, or other non-2xx.
        """
        url = self._host + path
        try:
            async with self._session.post(
                url, json=body, headers=self._headers
            ) as resp:
                if resp.status in (401, 403):
                    raise ImmichAuthError(f"Auth error {resp.status} from {path}")
                if not resp.ok:
                    raise ImmichConnError(
                        f"Unexpected HTTP {resp.status} from {path}"
                    )
                return await resp.json()
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(f"Connection error on {path}: {exc}") from exc

    async def _get_bytes(self, path: str) -> bytes:
        """GET path; return raw bytes.

        Raises:
            ImmichAuthError: on HTTP 401 or 403.
            ImmichConnError: on network error, timeout, or other non-2xx.
        """
        url = self._host + path
        try:
            async with self._session.get(url, headers=self._headers) as resp:
                if resp.status in (401, 403):
                    raise ImmichAuthError(f"Auth error {resp.status} from {path}")
                if not resp.ok:
                    raise ImmichConnError(
                        f"Unexpected HTTP {resp.status} from {path}"
                    )
                return await resp.read()
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(f"Connection error on {path}: {exc}") from exc

    # ------------------------------------------------------------------
    # Public API consumed by coordinator and config_flow
    # ------------------------------------------------------------------

    async def validate(self, album_id: str) -> None:
        """Validate connectivity and credentials by hitting /api/search/random.

        D-10: connection test used by config_flow before creating the entry.
        Let ImmichAuthError / ImmichConnError propagate so the caller can map
        them to config-flow form errors.
        """
        body: dict = {
            "albumIds": [album_id],
            "type": "IMAGE",
            "size": 1,
        }
        await self._post_json("/api/search/random", body)

    async def random_landscape(self, settings: object) -> str:
        """Return one asset ID suitable for display.

        Port of gather_candidates (v41 lines 212-238) for needed=1 (queue
        deferred, D-11).

        Args:
            settings: object with attributes:
                album_id: str
                landscape: bool
                batch_size: int
                retry_cap: int

        Returns:
            A single asset ID (str).

        Raises:
            NoLandscapeSurvivor: when all retry attempts yield zero survivors
                (D-12: the coordinator should catch this and keep last-good).
            ImmichAuthError: propagated immediately (not retried).
        """
        needed = 1
        fetch_size = settings.batch_size if settings.landscape else needed
        collected: list[str] = []

        for _attempt in range(settings.retry_cap):
            body: dict = {
                "albumIds": [settings.album_id],
                "type": "IMAGE",
                "size": fetch_size,
            }
            if settings.landscape:
                body["withExif"] = True   # hydrate exifInfo for filter

            try:
                batch = await self._post_json("/api/search/random", body)
            except ImmichConnError:
                continue   # retry on transient network errors

            collected += candidates_from_batch(batch, settings.landscape)
            if len(collected) >= needed:
                break

        if not collected:
            raise NoLandscapeSurvivor(settings.album_id)

        return collected[0]

    async def download_thumbnail(self, asset_id: str, edited: bool = False) -> bytes:
        """Download the preview thumbnail for asset_id and return raw bytes.

        Port of download_asset HTTP half (v41 line 245).
        The EXIF transpose step belongs in coordinator.py, not here.

        THUMB_SIZE = "preview" (v41 exact size, lines 244-245).

        edited=True appends &edited=true to fetch the rotated/cropped rendition
        (verified on live Immich 2.5.6: the plain endpoint always serves the
        ORIGINAL orientation; edits surface only via edited=true). The edited
        rendition is generated by an async worker job, so right after a rotate
        it may not exist yet -> fall back to the original on any error rather
        than blanking the photo.
        """
        plain = f"/api/assets/{asset_id}/thumbnail?size={THUMB_SIZE}"
        if not edited:
            return await self._get_bytes(plain)
        try:
            return await self._get_bytes(plain + "&edited=true")
        except ImmichError:
            # edited rendition not ready / unavailable -- show the original
            return await self._get_bytes(plain)

    # ------------------------------------------------------------------
    # Phase 2: new HTTP helpers (mirror _post_json / _get_bytes verbatim)
    # ------------------------------------------------------------------

    async def _put_json(self, path: str, body: dict) -> object:
        """PUT JSON body to path; return parsed JSON response.

        Raises:
            ImmichAuthError: on HTTP 401 or 403.
            ImmichConnError: on network error, timeout, or other non-2xx.
        """
        url = self._host + path
        try:
            async with self._session.put(url, json=body, headers=self._headers) as resp:
                if resp.status in (401, 403):
                    raise ImmichAuthError(f"Auth error {resp.status} from {path}")
                if not resp.ok:
                    raise ImmichConnError(f"Unexpected HTTP {resp.status} from {path}")
                return await resp.json()
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(f"Connection error on {path}: {exc}") from exc

    async def _delete_json(self, path: str, body: dict) -> None:
        """DELETE with JSON body to path.

        Raises:
            ImmichAuthError: on HTTP 401 or 403.
            ImmichConnError: on network error, timeout, or other non-2xx.
        """
        url = self._host + path
        try:
            async with self._session.delete(url, json=body, headers=self._headers) as resp:
                if resp.status in (401, 403):
                    raise ImmichAuthError(f"Auth error {resp.status} from {path}")
                if not resp.ok:
                    raise ImmichConnError(f"Unexpected HTTP {resp.status} from {path}")
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(f"Connection error on {path}: {exc}") from exc

    async def _get_json(self, path: str) -> dict:
        """GET path; return parsed JSON response.

        Raises:
            ImmichAuthError: on HTTP 401 or 403.
            ImmichConnError: on network error, timeout, or other non-2xx.
        """
        url = self._host + path
        try:
            async with self._session.get(url, headers=self._headers) as resp:
                if resp.status in (401, 403):
                    raise ImmichAuthError(f"Auth error {resp.status} from {path}")
                if not resp.ok:
                    raise ImmichConnError(f"Unexpected HTTP {resp.status} from {path}")
                return await resp.json()
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(f"Connection error on {path}: {exc}") from exc

    # ------------------------------------------------------------------
    # Phase 2: public API (port of v41 cmd_rate, cmd_swipe, cmd_rate_menu)
    # ------------------------------------------------------------------

    async def list_albums(self) -> list:
        """GET /api/albums (D-03). Requires album.read scope; 403 -> ImmichAuthError."""
        return await self._get_json("/api/albums")

    async def get_album_asset_ids(self, album_id: str) -> list[str]:
        """Return asset IDs in album order via GET /api/albums/{id}.

        Requires album.read scope. Returns IDs in the order Immich stores them
        (respects the album's configured sort order, including manual ordering).
        Raises ImmichAuthError on missing scope; ImmichConnError on network failure.
        """
        data = await self._get_json(f"/api/albums/{album_id}")
        return [a["id"] for a in data.get("assets", [])]

    async def set_rating(self, asset_id: str, rating: int) -> None:
        """PUT /api/assets/{id} {"rating": N} (D-09, port of v41 cmd_rate)."""
        await self._put_json(f"/api/assets/{asset_id}", {"rating": rating})

    async def add_to_album(self, album_id: str, asset_id: str) -> None:
        """PUT /api/albums/{id}/assets {"ids":[asset_id]} (D-12 recovery add)."""
        await self._put_json(f"/api/albums/{album_id}/assets", {"ids": [asset_id]})

    async def remove_from_album(self, album_id: str, asset_id: str) -> None:
        """DELETE /api/albums/{id}/assets {"ids":[asset_id]} (D-12 source remove)."""
        await self._delete_json(f"/api/albums/{album_id}/assets", {"ids": [asset_id]})

    async def get_asset_rating(self, asset_id: str) -> int:
        """GET /api/assets/{id} -> exifInfo.rating (D-11). 0 if unrated.

        Pitfall 4: rating is at exifInfo.rating, NOT top-level data.get('rating').
        """
        data = await self._get_json(f"/api/assets/{asset_id}")
        return int((data.get("exifInfo") or {}).get("rating") or 0)

    async def get_asset_info(self, asset_id: str) -> dict:
        """GET /api/assets/{id} -> {'rating': int, 'isEdited': bool}.

        Single round-trip the coordinator runs once per advance: rating drives
        the rate overlay (Pitfall 4: rating is at exifInfo.rating) and isEdited
        selects the rotated rendition so a rotate sticks when the photo recurs
        in the random rotation (both fields verified present on live Immich 2.5.6).
        """
        data = await self._get_json(f"/api/assets/{asset_id}")
        rating = int((data.get("exifInfo") or {}).get("rating") or 0)
        return {"rating": rating, "isEdited": bool(data.get("isEdited"))}

    async def check_asset_exists(self, asset_id: str) -> bool:
        """HEAD /api/assets/{id} -- lightweight existence check (Phase 3).

        Returns True if the asset exists (2xx), False on 404.
        Raises ImmichError on auth failure or connection error so the caller
        can treat network errors differently from a definitive 404.
        """
        url = self._host + f"/api/assets/{asset_id}"
        try:
            async with self._session.head(url, headers=self._headers) as resp:
                if resp.status == 404:
                    return False
                if resp.status in (401, 403):
                    raise ImmichAuthError(
                        f"Auth error {resp.status} on HEAD /api/assets/{asset_id}"
                    )
                if not resp.ok:
                    raise ImmichConnError(
                        f"HTTP {resp.status} on HEAD /api/assets/{asset_id}"
                    )
                return True
        except ImmichError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ImmichConnError(
                f"Connection error on HEAD /api/assets/{asset_id}: {exc}"
            ) from exc

    async def rotate(self, asset_id: str, angle: int) -> None:
        """PUT /api/assets/{id}/edits non-destructive rotate (asset.edit.create).

        angle is the ABSOLUTE rotation in degrees, one of 0/90/180/270 -- Immich
        replaceAll semantics overwrite all prior edits, so the caller is
        responsible for accumulating CW/CCW deltas into an absolute angle.
        """
        body = {"edits": [{"action": "rotate", "parameters": {"angle": angle}}]}
        await self._put_json(f"/api/assets/{asset_id}/edits", body)
