"""Per-entry stream subdir derivation (GH issue #1).

Pure python -- no HA imports, so the unit tests run with plain python3.

ASCII only -- no Unicode.
"""
from __future__ import annotations

import re

from .const import MAX_STREAM_SUBDIR_LEN, STREAM_NAME_RE

_SEPARATOR_RUN_RE = re.compile(r"-+")


def slugify_stream_name(name: str) -> str:
    """Return a filesystem-safe subdir slug, or "" if the name is unusable.

    Lowercase and strip, then keep only ASCII alnum/dash/underscore chars;
    space/./ and \\ map to a dash; everything else is dropped. The
    ch.isascii() guard is load-bearing -- bare ch.isalnum() is True for
    accented and non-Latin letters and would let non-ASCII into a disk path
    (T-GH1-01). Runs of dashes collapse, leading/trailing dash/underscore are
    stripped, the result is truncated to MAX_STREAM_SUBDIR_LEN (T-GH1-03) and
    re-stripped, and a final STREAM_NAME_RE gate rejects anything left over
    that still is not a safe path segment. Never raises.
    """
    if not isinstance(name, str) or not name:
        return ""

    lowered = name.strip().lower()
    if not lowered:
        return ""

    chars = []
    for ch in lowered:
        if ch.isascii() and (ch.isalnum() or ch in "-_"):
            chars.append(ch)
        elif ch in " ./\\":
            chars.append("-")
        # else: drop the character entirely (non-ASCII, punctuation, etc.)

    slug = "".join(chars)
    slug = _SEPARATOR_RUN_RE.sub("-", slug)
    slug = slug.strip("-_")

    if len(slug) > MAX_STREAM_SUBDIR_LEN:
        slug = slug[:MAX_STREAM_SUBDIR_LEN].rstrip("-_")

    if not slug or not STREAM_NAME_RE.match(slug):
        return ""
    return slug


def subdir_in_use(subdir: str, existing: list[str]) -> bool:
    """Case-insensitive membership test against already-configured subdirs."""
    target = (subdir or "").lower()
    return any(target == (e or "").lower() for e in existing)
