"""Image entity for Jax Stream (CORE-04).

Exposes the current coordinator photo bytes through HA's token-protected
/api/image_proxy endpoint (T-01-02: no Immich URL or api_key in attributes).

Two-init gotcha (Pitfall 3 / RESEARCH Pattern 4 -- VERIFIED against core):
  CoordinatorEntity.__init__(self, coordinator)   -- registers update listener
  ImageEntity.__init__(self, coordinator.hass)    -- REQUIRES hass positionally;
      Python MRO does not call both automatically in multiple inheritance.

Bumps _attr_image_last_updated in _handle_coordinator_update (on each coordinator
tick), NOT in async_image (anti-pattern -- breaks the refetch contract).

ASCII only -- no Unicode.
"""
from __future__ import annotations

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import JaxStreamCoordinator
from ._device import build_device_info

# TYPE_CHECKING import to avoid circular dependency at runtime
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: "ConfigEntry",
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Jax Stream image entity from a config entry.

    The coordinator is stored on entry.runtime_data by __init__.py
    (async_setup_entry convention -- see RESEARCH State-of-the-Art).
    One entity per config entry (one per stream).
    """
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([
        JaxStreamImage(coordinator, entry),
        JaxStreamNextImage(coordinator, entry),
        JaxStreamPrevImage(coordinator, entry),
    ])


class JaxStreamImage(CoordinatorEntity[JaxStreamCoordinator], ImageEntity):
    """Single image entity backed by the JaxStreamCoordinator.

    Serves bytes via async_image (HA image proxy, token-protected -- T-01-02).
    State is the ISO timestamp from image_last_updated; when it changes the
    frontend refetches the image proxy (CORE-04 refetch contract).
    """

    _attr_has_entity_name = True
    _attr_content_type = "image/jpeg"

    def __init__(
        self,
        coordinator: JaxStreamCoordinator,
        entry: "ConfigEntry",
    ) -> None:
        """Call BOTH parent __init__s explicitly (Pitfall 3 -- multiple inheritance).

        CoordinatorEntity.__init__ registers the coordinator update listener.
        ImageEntity.__init__ requires hass positionally to set up the image proxy
        access token; Python's MRO will NOT call it automatically here.
        """
        CoordinatorEntity.__init__(self, coordinator)          # listener + hass attr
        ImageEntity.__init__(self, coordinator.hass)           # image proxy token

        self._attr_unique_id = entry.entry_id
        self._attr_name = None                                 # has_entity_name -> device/entry name
        self._attr_image_last_updated = coordinator.image_last_updated
        self._attr_device_info = build_device_info(entry)     # D-02: cluster under one device card

    async def async_image(self) -> bytes | None:
        """Return the current photo bytes from coordinator memory.

        No I/O here (photos are fetched and stored by the coordinator).
        No image_last_updated bump here (anti-pattern -- bumping here breaks
        the refetch contract; bump in _handle_coordinator_update instead).
        """
        return self.coordinator.image_bytes

    @property
    def extra_state_attributes(self) -> dict:
        """Expose photo metadata for the JS info overlay.

        Delivered free in each state_changed event (same tick as the image
        advance) so no extra API call is needed in JS. All values are str or
        None; empty strings are normalised to None so JS can rely on truthiness.
        """
        info = self.coordinator._current_photo_info or {}
        def _str(v: str) -> str | None:
            return v if v else None
        return {
            "photo_date": _str(info.get("date", "")),
            "photo_city": _str(info.get("city", "")),
            "photo_country": _str(info.get("country", "")),
            "photo_camera": _str(info.get("camera", "")),
            "photo_album": _str(self.coordinator._album_name),
            "is_favorite": self.coordinator._current_is_favorite,
        }

    @callback
    def _handle_coordinator_update(self) -> None:
        """Sync image_last_updated from the coordinator on each tick (CORE-04).

        Changing _attr_image_last_updated changes entity state -> HA frontend
        detects the state change -> refetches the image proxy URL -> photo
        advances on the dashboard.
        """
        self._attr_image_last_updated = self.coordinator.image_last_updated
        super()._handle_coordinator_update()


class _JaxStreamAdjacentImage(CoordinatorEntity[JaxStreamCoordinator], ImageEntity):
    """Base for the next/previous adjacent-slot image entities.

    These expose the coordinator's pre-fetched neighbor bytes so the frontend
    can prefetch and preview the adjacent photos via subscription-driven
    entity_picture URLs (pub/sub adjacent slot migration), replacing the
    state.json + slot_XX.jpg polling that prefetchNext used to do.

    Subclasses set _attr_translation_key and override _bytes / _last_updated to
    point at the matching coordinator fields. Returns None bytes until the
    adjacent slot exists (e.g. no previous photo on the first frame after boot);
    the frontend treats a missing picture as "no panel".
    """

    _attr_has_entity_name = True
    _attr_content_type = "image/jpeg"

    def __init__(
        self,
        coordinator: JaxStreamCoordinator,
        entry: "ConfigEntry",
        uid_suffix: str,
    ) -> None:
        CoordinatorEntity.__init__(self, coordinator)
        ImageEntity.__init__(self, coordinator.hass)
        self._attr_unique_id = f"{entry.entry_id}_{uid_suffix}"
        self._attr_device_info = build_device_info(entry)
        self._attr_image_last_updated = self._last_updated()

    def _bytes(self) -> bytes | None:
        raise NotImplementedError

    def _last_updated(self):
        raise NotImplementedError

    async def async_image(self) -> bytes | None:
        """Return the adjacent slot bytes from coordinator memory (no I/O here)."""
        return self._bytes()

    @callback
    def _handle_coordinator_update(self) -> None:
        """Sync image_last_updated so HA refetches the proxy when the neighbor changes."""
        self._attr_image_last_updated = self._last_updated()
        super()._handle_coordinator_update()


class JaxStreamNextImage(_JaxStreamAdjacentImage):
    """Image entity serving the next ring slot (head+1) -- the prefetch target."""

    _attr_translation_key = "next_image"
    _attr_icon = "mdi:image-move"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "next")

    def _bytes(self) -> bytes | None:
        return self.coordinator._next_bytes

    def _last_updated(self):
        return self.coordinator.next_image_last_updated


class JaxStreamPrevImage(_JaxStreamAdjacentImage):
    """Image entity serving the previous ring slot (head-1) -- the back-swipe panel."""

    _attr_translation_key = "previous_image"
    _attr_icon = "mdi:image-move"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "previous")

    def _bytes(self) -> bytes | None:
        return self.coordinator._prev_bytes

    def _last_updated(self):
        return self.coordinator.prev_image_last_updated
