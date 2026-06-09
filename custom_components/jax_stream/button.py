"""Button entities for Jax Stream: next, remove, rotate CW, rotate CCW.

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
    """Set up all Jax Stream button entities from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([
        JaxStreamNextButton(coordinator, entry),
        JaxStreamPreviousButton(coordinator, entry),
        JaxStreamRemoveButton(coordinator, entry),
        JaxStreamRotateCWButton(coordinator, entry),
        JaxStreamRotateCCWButton(coordinator, entry),
    ])


class _JaxStreamButton(CoordinatorEntity[JaxStreamCoordinator], ButtonEntity):
    """Base for all Jax Stream button entities (Pitfall 5: no hass arg needed)."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry", uid_suffix: str) -> None:
        CoordinatorEntity.__init__(self, coordinator)
        self._attr_unique_id = f"{entry.entry_id}_{uid_suffix}"
        self._attr_device_info = build_device_info(entry)


class JaxStreamNextButton(_JaxStreamButton):
    """Advance the slideshow: bypass gate, lift manual pause, re-arm touch window (D-08)."""

    _attr_translation_key = "next"
    _attr_icon = "mdi:skip-next"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "button")  # preserve original unique_id

    async def async_press(self) -> None:
        await self.coordinator.async_next()


class JaxStreamPreviousButton(_JaxStreamButton):
    """Go back to the previous photo in the ring buffer past window."""

    _attr_translation_key = "previous"
    _attr_icon = "mdi:skip-previous"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "button_previous")

    async def async_press(self) -> None:
        await self.coordinator.async_previous()


class JaxStreamRemoveButton(_JaxStreamButton):
    """Remove the currently displayed photo from its Immich album and advance."""

    _attr_translation_key = "remove"
    _attr_icon = "mdi:trash-can"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "button_remove")

    async def async_press(self) -> None:
        await self.coordinator.async_remove()


class JaxStreamRotateCWButton(_JaxStreamButton):
    """Rotate the current photo 90 degrees clockwise via Immich non-destructive edit."""

    _attr_translation_key = "rotate_cw"
    _attr_icon = "mdi:rotate-right"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "button_rotate_cw")

    async def async_press(self) -> None:
        await self.coordinator.async_rotate(90)


class JaxStreamRotateCCWButton(_JaxStreamButton):
    """Rotate the current photo 90 degrees counter-clockwise via Immich non-destructive edit."""

    _attr_translation_key = "rotate_ccw"
    _attr_icon = "mdi:rotate-left"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "button_rotate_ccw")

    async def async_press(self) -> None:
        await self.coordinator.async_rotate(270)
