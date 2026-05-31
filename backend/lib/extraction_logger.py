"""
Logs every invoice extraction result to Supabase.

Table: extraction_logs
Columns:
  id              bigserial primary key
  created_at      timestamptz default now()
  batch_id        text
  file_name       text
  invoices        jsonb        -- full extracted invoice array
  invoice_count   integer
  processing_ms   integer
  error           text         -- null if successful
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def log_extraction(
    *,
    batch_id: str,
    file_name: str,
    invoices: list[dict],
    processing_ms: int,
    error: str | None = None,
) -> None:
    """
    Fire-and-forget: save extraction result to Supabase.
    Never raises — a logging failure must never break an extraction.
    """
    try:
        from lib.supabase_client import get_supabase
        sb = get_supabase()
        sb.table("extraction_logs").insert({
            "batch_id": batch_id,
            "file_name": file_name,
            "invoices": invoices,
            "invoice_count": len(invoices),
            "processing_ms": processing_ms,
            "error": error,
        }).execute()
    except Exception as exc:
        logger.warning("Failed to log extraction to Supabase: %s", exc)
