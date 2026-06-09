"""Select entity for Jax Stream (CTRL-03): live Immich album picker.

Lists all albums available to the configured API key and lets the user pick one
from the HA UI or automations. Selecting a new album:
  1. Persists it to the config entry options (survives HA restart without reload)
  2. Re-points coordinator.settings.album_id immediately (no reload needed)
  3. Force-refreshes the coordinator so the next photo comes from the new album

Album list is fetched once on async_added_to_hass and updated on each call.
If the API key lacks the album.read scope the entity loads with no options and
logs an actionable warning (D-03 graceful 403, Pitfall 6 from RESEARCH.md).

current_option returns None if the persisted album_id is no longer in the live
album list -- HA shows "Unknown" which is the correct signal to re-select.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ._device import build_device_info
from .const import CONF_ALBUM_ID
from .coordinator import JaxStreamCoordinator
from .immich import ImmichAuthError, ImmichError

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: "ConfigEntry",
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Jax Stream album select entity from a config entry."""
    coordinator: JaxStreamCoordinator = entry.runtime_data
    async_add_entities([JaxStreamAlbumSelect(coordinator, entry)])


class JaxStreamAlbumSelect(CoordinatorEntity[JaxStreamCoordinator], SelectEntity):
    """Select entity showing the live Immich album list (CTRL-03).

    Switching the selection persists the new album_id to the config entry and
    re-points the coordinator immediately so the next photo comes from the new album.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "album"
    _attr_icon = "mdi:image-multiple"

    def __init__(
        self,
        coordinator: JaxStreamCoordinator,
        entry: "ConfigEntry",
    ) -> None:
        """Register with the coordinator (SelectEntity needs no hass arg -- Pitfall 5)."""
        CoordinatorEntity.__init__(self, coordinator)   # registers update listener
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_album"
        self._attr_device_info = build_device_info(entry)
        # Album name <-> id maps; populated by _refresh_albums on hass load
        self._id_to_name: dict[str, str] = {}
        self._name_to_id: dict[str, str] = {}
        self._attr_options: list[str] = []

    async def async_added_to_hass(self) -> None:
        """Fetch the album list once the entity is registered with HA."""
        await super().async_added_to_hass()
        await self._refresh_albums()

    async def _refresh_albums(self) -> None:
        """Fetch albums from Immich and rebuild the name<->id maps (D-03).

        Gracefully handles a 403 from a key that lacks the album.read scope
        (Pitfall 6): logs an actionable warning and leaves options empty rather
        than blocking integration setup or raising an unrecoverable error.
        """
        try:
            albums = await self.coordinator.client.list_albums()
        except ImmichAuthError as err:
            _LOGGER.warning(
                "Album list needs the album.read scope on the API key: %s", err
            )
            return
        except ImmichError as err:
            _LOGGER.warning("Could not fetch album list: %s", err)
            return
        self._id_to_name = {a["id"]: a["albumName"] for a in albums}
        self._name_to_id = {v: k for k, v in self._id_to_name.items()}
        self._attr_options = list(self._name_to_id.keys())
        self.async_write_ha_state()

    @property
    def current_option(self) -> str | None:
        """Return the display name of the current album, or None if not in the list.

        None causes HA to show "Unknown", which is the correct signal when the
        persisted album_id has been deleted from Immich or is not in the live list.
        """
        return self._id_to_name.get(self.coordinator.settings.album_id)

    async def async_select_option(self, option: str) -> None:
        """Switch to the selected album, persist it, and force an immediate refresh.

        Raises ServiceValidationError if the option is not in the live album list
        (T-2-06: no arbitrary album_id is persisted from user input -- must resolve
        via the name->id map built from the authoritative Immich response).
        """
        album_id = self._name_to_id.get(option)
        if not album_id:
            raise ServiceValidationError(
                f"Album '{option}' not found in the current album list"
            )
        # 1. Persist to config entry options (survives HA restart without reload)
        self.hass.config_entries.async_update_entry(
            self._entry,
            options={**self._entry.options, CONF_ALBUM_ID: album_id},
        )
        # 2. Re-point coordinator immediately so the next fetch uses the new album
        self.coordinator.settings.album_id = album_id
        # 3. Force-refresh: show a photo from the new album without waiting for the timer
        self.coordinator._force_refresh = True
        await self.coordinator.async_request_refresh()
