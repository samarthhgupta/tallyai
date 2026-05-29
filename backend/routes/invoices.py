"""
invoices.py — FastAPI router for invoice upload and extraction.

POST /invoices/upload
  - Accepts multipart/form-data: files (list[UploadFile]) + company_id (str)
  - Converts each file to image/text content
  - Sends to Claude claude-opus-4-5 for extraction
  - Returns batch_id + per-file extracted invoices
"""

from __future__ import annotations

import base64
import io
import uuid
import logging
from typing import Optional

import anthropic
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["invoices"])

SYSTEM_PROMPT = """You are an expert Indian invoice data extractor. Extract ALL invoices from the provided document. A single document may contain multiple separate invoices.

For each invoice found, return a JSON object with:
{
  "vendor_name": string,
  "invoice_number": string,
  "invoice_date": string (YYYY-MM-DD),
  "vendor_gstin": string or null,
  "vendor_address": string or null,
  "line_items": [
    {
      "hsn": string (HSN or SAC code),
      "gst_percent": number,
      "uom": string (unit of measure as printed, e.g. "Nos", "Kg", "Pcs", "Mtr"),
      "qty": number,
      "rate": number (EXCLUSIVE of GST),
      "disc_percent": number (0 if no discount)
    }
  ],
  "subtotal": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "round_off": number (0 if none),
  "total": number,
  "tax_type": "cgst_sgst" or "igst",
  "confidence": number between 0 and 1
}

Return ONLY a JSON array [...] of invoice objects. No markdown, no explanation.

Rules:
- Line items: do NOT capture product/service names. HSN/SAC code is mandatory per line item.
- If a line item has no explicit HSN, put "UNKNOWN".
- Rate must always be EX-GST (back-calculate if needed: if invoice shows inclusive rate, divide by (1 + gst_percent/100)).
- Confidence: 1.0 = all fields clearly visible, 0.5 = some fields unclear/missing, 0.0 = cannot read.
- If multiple invoices exist in the document, return all of them."""


def compute_confidence(inv: dict) -> float:
    score = inv.get("confidence", 0.5)
    # Penalize missing fields
    if not inv.get("vendor_gstin"):
        score -= 0.05
    if not inv.get("invoice_number"):
        score -= 0.1
    if not inv.get("invoice_date"):
        score -= 0.1
    if not inv.get("line_items"):
        score -= 0.2
    # Penalize if total doesn't match computed
    computed = sum(
        item["qty"] * item["rate"] * (1 - item.get("disc_percent", 0) / 100)
        for item in inv.get("line_items", [])
    )
    tax = inv.get("cgst", 0) + inv.get("sgst", 0) + inv.get("igst", 0)
    expected_total = computed + tax + inv.get("round_off", 0)
    actual_total = inv.get("total", 0)
    if actual_total > 0 and abs(expected_total - actual_total) > 1:
        score -= 0.15
    return max(0.0, min(1.0, score))


def _pdf_to_images(file_bytes: bytes) -> list[dict]:
    """Convert PDF pages to base64 PNG images using PyMuPDF (fitz)."""
    import fitz  # PyMuPDF

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    content_parts = []
    for page in doc:
        mat = fitz.Matrix(150 / 72, 150 / 72)  # 150 DPI
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")
        b64 = base64.standard_b64encode(img_bytes).decode()
        content_parts.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": b64,
            },
        })
    doc.close()
    return content_parts


def _image_to_content(file_bytes: bytes, media_type: str) -> list[dict]:
    """Convert image bytes to Claude content part."""
    b64 = base64.standard_b64encode(file_bytes).decode()
    return [{
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": b64,
        },
    }]


def _docx_to_text(file_bytes: bytes) -> list[dict]:
    """Extract text from .docx using python-docx."""
    from docx import Document

    doc = Document(io.BytesIO(file_bytes))
    text = "\n".join(para.text for para in doc.paragraphs if para.text.strip())
    return [{"type": "text", "text": text or "(empty document)"}]


def _doc_to_text(file_bytes: bytes) -> list[dict]:
    """Fallback text extraction for .doc (try plain text decode)."""
    try:
        text = file_bytes.decode("utf-8", errors="ignore")
    except Exception:
        text = "(could not decode .doc file)"
    return [{"type": "text", "text": text}]


async def _build_content_parts(upload: UploadFile) -> list[dict]:
    """Read an UploadFile and return Claude content parts."""
    file_bytes = await upload.read()
    filename = (upload.filename or "").lower()
    content_type = (upload.content_type or "").lower()

    if filename.endswith(".pdf") or "pdf" in content_type:
        return _pdf_to_images(file_bytes)
    elif filename.endswith(".png") or "png" in content_type:
        return _image_to_content(file_bytes, "image/png")
    elif filename.endswith((".jpg", ".jpeg")) or "jpeg" in content_type:
        return _image_to_content(file_bytes, "image/jpeg")
    elif filename.endswith(".docx"):
        return _docx_to_text(file_bytes)
    elif filename.endswith(".doc"):
        return _doc_to_text(file_bytes)
    else:
        # Attempt as plain text fallback
        try:
            text = file_bytes.decode("utf-8", errors="ignore")
        except Exception:
            text = "(unreadable file)"
        return [{"type": "text", "text": text}]


async def _extract_invoices_from_file(
    upload: UploadFile, client: anthropic.Anthropic
) -> tuple[list[dict], Optional[str]]:
    """
    Extract invoices from a single file.
    Returns (invoices_list, error_or_None).
    """
    import json

    try:
        content_parts = await _build_content_parts(upload)
    except Exception as exc:
        logger.exception("Failed to process file %s", upload.filename)
        return [], f"Could not process file: {exc}"

    try:
        response = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": content_parts
                    + [{"type": "text", "text": "Extract all invoices from this document."}],
                }
            ],
        )
        raw_text = response.content[0].text.strip()
    except Exception as exc:
        logger.exception("Claude API call failed for %s", upload.filename)
        return [], f"Claude API error: {exc}"

    try:
        invoices = json.loads(raw_text)
        if not isinstance(invoices, list):
            invoices = [invoices]
    except json.JSONDecodeError:
        # Try to extract JSON array from response
        import re
        match = re.search(r"\[.*\]", raw_text, re.DOTALL)
        if match:
            try:
                invoices = json.loads(match.group())
                if not isinstance(invoices, list):
                    invoices = [invoices]
            except json.JSONDecodeError:
                return [], f"Could not parse Claude response as JSON: {raw_text[:200]}"
        else:
            return [], f"No JSON array found in Claude response: {raw_text[:200]}"

    # Apply confidence scoring
    for inv in invoices:
        inv["confidence"] = compute_confidence(inv)

    return invoices, None


@router.post("/upload")
async def upload_invoices(
    files: list[UploadFile] = File(...),
    company_id: str = Form(...),
):
    """
    Upload one or more invoice files for extraction.

    Returns batch_id, per-file results, and total invoice count.
    """
    import os

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return JSONResponse(
            status_code=500,
            content={"detail": "ANTHROPIC_API_KEY not configured on server."},
        )

    client = anthropic.Anthropic(api_key=api_key)
    batch_id = str(uuid.uuid4())

    file_results = []
    total_invoices = 0

    for upload in files:
        invoices, error = await _extract_invoices_from_file(upload, client)
        file_results.append({
            "filename": upload.filename or "unknown",
            "invoices": invoices,
            "error": error,
        })
        total_invoices += len(invoices)

    return {
        "batch_id": batch_id,
        "file_results": file_results,
        "total_invoices": total_invoices,
    }
