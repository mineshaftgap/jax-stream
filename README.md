# Jax Stream

*Jax Stream: HA View Assist Immich Slideshow.*

Drop-in slideshow that cycles through an Immich album's photos as the
background of a dedicated [View Assist](https://github.com/dinki/View-Assist)
view on your displays. Supports multiple independent streams so different
displays can show different albums. Packaged as a HACS custom integration.

## Dedication

In my old setup, one of the things I loved seeing was the goofy mug of
my incredible dog Jackson ("Jax" for short) as I walked by one of my
Echo Shows. When switching over to View Assist, I wanted that sweet
reminder of my gentle giant -- so this is dedicated as a loving
memory for him.

![Jax](docs/images/jax.jpg)

## Why this exists

A few Immich+HA slideshow options already exist; none of them fit a
View Assist install without compromises:

| Project | Gap that left a hole |
|---|---|
| [damongolding/immich-kiosk](https://github.com/damongolding/immich-kiosk) | Works well, but requires running a separate Docker container next to Immich and HA. Adds an extra service to manage, monitor, and update |
| [mulder82/immich-slideshow](https://github.com/mulder82/immich-slideshow) (HACS) | Active and maintained, but POSTs `/api/search/random` with no `albumIds` filter -- you get a random asset from the whole library, not from one album. No per-device targeting |
| [outadoc/immich-home-assistant](https://github.com/outadoc/immich-home-assistant) (HACS) | Has album filtering, but unmaintained for 2+ years, 5-minute interval hardcoded, broken on HA 2025.6+ |

Jax Stream is the "no extra container" middle ground: VA-native, per-device, no extra container -- packaged as a first-class HA custom integration (config flow + coordinator + image entity).

## Features

- Rotating Immich photo background per VA device, default 1-minute interval (configurable per stream)
- Native HA `image` entity plus `button`, `switch`, and `select` control entities per stream
- `jax_stream` services: refresh, next, remove, set_rating, pause, resume -- callable from automations, scripts, the mobile app, and voice assistants
- On-screen actions: swipe left to advance, swipe right for up-to-10 blob history back-nav (photos slide to follow the finger); jaxmenu: remove from album, star rating (1-5 + Unrate), pause toggle
- Dedicated auto-registered jax-stream VA view (blurred-fill letterbox, 70% text opacity)
- Per-device per-stream targeting -- different albums on different displays
- Integration-served frontend module -- no manual `frontend:` config needed
- Responsive sizing: works on 960x480 (Echo Show 5) and 1280x800 (Echo Show 8) without tweaks

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

That is the whole install -- no YAML editing, no shell scripts, no manual view
registration. To add another stream for another device, repeat "Add Integration"
with a different album ID and stream name. Edit any stream later via its options
flow (also where you set an optional Remove-to recovery album).

### Manual Installation

1. Copy `custom_components/jax_stream/` into your HA `custom_components/` directory
2. Restart Home Assistant
3. Add the integration via Settings -> Devices & Services -> Add Integration and fill the config-flow form (same fields as above)

## Entities

Per stream (visible in Settings -> Devices & Services -> Jax Stream -> the per-stream device card):

- `image.jax_stream_<id>` -- current photo (served by the integration)
- `button.jax_stream_<id>` -- press to advance to the next photo
- `switch.jax_stream_<id>` -- on = paused, off = resume
- `select.jax_stream_<id>` -- change the active album from your Immich library

## Services

Services in the `jax_stream` domain, callable from automations, scripts, the
mobile app, and voice assistants:

| Service | What it does |
|---|---|
| `jax_stream.refresh` | Force-fetch a new photo (bypasses pause gate) |
| `jax_stream.next` | Advance to the next queued photo |
| `jax_stream.remove` | Remove current photo from source album (recovery-first if configured) |
| `jax_stream.set_rating` | Set Immich star rating 1-5 (0 = unrate) |
| `jax_stream.pause` | Pause auto-advance |
| `jax_stream.resume` | Resume (clears both manual pause and touch-window) |

## Usage

Swipe **left** to advance to the next photo. Swipe **right** to go back to the
previous photo, walking an in-memory blob history of up to 10 recently shown
photos; swipe left from history moves forward again, and at the end of the
history the queue resumes normally. Photos slide horizontally to follow the
finger. Back-navigation is local to the device -- it touches no server state.

To remove a photo from the album, open the jaxmenu (tap the jaxicon in the
top-left corner) and select Remove. This calls `jax_stream.remove`, which
removes the photo from the album without deleting the underlying asset from your
Immich library.

If you set a **Remove-to album ID** in the stream's options flow, Remove first
adds the photo to that recovery album and then removes it from the source album.
Fail-safe: if the recovery add fails, the source removal is aborted -- the
photo stays put.

The jaxmenu Rate item opens a star-rating overlay (1-5 + Unrate). Tap to rate;
the rating is sent to Immich via `jax_stream.set_rating`.

The jaxmenu first item is a Pause toggle. While manually paused, a play-triangle
indicator appears near the jaxicon; tap it to resume. Any screen touch also arms
a silent 90-second suppression window before auto-advance resumes.

## The jax-stream view

The integration auto-copies and auto-registers the jax-stream VA view
(`/view-assist/jax-stream`) at setup. No manual `view_assist.load_asset` call
is needed.

Three styling differences from VA's stock clock view:

- **Responsive font sizes** using `vh`/`vw` units instead of fixed `%` sizes
  that overflow smaller screens
- **70% text opacity** via `rgba(255, 255, 255, 0.7)` plus `text-shadow`/`drop-shadow`
  -- the photo shows through without a dark overlay
- **Blurred-fill background** via `ha-card::before` (blurred cover) and
  `ha-card::after` (sharp contain). The whole photo is visible, and letterbox bars
  (for portrait photos on a landscape screen) are filled with a blurred version
  of the same image

**Set the home screen and background mode (one-time, VIEW-03).** Settings ->
Devices & Services -> View Assist -> Master Configuration -> Configure ->
Dashboard Options. Set two fields:

- **Home screen**: `/view-assist/jax-stream`
- **Background settings -> Background mode**: `local_random`
- **Background settings -> Rotate background path**: `images/jax-stream/<stream>`
  (replace `<stream>` with the stream name you entered in the config-flow form)

Without `local_random`, VA uses its default blue gradient -- the Immich photos
will not appear even if the integration is running correctly.

> **Warning:** the VA Dashboard Options form is a full-form resend. Any field
> you leave blank or any section you send as empty is **deleted** from your
> saved config. Always fill in every field that appears pre-filled; only change
> the field you intend to change. Close the dialog with X if you do not want
> to save.

## Required Immich API key scopes

Verified against `server/src/enum.ts` and the asset-media/search controllers:

| Endpoint | Scope | When |
|---|---|---|
| `POST /api/search/random` | `asset.read` | always |
| `GET /api/assets/{id}/thumbnail?size=preview` | `asset.view` | always |
| `PUT /api/assets/{id}` | `asset.update` | jaxmenu star rating |
| `DELETE /api/albums/{id}/assets` | `albumAsset.delete` | jaxmenu remove only |
| `PUT /api/albums/{id}/assets` | `albumAsset.create` | only when a Remove-to (recovery) album is set |

Basic slideshow: **`asset.read` + `asset.view`**. Add **`asset.update`** to
use the jaxmenu star-rating overlay. Add **`albumAsset.delete`** for the
jaxmenu remove-from-album action, and **`albumAsset.create`** as well if you
set a Remove-to recovery album so removed photos are re-filed there.
`asset.download` is not needed -- thumbnail/preview is what we use, and it is
also what most WebViews can render (the `/original` endpoint returns the raw
file, which for HEIC iPhone photos most WebViews cannot display).

## Troubleshooting

- **View shows VA default gradient:** two common causes: (1) the device home
  screen is not set to `/view-assist/jax-stream` (VA Dashboard Options ->
  Home screen); (2) Background mode is not set to `local_random` with the
  correct Rotate background path in VA Dashboard Options -- without `local_random`,
  VA ignores the integration's image entity and shows its built-in gradient.
- **All devices show the same photo:** each stream is a separate integration
  entry with its own album. Add a second integration entry for the second
  device's album.
- **Photo not advancing:** check the Jax Stream device card in Settings ->
  Devices & Services -> Jax Stream. The `switch` entity may be paused;
  flip it to resume.

## Attribution

Built for and on top of [View Assist](https://github.com/dinki/View-Assist)
by @dinki et al. The bundled jax-stream view draws on VA's `clockalt.yaml`
as a design reference.
