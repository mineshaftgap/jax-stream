#!/usr/bin/env bash
# jax_stream_refresh.sh -- fetch one Immich photo for a stream and write it to
# /config/view_assist/images/jax-stream/<stream>/random.jpg, plus two sidecars:
#   current.txt  the chosen asset id (so the swipe handler knows what to remove)
#   swipe.conf   this stream's config (so jax_stream_swipe.sh, invoked with only
#                {stream, direction} from the browser, can re-derive host/key/etc)
#
# Called by shell_command.jax_stream_refresh from a blueprint automation.
# All inputs are positional, supplied by the blueprint instance:
#
#   $1  immich_host     e.g. https://immich.example.com (no trailing slash)
#   $2  immich_api_key  Immich API key (see scopes below)
#   $3  album_id        Immich album UUID this stream pulls from
#   $4  stream_name     subdir under images/jax-stream/ to write to
#   $5  landscape_only  true|false -- keep only landscape photos (default: false)
#   $6  allow_insecure  true|false -- add curl -k for self-signed https (default: false)
#
# API key scopes:
#   asset.read + asset.view     always (search/random + thumbnail)
#   album.addAsset              only when swipe-left (remove from album) is used
#
# Tunables (env overridable): JAX_BATCH_SIZE over-fetch size for landscape
# filtering (default 25); JAX_RETRY_CAP max batches before giving up and leaving
# the current photo in place (default 4).
#
# The API key appears in this process's argv for the duration of the run
# (visible to other processes via `ps` on the HA box) and is written to
# swipe.conf (mode 600). HA also persists the key in the rendered automation
# YAML on disk, so neither is the weakest link in a single-user lab setup.

set -euo pipefail

HOST="${1:?jax_stream_refresh: missing immich_host arg (\$1)}"
API_KEY="${2:?jax_stream_refresh: missing immich_api_key arg (\$2)}"
ALBUM_ID="${3:?jax_stream_refresh: missing album_id arg (\$3)}"
STREAM="${4:?jax_stream_refresh: missing stream_name arg (\$4)}"
LANDSCAPE_ONLY="${5:-false}"; [ -z "$LANDSCAPE_ONLY" ] && LANDSCAPE_ONLY=false
ALLOW_INSECURE="${6:-false}"; [ -z "$ALLOW_INSECURE" ] && ALLOW_INSECURE=false

HOST="${HOST%/}"   # tolerate an accidental trailing slash in the Immich URL

BATCH_SIZE="${JAX_BATCH_SIZE:-25}"
RETRY_CAP="${JAX_RETRY_CAP:-4}"

case "$STREAM" in
  ""|*[!a-zA-Z0-9_-]*)
    echo "jax_stream_refresh: stream_name must be [A-Za-z0-9_-]+ (got: $STREAM)" >&2
    exit 1 ;;
esac

# Jinja renders HA booleans as "True"/"False"; accept those plus the usual forms.
is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

LANDSCAPE01=0; is_true "$LANDSCAPE_ONLY" && LANDSCAPE01=1

# Build one curl option array so the insecure flag covers EVERY request, not
# just some of them.
CURL_OPTS=(-fsS)
is_true "$ALLOW_INSECURE" && CURL_OPTS+=(-k)

OUT_DIR="/config/view_assist/images/jax-stream/${STREAM}"
OUT_FILE="${OUT_DIR}/random.jpg"
CUR_FILE="${OUT_DIR}/current.txt"
CONF_FILE="${OUT_DIR}/swipe.conf"
mkdir -p "$OUT_DIR"

# Persist this stream's config for jax_stream_swipe.sh (mode 600). Written every
# run so it tracks blueprint edits; written even when no photo matched.
write_conf() {
  local tmp="${CONF_FILE}.tmp"
  ( umask 077
    {
      printf 'HOST=%s\n'           "$HOST"
      printf 'API_KEY=%s\n'        "$API_KEY"
      printf 'ALBUM_ID=%s\n'       "$ALBUM_ID"
      printf 'LANDSCAPE_ONLY=%s\n' "$LANDSCAPE_ONLY"
      printf 'ALLOW_INSECURE=%s\n' "$ALLOW_INSECURE"
    } > "$tmp" )
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$CONF_FILE"
}

# When landscape filtering, batch-fetch and keep the first landscape asset.
# Otherwise, fetch exactly one -- no client-side filtering needed.
if [ "$LANDSCAPE01" = 1 ]; then SIZE="$BATCH_SIZE"; CAP="$RETRY_CAP"; else SIZE=1; CAP=1; fi

build_body() {
  python3 -c 'import json,sys
album,landscape,size=sys.argv[1:4]
b={"albumIds":[album],"type":"IMAGE","size":int(size)}
if landscape=="1":
    b["withExif"]=True
print(json.dumps(b))' "$ALBUM_ID" "$LANDSCAPE01" "$SIZE"
}

# From a batch response on stdin, print candidate ids in order. When landscape
# filtering, keep only assets whose orientation-corrected width > height; skip
# assets missing exif dimensions (cannot classify -> not a survivor).
candidates_from_batch() {
  python3 -c 'import json,sys
landscape = sys.argv[1] == "1"
for a in json.load(sys.stdin):
    aid = a.get("id")
    if not aid:
        continue
    if landscape:
        ex = a.get("exifInfo") or {}
        w = ex.get("exifImageWidth"); h = ex.get("exifImageHeight")
        if not w or not h:
            continue
        try:
            o = int(ex.get("orientation") or 1)
        except (TypeError, ValueError):
            o = 1
        if o in (5, 6, 7, 8):
            w, h = h, w
        if not (w > h):
            continue
    print(aid)' "$1"
}

CHOSEN=""
attempt=0
while [ "$attempt" -lt "$CAP" ] && [ -z "$CHOSEN" ]; do
  attempt=$((attempt + 1))
  BODY=$(build_body)
  if ! BATCH=$(curl "${CURL_OPTS[@]}" -X POST \
        -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
        -d "$BODY" "$HOST/api/search/random"); then
    echo "jax_stream_refresh: /api/search/random failed (attempt $attempt/$CAP)" >&2
    continue
  fi

  IDS=$(printf '%s' "$BATCH" | candidates_from_batch "$LANDSCAPE01")
  [ -z "$IDS" ] && continue

  CHOSEN=$(printf '%s\n' "$IDS" | head -n1)
done

if [ -z "$CHOSEN" ]; then
  # Bounded give-up: never blank or error -- leave the current photo in place.
  LS_NOTE=""; [ "$LANDSCAPE01" = 1 ] && LS_NOTE=" (landscape)"
  echo "jax_stream_refresh: no matching asset after $CAP batch(es)${LS_NOTE}; keeping current photo" >&2
  write_conf
  exit 0
fi

TMP="${OUT_FILE}.tmp"
curl "${CURL_OPTS[@]}" -H "x-api-key: $API_KEY" \
  "$HOST/api/assets/$CHOSEN/thumbnail?size=preview" \
  -o "$TMP"
mv "$TMP" "$OUT_FILE"

CTMP="${CUR_FILE}.tmp"
printf '%s\n' "$CHOSEN" > "$CTMP"
mv "$CTMP" "$CUR_FILE"

write_conf
