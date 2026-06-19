"""
Loads the system prompt from Supabase with a 60-second in-process cache.

The cache avoids a Supabase roundtrip on every extraction call (saves 100-500ms).
Changes to the prompt_rules table take effect within 60 seconds.

Table: prompt_rules
Columns: key (text, unique), content (text), updated_at (timestamptz)
Row: key = 'system_prompt'
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

_FALLBACK_NOTE = (
    "[PROMPT NOT LOADED — Supabase unavailable. "
    "Check SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.]"
)

_cache: dict[str, object] = {"prompt": None, "fetched_at": 0.0}
_CACHE_TTL = 60.0  # seconds


def get_system_prompt(fallback: str = "") -> str:
    """
    Fetch the current system prompt from Supabase, with a 60-second in-process cache.
    Falls back to `fallback` (the hardcoded prompt) if Supabase is unreachable.
    """
    now = time.monotonic()
    if _cache["prompt"] and (now - float(_cache["fetched_at"])) < _CACHE_TTL:
        return _cache["prompt"]  # type: ignore[return-value]

    try:
        from lib.supabase_client import get_supabase
        sb = get_supabase()
        result = (
            sb.table("prompt_rules")
            .select("content")
            .eq("key", "system_prompt")
            .single()
            .execute()
        )
        content = result.data.get("content", "").strip()
        if not content:
            logger.warning("prompt_rules row for 'system_prompt' is empty — using fallback")
            return fallback or _FALLBACK_NOTE
        _cache["prompt"] = content
        _cache["fetched_at"] = now
        return content
    except Exception as exc:
        logger.warning("Could not load system prompt from Supabase (%s) — using fallback", exc)
        return fallback or _FALLBACK_NOTE
