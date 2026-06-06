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
# Form schemas
# ---------------------------------------------------------------------------

# Full schema for the initial config step (all seven D-06 fields).
CONFIG_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT)
        ),
        vol.Required(CONF_URL): TextSelector(
            TextSelectorConfig(type=TextSelectorType.URL)
        ),
        vol.Required(CONF_API_KEY): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        ),
        vol.Required(CONF_ALBUM_ID): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT)
        ),
        vol.Optional(CONF_INTERVAL, default=DEFAULT_INTERVAL): NumberSelector(
            NumberSelectorConfig(
                min=MIN_INTERVAL,
                max=MAX_INTERVAL,
                step=1,
                unit_of_measurement="s",
                mode=NumberSelectorMode.BOX,
            )
        ),
        vol.Optional(CONF_LANDSCAPE_ONLY, default=True): BooleanSelector(),
        vol.Optional(CONF_ALLOW_INSECURE, default=False): BooleanSelector(),
    }
)

# Options schema: editable subset (url + api_key stay in entry.data).
OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT)
        ),
        vol.Required(CONF_ALBUM_ID): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT)
        ),
        vol.Optional(CONF_REMOVE_TO_ALBUM_ID): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT)
        ),
        vol.Optional(CONF_INTERVAL, default=DEFAULT_INTERVAL): NumberSelector(
            NumberSelectorConfig(
                min=MIN_INTERVAL,
                max=MAX_INTERVAL,
                step=1,
                unit_of_measurement="s",
                mode=NumberSelectorMode.BOX,
            )
        ),
        vol.Optional(CONF_LANDSCAPE_ONLY, default=True): BooleanSelector(),
        vol.Optional(CONF_ALLOW_INSECURE, default=False): BooleanSelector(),
    }
)


def _build_config_schema(user_input: dict[str, Any] | None) -> vol.Schema:
    """Return CONFIG_SCHEMA, re-using user_input as suggested values when re-shown."""
    if not user_input:
        return CONFIG_SCHEMA
    # Re-fill submitted values so errors preserve typed text.
    return vol.Schema(
        {
            vol.Required(CONF_NAME, default=user_input.get(CONF_NAME, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.TEXT)
            ),
            vol.Required(CONF_URL, default=user_input.get(CONF_URL, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.URL)
            ),
            vol.Required(CONF_API_KEY, default=user_input.get(CONF_API_KEY, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
            vol.Required(CONF_ALBUM_ID, default=user_input.get(CONF_ALBUM_ID, "")): TextSelector(
                TextSelectorConfig(type=TextSelectorType.TEXT)
            ),
            vol.Optional(
                CONF_INTERVAL,
                default=user_input.get(CONF_INTERVAL, DEFAULT_INTERVAL),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=MIN_INTERVAL,
                    max=MAX_INTERVAL,
                    step=1,
                    unit_of_measurement="s",
                    mode=NumberSelectorMode.BOX,
                )
            ),
            vol.Optional(
                CONF_LANDSCAPE_ONLY,
                default=user_input.get(CONF_LANDSCAPE_ONLY, True),
            ): BooleanSelector(),
            vol.Optional(
                CONF_ALLOW_INSECURE,
                default=user_input.get(CONF_ALLOW_INSECURE, False),
            ): BooleanSelector(),
        }
    )


# ---------------------------------------------------------------------------
# Config flow
# ---------------------------------------------------------------------------


class JaxStreamConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for Jax Stream.

    CORE-01: renders the seven D-06 fields, calls ImmichClient.validate() on
    submit (D-10) and maps failures to inline form errors before creating the
    entry.  A duplicate url::album_id is aborted before entry creation.
    """

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Handle the user-initiated config step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # D-08 seam: insecure flag -> verify_ssl=False; applied ONLY here on
            # the validation session (never on ImageEntity or any other path,
            # per RESEARCH Pitfall 6).
            session = async_get_clientsession(
                self.hass,
                verify_ssl=not user_input[CONF_ALLOW_INSECURE],
            )
            client = ImmichClient(
                session,
                user_input[CONF_URL],
                user_input[CONF_API_KEY],  # stored on client instance only; never logged
            )

            try:
                # D-10: small POST /api/search/random to validate credentials + album.
                await client.validate(user_input[CONF_ALBUM_ID])
            except ImmichAuthError:
                errors["base"] = "invalid_auth"
            except ImmichConnError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during Jax Stream validation")
                errors["base"] = "unknown"
            else:
                # Validation passed -- set stable unique ID and create entry.
                await self.async_set_unique_id(
                    f"{user_input[CONF_URL]}::{user_input[CONF_ALBUM_ID]}"
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=user_input[CONF_NAME],
                    data=user_input,
                )

        # Show (or re-show on error) the form.
        return self.async_show_form(
            step_id="user",
            data_schema=_build_config_schema(user_input),
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

    Editable fields: name, album_id, interval, landscape_only, allow_insecure.
    url and api_key stay in entry.data (not editable here).

    Data/options split (RESEARCH Open Q1 / A3): the config flow writes ALL
    fields to entry.data on create; the options flow writes the editable
    subset to entry.options.  The coordinator (Plan 04) reads the merged
    view as {**entry.data, **entry.options}.

    Note: do NOT assign self.config_entry in __init__ -- the framework sets
    it automatically (RESEARCH lines 291-293, 583).
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Handle the options step."""
        if user_input is not None:
            # The entity friendly name resolves from the config-entry TITLE
            # (has_entity_name + _attr_name=None), which is set once at create.
            # Writing CONF_NAME to options alone is a silent no-op, so push a
            # rename through to the title explicitly.
            if user_input.get(CONF_NAME):
                self.hass.config_entries.async_update_entry(
                    self.config_entry, title=user_input[CONF_NAME]
                )
            return self.async_create_entry(data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(
                OPTIONS_SCHEMA,
                self.config_entry.options,
            ),
        )
