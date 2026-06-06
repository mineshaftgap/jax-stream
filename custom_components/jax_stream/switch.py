"""Switch entity for Jax Stream (CTRL-04): manual pause / full resume.

is_on reflects coordinator._manual_paused (True = paused).
turn_on  -> coordinator.async_set_paused(True)   -- engage manual hold
turn_off -> coordinator.async_set_paused(False)  -- FULL resume: clears both
              _manual_paused and _touch_deadline (D-08 v41 resume semantics)

The coordinator's async_set_paused already calls async_update_listeners() after
mutating gate state, so the switch entity refreshes without waiting for the next
coordinator tick (Pitfall 7 from RESEARCH.md: gate ticks are suppressed while
paused, so listeners must be pushed explicitly).

No local state copy -- is_on reads the coordinator directly so the switch always
reflects real gate state even if async_set_paused is called from a service or
another entity.

ASCII only -- no Unicode.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.switch import SwitchEntity
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
    """Set up the Jax Stream pause switch entity from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([JaxStreamPauseSwitch(coordinator, entry)])


class JaxStreamPauseSwitch(CoordinatorEntity[JaxStreamCoordinator], SwitchEntity):
    """Switch that reflects and controls the coordinator pause gate (CTRL-04).

    is_on == True  means the slideshow is manually paused.
    is_on == False means the slideshow is running (or in the 90s touch window).
    """

    _attr_has_entity_name = True
    _attr_translation_key = "pause"

    def __init__(
        self,
        coordinator: JaxStreamCoordinator,
        entry: "ConfigEntry",
    ) -> None:
        """Register with the coordinator (SwitchEntity needs no hass arg -- Pitfall 5)."""
        CoordinatorEntity.__init__(self, coordinator)   # registers update listener
        self._attr_unique_id = f"{entry.entry_id}_pause"
        self._attr_device_info = build_device_info(entry)

    @property
    def is_on(self) -> bool:
        """Return True when the slideshow is manually paused."""
        return self.coordinator._manual_paused

    async def async_turn_on(self, **kwargs: object) -> None:
        """Engage manual pause (D-08: sets _manual_paused = True)."""
        await self.coordinator.async_set_paused(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Full resume: clears both manual hold and touch window (D-08)."""
        await self.coordinator.async_set_paused(False)
