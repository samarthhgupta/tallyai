"""
Loads the system prompt from Supabase on every call (no cache).
This ensures rule changes take effect immediately when you test.

Table: prompt_rules
Columns: key (text, unique), content (text), updated_at (timestamptz)
Row: key = 'system_prompt'
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_FALLBACK_NOTE = (
    "[PROMPT NOT LOADED — Supabase unavailable. "
    "Check SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.]"
)


def get_system_prompt(fallback: str = "") -> str:
    """
    Fetch the current system prompt from Supabase.
    Falls back to `fallback` (the hardcoded prompt) if Supabase is unreachable,
    so extractions never break even if Supabase is down.
    """
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
        return content
    except Exception as exc:
        logger.warning("Could not load system prompt from Supabase (%s) — using fallback", exc)
        return fallback or _FALLBACK_NOTE
