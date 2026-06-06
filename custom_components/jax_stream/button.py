"""Button entity for Jax Stream (CTRL-02): advance the slideshow on press.

Pressing this button calls coordinator.async_next(), which bypasses the pause
gate and immediately fetches the next photo (D-08 swipe-matrix semantics: lifts
manual hold, re-arms the 90s touch window, force-refreshes).

Follows the image.py CoordinatorEntity scaffold exactly -- same async_setup_entry
pattern, same dual-init awareness. ButtonEntity does NOT require hass in __init__
(Pitfall 5 from RESEARCH.md); only CoordinatorEntity.__init__ is called.

ASCII only -- no Unicode.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.button import ButtonEntity
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
    """Set up the Jax Stream button entity from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([JaxStreamButton(coordinator, entry)])


class JaxStreamButton(CoordinatorEntity[JaxStreamCoordinator], ButtonEntity):
    """Button that advances the Jax Stream slideshow immediately (CTRL-02).

    async_press delegates to coordinator.async_next(), which bypasses the
    pause gate (D-08), lifts any manual hold, and force-fetches the next photo.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "next"

    def __init__(
        self,
        coordinator: JaxStreamCoordinator,
        entry: "ConfigEntry",
    ) -> None:
        """Register with the coordinator (Pitfall 5: ButtonEntity needs no hass arg)."""
        CoordinatorEntity.__init__(self, coordinator)   # registers update listener
        self._attr_unique_id = f"{entry.entry_id}_button"
        self._attr_device_info = build_device_info(entry)

    async def async_press(self) -> None:
        """Advance the slideshow -- bypass gate, lift manual hold (D-08)."""
        await self.coordinator.async_next()
