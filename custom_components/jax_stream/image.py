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
    async_add_entities([JaxStreamImage(coordinator, entry)])


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

    @callback
    def _handle_coordinator_update(self) -> None:
        """Sync image_last_updated from the coordinator on each tick (CORE-04).

        Changing _attr_image_last_updated changes entity state -> HA frontend
        detects the state change -> refetches the image proxy URL -> photo
        advances on the dashboard.
        """
        self._attr_image_last_updated = self.coordinator.image_last_updated
        super()._handle_coordinator_update()
