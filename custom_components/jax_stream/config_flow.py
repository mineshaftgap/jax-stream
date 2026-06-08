"""Config flow and options flow for the Jax Stream integration.

CORE-01: Config flow with D-10 test-before-configure validation.
CORE-02: Options flow (OptionsFlowWithReload) that reloads on save.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    CONF_ALBUM_ID,
    CONF_ALLOW_INSECURE,
    CONF_API_KEY,
    CONF_INTERVAL,
    CONF_LANDSCAPE_ONLY,
    CONF_NAME,
    CONF_REMOVE_TO_ALBUM_ID,
    CONF_URL,
    DEFAULT_INTERVAL,
    DOMAIN,
    MAX_INTERVAL,
    MIN_INTERVAL,
)
from .immich import ImmichAuthError, ImmichClient, ImmichConnError

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared field builders (used by both config and options schemas)
# ---------------------------------------------------------------------------

def _name_field(default: Any = vol.UNDEFINED) -> vol.Required:
    return vol.Required(CONF_NAME, default=default)

def _url_field(default: Any = vol.UNDEFINED) -> vol.Required:
    return vol.Required(CONF_URL, default=default)

def _api_key_field(default: Any = vol.UNDEFINED) -> vol.Required:
    return vol.Required(CONF_API_KEY, default=default)

def _album_id_field(default: Any = vol.UNDEFINED) -> vol.Required:
    return vol.Required(CONF_ALBUM_ID, default=default)

_TEXT = TextSelector(TextSelectorConfig(type=TextSelectorType.TEXT))
_URL = TextSelector(TextSelectorConfig(type=TextSelectorType.URL))
_PASSWORD = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))

def _interval_selector() -> NumberSelector:
    return NumberSelector(
        NumberSelectorConfig(
            min=MIN_INTERVAL,
            max=MAX_INTERVAL,
            step=1,
            unit_of_measurement="s",
            mode=NumberSelectorMode.BOX,
        )
    )


def _build_schema(suggested: dict[str, Any]) -> vol.Schema:
    """Build the full schema pre-filled with suggested values.

    Used for both the config flow (add) and options flow (edit) so both
    forms are always field-symmetric. suggested should be the merged
    effective config: {**entry.data, **entry.options} for options,
    or the re-submitted user_input for error re-display.
    """
    s = suggested
    return vol.Schema(
        {
            _name_field(s.get(CONF_NAME, "")): _TEXT,
            _url_field(s.get(CONF_URL, "")): _URL,
            _api_key_field(s.get(CONF_API_KEY, "")): _PASSWORD,
            _album_id_field(s.get(CONF_ALBUM_ID, "")): _TEXT,
            vol.Optional(
                CONF_REMOVE_TO_ALBUM_ID,
                default=s.get(CONF_REMOVE_TO_ALBUM_ID, ""),
            ): _TEXT,
            vol.Optional(
                CONF_INTERVAL,
                default=s.get(CONF_INTERVAL, DEFAULT_INTERVAL),
            ): _interval_selector(),
            vol.Optional(
                CONF_LANDSCAPE_ONLY,
                default=s.get(CONF_LANDSCAPE_ONLY, True),
            ): BooleanSelector(),
            vol.Optional(
                CONF_ALLOW_INSECURE,
                default=s.get(CONF_ALLOW_INSECURE, False),
            ): BooleanSelector(),
        }
    )


async def _validate(hass, user_input: dict[str, Any]) -> dict[str, str]:
    """Run D-10 validation; return an errors dict (empty = success)."""
    session = async_get_clientsession(
        hass,
        verify_ssl=not user_input.get(CONF_ALLOW_INSECURE, False),
    )
    client = ImmichClient(
        session,
        user_input[CONF_URL],
        user_input[CONF_API_KEY],
    )
    try:
        await client.validate(user_input[CONF_ALBUM_ID])
    except ImmichAuthError:
        return {"base": "invalid_auth"}
    except ImmichConnError:
        return {"base": "cannot_connect"}
    except Exception:  # noqa: BLE001
        _LOGGER.exception("Unexpected error during Jax Stream validation")
        return {"base": "unknown"}
    return {}


# ---------------------------------------------------------------------------
# Config flow
# ---------------------------------------------------------------------------


class JaxStreamConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for Jax Stream.

    CORE-01: renders all fields, calls ImmichClient.validate() on submit
    (D-10) and maps failures to inline form errors before creating the
    entry.  A duplicate url::album_id is aborted before entry creation.
    """

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Handle the user-initiated config step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            errors = await _validate(self.hass, user_input)
            if not errors:
                await self.async_set_unique_id(
                    f"{user_input[CONF_URL]}::{user_input[CONF_ALBUM_ID]}"
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=user_input[CONF_NAME],
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(user_input or {}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> "JaxStreamOptionsFlow":
        """Return the options flow handler (CORE-02)."""
        return JaxStreamOptionsFlow()


# ---------------------------------------------------------------------------
# Options flow
# ---------------------------------------------------------------------------


class JaxStreamOptionsFlow(config_entries.OptionsFlowWithReload):
    """Options flow for Jax Stream.

    CORE-02: edits the entry and reloads it on save.
    OptionsFlowWithReload auto-reloads; no manual update listener needed.

    Pre-populates from {**entry.data, **entry.options} so current effective
    values are always visible. Validates credentials before saving.

    Data/options split (RESEARCH Open Q1 / A3): the config flow writes ALL
    fields to entry.data on create; the options flow writes the full field
    set to entry.options. The coordinator reads the merged view as
    {**entry.data, **entry.options}, so options-flow edits always win.

    Note: do NOT assign self.config_entry in __init__ -- the framework sets
    it automatically (RESEARCH lines 291-293, 583).
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Handle the options step."""
        errors: dict[str, str] = {}
        merged = {**self.config_entry.data, **self.config_entry.options}

        if user_input is not None:
            errors = await _validate(self.hass, user_input)
            if not errors:
                if user_input.get(CONF_NAME):
                    self.hass.config_entries.async_update_entry(
                        self.config_entry, title=user_input[CONF_NAME]
                    )
                return self.async_create_entry(data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=_build_schema(user_input if errors else merged),
            errors=errors,
        )
