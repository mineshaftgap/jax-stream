"""Sensor entities for Jax Stream: current asset ID, prefetch health, pause reason.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING

from homeassistant.components.sensor import SensorEntity, SensorStateClass
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
    """Set up all Jax Stream sensor entities from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([
        JaxStreamCurrentAssetSensor(coordinator, entry),
        JaxStreamCurrentPhotoLinkSensor(coordinator, entry),
        JaxStreamPrefetchSensor(coordinator, entry),
        JaxStreamPauseReasonSensor(coordinator, entry),
        JaxStreamTouchDeadlineSensor(coordinator, entry),
    ])


class _JaxStreamSensor(CoordinatorEntity[JaxStreamCoordinator], SensorEntity):
    """Base for all Jax Stream sensor entities."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry", uid_suffix: str) -> None:
        CoordinatorEntity.__init__(self, coordinator)
        self._attr_unique_id = f"{entry.entry_id}_{uid_suffix}"
        self._attr_device_info = build_device_info(entry)


class JaxStreamCurrentAssetSensor(_JaxStreamSensor):
    """Text sensor: Immich asset UUID of the currently displayed photo.

    Use this value in automations to pass as asset_id to the remove,
    set_rating, and rotate services (prevents drift from auto-advance).
    """

    _attr_translation_key = "current_asset"
    _attr_icon = "mdi:identifier"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "sensor_current_asset")

    @property
    def native_value(self) -> str | None:
        """Return the UUID of the currently displayed photo, or None if not yet loaded."""
        return self.coordinator.current_asset_id

    @property
    def extra_state_attributes(self) -> dict:
        """Expose menu_order so jax_stream.js can read it from hass.states."""
        return {"menu_order": self.coordinator.menu_order_list}


class JaxStreamCurrentPhotoLinkSensor(_JaxStreamSensor):
    """Text sensor: deep link to the currently displayed photo in the Immich web UI.

    Value is "{immich_host}/photos/{asset_id}" -- open it to land directly on the
    photo in Immich (sharing, deleting, editing). None until a photo is loaded.
    """

    _attr_translation_key = "current_photo_link"
    _attr_icon = "mdi:open-in-new"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "sensor_current_photo_link")

    @property
    def native_value(self) -> str | None:
        """Return the Immich web URL for the current photo, or None if not yet loaded."""
        asset_id = self.coordinator.current_asset_id
        if not asset_id:
            return None
        return f"{self.coordinator.client.host}/photos/{asset_id}"


class JaxStreamPrefetchSensor(_JaxStreamSensor):
    """Numeric sensor: how many future ring-buffer slots are pre-fetched and ready.

    Normal value is equal to the configured prefetch count (default 3). A value
    below that means the ring is being refilled after a restart or album change.
    Zero means the next advance will require an on-demand Immich fetch.
    """

    _attr_translation_key = "prefetch_ready"
    _attr_icon = "mdi:buffer"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "slots"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "sensor_prefetch")

    @property
    def native_value(self) -> int:
        """Return the number of pre-fetched future slots currently ready."""
        return self.coordinator._future_count


class JaxStreamPauseReasonSensor(_JaxStreamSensor):
    """Enum sensor: why the slideshow is (or is not) paused.

    running     -- slideshow is advancing on the normal timer
    touch_window -- auto-advance is suppressed for 90s after a tap
    manual      -- manually paused via the pause switch or service
    """

    _attr_translation_key = "pause_reason"
    _attr_icon = "mdi:pause-circle-outline"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "sensor_pause_reason")

    @property
    def native_value(self) -> str:
        """Return the current pause state: manual, touch_window, or running."""
        if self.coordinator._manual_paused:
            return "manual"
        if self.coordinator._touch_deadline > 0 and time.time() < self.coordinator._touch_deadline:
            return "touch_window"
        return "running"


class JaxStreamTouchDeadlineSensor(_JaxStreamSensor):
    """Numeric sensor: epoch seconds when the active 90s touch window expires.

    0 means no active touch window. The frontend reads this at init to restore
    the touch countdown ring after a VA bounce, and subscribes to state_changed
    so a tap on one device surfaces the ring on others. Replaces the old
    pause_touch.txt bridge file fetch.
    """

    _attr_translation_key = "touch_deadline"
    _attr_icon = "mdi:gesture-tap"

    def __init__(self, coordinator: JaxStreamCoordinator, entry: "ConfigEntry") -> None:
        super().__init__(coordinator, entry, "sensor_touch_deadline")

    @property
    def native_value(self) -> int:
        """Return the epoch-second deadline of the active touch window (0 = none)."""
        return int(self.coordinator._touch_deadline)
