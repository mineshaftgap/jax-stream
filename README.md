# Jax Stream

*A View Assist Immich Slideshow*

![Jax](docs/images/demo.webp)

*In loving memory of Jackson ("Jax"). One of the things I loved most about my old Amazon Echo setup was seeing his goofy mug as I walked by the display. When I migrated to View Assist, I needed that back -- this is dedicated to him.*

Jax Stream turns a View Assist display into an interactive photo album. Your selected Immich photos cycle as the full-screen background -- swipe to navigate, tap to curate: star ratings, removal, and rotation without leaving the screen. No extra containers, no YAML, and per-device album targeting, packaged up conveniently as a HACS integration.

## Features

**Display**

- Full-screen rotating Immich photo background per display; interval is configurable per stream (default 1 minute)
- Blurred-fill letterbox layout: portrait photos on landscape screens fill the side bars with a blurred version of the same image -- no solid black bars
- Configurable text opacity (default 70%) keeps View Assist clock, weather, and status text readable over any photo; tune it with the `--jax-text-opacity` CSS variable
- Responsive font sizes work on 960x480 (Echo Show 5) and 1280x800 (Echo Show 8) without tweaks

**Navigation**

- Swipe left to advance; photos slide horizontally to follow the finger
- Swipe right to step back through recently shown photos -- a server-side ring buffer holds the recent past (default 20 deep); swipe left walks forward again and resumes the normal queue at the end
- Each display navigates its own history independently -- displays never share or fight over photo state

**Curation**

- Jaxmenu (tap the jaxicon): star rating 1-5 or unrate, synced to Immich
- Remove from album without deleting the asset; optional Remove-to recovery album with fail-safe -- if the recovery add fails, the source removal is aborted so the photo stays put
- Rotate CW or CCW via Immich non-destructive edit -- the correction sticks for all future appearances of that photo
- Pause auto-advance from the jaxmenu; a play-triangle indicator shows when paused
- Any screen touch arms a 90-second suppression window; a decaying radial ring badge near the jaxicon shows the remaining time; tap it to resume immediately

**HA integration**

- Auto-registered jax-stream VA view at `/view-assist/jax-stream` -- no manual `view_assist.load_asset` call
- Native HA `image`, `button`, `number`, `select`, `sensor`, and `switch` entities per stream
- `jax_stream` services callable from automations, scripts, the mobile app, and voice assistants
- Per-device per-stream targeting -- different albums on different displays; add a second integration entry for a second device
- Integration-served frontend module -- no manual `frontend:` config entry needed
- Full HACS config flow and options flow -- no YAML editing required

## Why this exists

A few Immich+HA slideshow options already exist. Each is good at what it does; none quite fit a View Assist install out of the box:

| Project | What's missing |
|---|---|
| [damongolding/immich-kiosk](https://github.com/damongolding/immich-kiosk) | Solid and full-featured, but requires a separate Docker container alongside Immich and HA -- one more service to run, monitor, and update |
| [mulder82/immich-slideshow](https://github.com/mulder82/immich-slideshow) (HACS) | Active and maintained, but POSTs `/api/search/random` with no `albumIds` filter -- random asset from the whole library, not one album. No per-device targeting |
| [outadoc/immich-home-assistant](https://github.com/outadoc/immich-home-assistant) (HACS) | Has album filtering, but unmaintained for 2+ years, 5-minute interval hardcoded, broken on HA 2025.6+ |

Jax Stream fills the gap: VA-native, per-device, no extra container -- packaged as a first-class HA custom integration (config flow + coordinator + image entity).

## Prerequisites

- Home Assistant with the View Assist integration installed and at least one device set up
- An Immich server reachable from your HA host, with at least one album
- An Immich API key with `asset.read` and `asset.view` scopes (add `asset.update` for star rating, `albumAsset.delete` for jaxmenu remove, and `albumAsset.create` if you set a recovery album -- see "Required Immich API key scopes" below)
- HACS installed (you already run it for View Assist)

## Installation

### HACS (Recommended)

1. Open HACS in Home Assistant
2. Click the three dots in the top right and select **Custom repositories**
3. Add the repository URL: `https://github.com/mineshaftgap/jax-stream`
4. Select **Integration** as the category and click **Add**
5. Search for "Jax Stream" in HACS and download it
6. Restart Home Assistant
7. Add the integration via Settings -> Devices & Services -> **Add Integration**
8. Fill the config-flow form:
   - **Stream name**: short identifier for this stream (e.g. `family`)
   - **Immich URL**: e.g. `http://10.0.0.5:2283` or `https://immich.example.com`
   - **Immich API key**: from Account Settings -> API Keys
   - **Immich album ID**: UUID from your Immich album page URL
   - **Refresh interval**: how often to fetch a new photo (default 1 minute)
   - **Landscape only**: filter out portrait photos
   - **Allow insecure HTTPS**: tick only for a self-signed / private-CA Immich cert; leave off for `http://` or a publicly-trusted `https://`

That is the whole install -- no YAML editing, no shell scripts, no manual view registration. To add another stream for another device, repeat "Add Integration" with a different album ID and stream name. Edit any stream later via its options flow (also where you set an optional Remove-to recovery album).

### One-time View Assist setup

After installation, point your device at the jax-stream view. Settings -> Devices & Services -> View Assist -> Master Configuration -> Configure -> Dashboard Options. Set two fields:

- **Home screen**: `/view-assist/jax-stream`
- **Background settings -> Background mode**: `local_random`
- **Background settings -> Rotate background path**: `images/jax-stream/<stream>`
  (replace `<stream>` with the stream name you entered in the config-flow form)

Without `local_random`, VA uses its default blue gradient -- the Immich photos will not appear even if the integration is running correctly.

> **Warning:** the VA Dashboard Options form is a full-form resend. Any field you leave blank or any section you send as empty is **deleted** from your saved config. Always fill in every field that appears pre-filled; only change the field you intend to change. Close the dialog with X if you do not want to save.

### Manual Installation

1. Copy `custom_components/jax_stream/` into your HA `custom_components/` directory
2. Restart Home Assistant
3. Add the integration via Settings -> Devices & Services -> Add Integration and fill the config-flow form (same fields as above)

## Entities

Each stream registers a device (Settings -> Devices & Services -> Jax Stream -> the per-stream device card) with the following entities:

**Image** (`image.*`)

- **Current photo** -- the photo currently on screen, served by the integration (this is the entity VA's `local_random` background reads)
- **Next image** -- the prefetched next photo in the queue
- **Previous image** -- the previous photo from the back-navigation window

**Button** (`button.*`)

- **Next photo** -- advance to the next photo (lifts manual pause, re-arms the touch window)
- **Previous photo** -- step back to the previous photo
- **Remove photo** -- remove the current photo from its album (recovery-first if configured)
- **Rotate clockwise** -- rotate the current photo 90 degrees CW via Immich non-destructive edit
- **Rotate counter-clockwise** -- rotate the current photo 90 degrees CCW

**Number** (`number.*`)

- **Rating** -- Immich star rating of the current photo, 0 (unrated) to 5; set it to push a new rating to Immich

**Select** (`select.*`)

- **Album** -- change the active Immich album from your library

**Switch** (`switch.*`)

- **Pause** -- on = auto-advance paused, off = running

**Sensor** (`sensor.*`)

- **Current photo** -- the current Immich asset ID
- **Current photo link** -- Immich web-UI deep link (`{immich_host}/photos/{asset_id}`) to the photo on screen; open it to land directly on that photo in Immich for sharing, editing, or deleting
- **Prefetch ready** -- number of prefetched photos buffered ahead (unit: slots)
- **Pause reason** -- why rotation is currently held (manual pause, touch window, or none)
- **Touch deadline** -- when the active 90-second touch-suppression window expires

## Services

Services in the `jax_stream` domain, callable from automations, scripts, the mobile app, and voice assistants:

| Service | What it does |
|---|---|
| `jax_stream.next` | Advance to the next queued photo (lifts manual pause and re-arms the 90-second touch window, same as a swipe) |
| `jax_stream.previous` | Step back to the previous photo from the server-side past-window ring buffer (default 20 deep); does not affect pause state |
| `jax_stream.remove` | Remove current photo from source album (recovery-first if configured); optional `asset_id` overrides the target |
| `jax_stream.set_rating` | Set Immich star rating 0-5 (`rating`, required; 0 = unrate); optional `asset_id` |
| `jax_stream.rotate` | Rotate current photo via Immich non-destructive edit and show the corrected rendition in place (`angle`, required: 90 = CW, 270 = CCW, 180 = flip) |
| `jax_stream.touch` | Arm the 90-second touch window -- holds auto-advance without setting a manual pause (called by the frontend on tap) |
| `jax_stream.pause` | Pause auto-advance |
| `jax_stream.resume` | Resume (clears both manual pause and touch-window) |

Every service accepts either an `entity_id` (the stream's image entity) or a `stream` name to specify which stream. Example from an automation:

```yaml
action: jax_stream.set_rating
target:
  entity_id: image.jax_stream_family
data:
  rating: 5
```

## Usage

Swipe **left** to advance to the next photo. Swipe **right** to go back through recently shown photos: the integration keeps a server-side ring buffer of the recent past (default 20 deep), and `jax_stream.previous` promotes the prior slot. Swipe left walks forward again, and the normal queue resumes at the end. Photos slide horizontally to follow the finger. Each display navigates its own history independently.

To remove a photo from the album, open the jaxmenu (tap the jaxicon in the top-left corner) and select Remove. This calls `jax_stream.remove`, which removes the photo from the album without deleting the underlying asset from your Immich library.

If you set a **Remove-to album ID** in the stream's options flow, Remove first adds the photo to that recovery album and then removes it from the source album. Fail-safe: if the recovery add fails, the source removal is aborted -- the photo stays put.

The jaxmenu Rate item opens a star-rating overlay (1-5 + unrate). Tap to rate; the rating is sent to Immich via `jax_stream.set_rating`. Ratings sync across devices: rate a photo on one display (or from the dashboard card or an automation) and a "Rated N stars" pill surfaces on every other display showing that same photo.

The jaxmenu Rotate CCW and Rotate CW items fix a sideways photo via Immich's non-destructive edit API. The corrected rendition is shown in place without advancing to the next photo. The rotation sticks for all future appearances of that photo. Requires the `asset.edit.create` Immich key scope.

The jaxmenu first item is a Pause toggle. While manually paused, a play-triangle indicator appears near the jaxicon; tap it to resume. Any screen touch also arms a silent 90-second suppression window before auto-advance resumes. A radial ring badge near the jaxicon shows the remaining suppression window, decaying in real time; tap it to resume immediately.

## The jax-stream view

The integration auto-copies and auto-registers the jax-stream VA view (`/view-assist/jax-stream`) at setup. No manual `view_assist.load_asset` call is needed.

Three styling differences from VA's stock clock view:

- **Responsive font sizes** using `vh`/`vw` units instead of fixed `%` sizes that overflow smaller screens
- **Configurable text opacity** via `rgba(255, 255, 255, var(--jax-text-opacity, 0.7))` -- default 70%; set `--jax-text-opacity` in your theme or card_mod to adjust. The photo shows through without a dark overlay
- **Blurred-fill background** via `ha-card::before` (blurred cover) and `ha-card::after` (sharp contain). The whole photo is visible, and letterbox bars (for portrait photos on a landscape screen) are filled with a blurred version of the same image

## Dashboard card

Watch and control any stream from a normal Lovelace dashboard -- the live photo plus all the curation verbs -- without touching the device. This is the same experience as the device, driven by HA-native controls instead of on-screen gestures. It is a plain stack of built-in cards (no custom card, no HACS resource): the photo updates live on every advance because the image entity's access token rotates whenever the bytes change.

Paste this into a dashboard (Edit dashboard -> Add card -> Manual). The entity IDs embed the stream name; the example uses a stream named `default` -- replace `default` with your stream's slug throughout.

```yaml
type: vertical-stack
title: Jax Stream
cards:
  - type: picture-entity                 # live current photo
    entity: image.jax_stream_default
    show_name: false
    show_state: false
    tap_action:
      action: more-info
  - type: horizontal-stack               # transport: back / pause / next
    cards:
      - type: button
        name: Back
        icon: mdi:skip-previous
        tap_action:
          action: perform-action
          perform_action: button.press
          target:
            entity_id: button.jax_stream_default_previous_photo
      - type: button
        entity: switch.jax_stream_default # Pause switch (toggles, shows state)
        name: Pause
        icon: mdi:pause-circle
      - type: button
        name: Next
        icon: mdi:skip-next
        tap_action:
          action: perform-action
          perform_action: button.press
          target:
            entity_id: button.jax_stream_default   # Next photo (no suffix -- see note)
  - type: horizontal-stack               # curation: rotate / remove
    cards:
      - type: button
        name: Rotate left
        icon: mdi:rotate-left
        tap_action:
          action: perform-action
          perform_action: button.press
          target:
            entity_id: button.jax_stream_default_rotate_counter_clockwise
      - type: button
        name: Rotate right
        icon: mdi:rotate-right
        tap_action:
          action: perform-action
          perform_action: button.press
          target:
            entity_id: button.jax_stream_default_rotate_clockwise
      - type: button
        name: Remove
        icon: mdi:trash-can
        tap_action:
          action: perform-action
          perform_action: button.press
          target:
            entity_id: button.jax_stream_default_remove_photo
          confirmation:
            text: Remove this photo from the album?
  - type: entities                       # rating + album + current asset
    entities:
      - entity: number.jax_stream_default_rating
        name: Rating
      - entity: select.jax_stream_default
        name: Album
      - entity: sensor.jax_stream_default_current_photo
        name: Current photo
```

Note: the Next-photo button has the bare object ID `button.jax_stream_default` (no `_next` suffix) for historical unique-ID reasons -- that is correct, not a typo. The Remove button is confirm-gated. The Pause control is the stream's switch, so it shows and toggles the live pause state. Tapping the photo opens its more-info dialog; the slideshow keeps advancing underneath.

## Required Immich API key scopes

Verified against `server/src/enum.ts` and the asset-media/search controllers:

| Endpoint | Scope | When |
|---|---|---|
| `POST /api/search/random` | `asset.read` | always |
| `GET /api/assets/{id}/thumbnail?size=preview` | `asset.view` | always |
| `PUT /api/assets/{id}` | `asset.update` | jaxmenu star rating |
| `DELETE /api/albums/{id}/assets` | `albumAsset.delete` | jaxmenu remove only |
| `PUT /api/albums/{id}/assets` | `albumAsset.create` | only when a Remove-to (recovery) album is set |
| `PUT /api/assets/{id}/original` (edit) | `asset.edit.create` | jaxmenu rotate CW/CCW |

Basic slideshow: **`asset.read` + `asset.view`**. Add **`asset.update`** to use the jaxmenu star-rating overlay. Add **`albumAsset.delete`** for the jaxmenu remove-from-album action, and **`albumAsset.create`** as well if you set a Remove-to recovery album so removed photos are re-filed there. Add **`asset.edit.create`** to use the jaxmenu rotate CW/CCW items. `asset.download` is not needed -- thumbnail/preview is what we use, and it is also what most WebViews can render (the `/original` endpoint returns the raw file, which for HEIC iPhone photos most WebViews cannot display).

## Troubleshooting

- **View shows VA default gradient:** two common causes: (1) the device home screen is not set to `/view-assist/jax-stream` (VA Dashboard Options -> Home screen); (2) Background mode is not set to `local_random` with the correct Rotate background path in VA Dashboard Options -- without `local_random`, VA ignores the integration's image entity and shows its built-in gradient.
- **All devices show the same photo:** each stream is a separate integration entry with its own album. Add a second integration entry for the second device's album.
- **Photo not advancing:** check the Jax Stream device card in Settings -> Devices & Services -> Jax Stream. The `switch` entity may be paused; flip it to resume.
- **VA Dashboard Options saved wrong:** the form is a full resend -- any field left blank is deleted from your saved config. If settings look wrong, restore from your HA backup and re-enter only the fields you intend to change.

## Attribution

Built for and on top of [View Assist](https://github.com/dinki/View-Assist) by @dinki et al. The bundled jax-stream view draws on VA's `clockalt.yaml` as a design reference.
