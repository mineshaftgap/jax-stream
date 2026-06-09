"""Number entity for Jax Stream: star rating (0-5) for the current photo.

Reflects coordinator._current_rating so the displayed value tracks whichever
photo is currently on screen. Setting a value calls coordinator.async_set_rating(),
which writes the rating to Immich and pushes an update to all listeners.

ASCII only -- no Unicode.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ._device import build_device_info
from .coordinator import JaxStreamCoordinator

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: "ConfigEntry",
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Jax Stream rating number entity from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([JaxStreamRatingNumber(coordinator, entry)])


class JaxStreamRatingNumber(CoordinatorEntity[JaxStreamCoordinator], NumberEntity):
    """Number entity that reflects and sets the current photo's Immich star rating."""

    _attr_has_entity_name = True
    _attr_translation_key = "rating"
    _attr_icon = "mdi:star"
    _attr_native_min_value = 0
    _attr_native_max_value = 5
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        CoordinatorEntity.__init__(self, coordinator)
        self._attr_unique_id = f"{entry.entry_id}_rating"
        self._attr_device_info = build_device_info(entry)

    @property
    def native_value(self) -> float:
        """Return the current photo's rating from the coordinator."""
        return float(self.coordinator._current_rating)

    @property
    def extra_state_attributes(self) -> dict[str, str | None]:
        """Expose the asset this rating belongs to.

        Lets the frontend tell a genuine rating ACTION (asset_id matches the
        photo on screen) from the incidental rating change that rides along on
        a stream advance (asset_id is the incoming photo, not yet painted), so
        a rating made on another device toasts here but advances do not.
        """
        return {"asset_id": self.coordinator.current_asset_id}

    async def async_set_native_value(self, value: float) -> None:
        """Set the rating on the current photo via Immich."""
        await self.coordinator.async_set_rating(int(value))
