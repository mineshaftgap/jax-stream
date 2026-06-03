#!/usr/bin/env bash
# jax_stream_swipe.sh -- act on a swipe gesture then advance to the next photo.
#
# Called by shell_command.jax_stream_swipe, which the browser-side swipe module
# (www/jax_stream_swipe.js) invokes with the two values it knows:
#
#   $1  stream     the stream subdir (which photo frame was swiped)
#   $2  direction  left | right
#
# Swipe semantics:
#   left  -- remove the on-screen photo from the Immich album, then advance
#   right -- advance only (no Immich write)
#
# Everything else (host, api_key, album_id, flags) is read from the per-stream
# swipe.conf that jax_stream_refresh.sh writes on every tick. This keeps Immich
# credentials out of the browser/service-call payload and lets the swipe handler
# stay {stream, direction}-only.
#
# Requires: asset.read + asset.view + albumAsset.delete (left-swipe removal)

set -euo pipefail

STREAM="${1:?jax_stream_swipe: missing stream arg (\$1)}"
DIRECTION="${2:?jax_stream_swipe: missing direction arg (\$2)}"

case "$STREAM" in
  ""|*[!a-zA-Z0-9_-]*)
    echo "jax_stream_swipe: stream must be [A-Za-z0-9_-]+ (got: $STREAM)" >&2
    exit 1 ;;
esac
case "$DIRECTION" in
  left|right) : ;;
  *)
    echo "jax_stream_swipe: direction must be left|right (got: $DIRECTION)" >&2
    exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="/config/view_assist/images/jax-stream/${STREAM}"
CUR_FILE="${OUT_DIR}/current.txt"
CONF_FILE="${OUT_DIR}/swipe.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "jax_stream_swipe: no swipe.conf for stream '$STREAM' -- has jax_stream_refresh run yet?" >&2
  exit 1
fi

# Parse swipe.conf as plain KEY=VALUE (never sourced -- values are untrusted).
HOST=""; API_KEY=""; ALBUM_ID=""
LANDSCAPE_ONLY="false"; ALLOW_INSECURE="false"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    HOST=*)           HOST=${line#HOST=} ;;
    API_KEY=*)        API_KEY=${line#API_KEY=} ;;
    ALBUM_ID=*)       ALBUM_ID=${line#ALBUM_ID=} ;;
    LANDSCAPE_ONLY=*) LANDSCAPE_ONLY=${line#LANDSCAPE_ONLY=} ;;
    ALLOW_INSECURE=*) ALLOW_INSECURE=${line#ALLOW_INSECURE=} ;;
  esac
done < "$CONF_FILE"

HOST="${HOST%/}"

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

CURL_OPTS=(-fsS)
is_true "$ALLOW_INSECURE" && CURL_OPTS+=(-k)

ASSET_ID=""
[ -f "$CUR_FILE" ] && ASSET_ID=$(head -n1 "$CUR_FILE" | tr -d '[:space:]')

if [ "$DIRECTION" = left ] && [ -n "$ASSET_ID" ] && [ -n "$ALBUM_ID" ]; then
  BODY=$(python3 -c 'import json,sys; print(json.dumps({"ids":[sys.argv[1]]}))' "$ASSET_ID")
  curl "${CURL_OPTS[@]}" -X DELETE \
    -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" "$HOST/api/albums/$ALBUM_ID/assets" >/dev/null || \
    echo "jax_stream_swipe: album-remove failed for asset '$ASSET_ID'; advancing anyway" >&2
elif [ "$DIRECTION" = left ]; then
  echo "jax_stream_swipe: left swipe but no asset id or album id; advancing only" >&2
fi

# Advance to the next photo (right swipe just falls through to here).
exec bash "$SCRIPT_DIR/jax_stream_refresh.sh" \
  "$HOST" "$API_KEY" "$ALBUM_ID" "$STREAM" \
  "$LANDSCAPE_ONLY" "$ALLOW_INSECURE"
