"""Shared DeviceInfo builder -- one HA device per config entry (D-02).

All four entities (image, button, select, switch) call build_device_info(entry)
so they cluster under a single device card in the HA device registry.

ASCII only -- no Unicode.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.helpers.device_registry import DeviceInfo

from .const import CONF_NAME, DEFAULT_STREAM_SUBDIR, DOMAIN

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry


def build_device_info(entry: "ConfigEntry") -> DeviceInfo:
    """Return the shared DeviceInfo for all entities under this config entry.

    Keyed on (DOMAIN, entry.entry_id) so all four platforms share one device
    card in the HA device registry (CTRL-02/03/04).
    """
    stream_name = entry.data.get(CONF_NAME, DEFAULT_STREAM_SUBDIR)
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=f"Jax Stream: {stream_name}",
        manufacturer="Jax Stream",
        model="Immich Slideshow",
    )
