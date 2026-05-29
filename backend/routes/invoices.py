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
      "rate": number,
      "disc_percent": number,
      "amount": number
    }
  ],
  "subtotal": number,
  "bill_discount_amount": number (0 if no bill-level discount),
  "bill_discount_percent": number or null (% if percentage-based, null if fixed rupee amount or no discount),
  "cgst": number,
  "sgst": number,
  "igst": number,
  "round_off": number (0 if none),
  "total": number,
  "tax_type": "cgst_sgst" or "igst",
  "confidence": number between 0 and 1
}

Return ONLY a JSON array [...] of invoice objects. No markdown, no explanation.

CRITICAL RATE RULE — read this carefully:
- "rate" must ALWAYS be the rate per unit BEFORE discount, EXCLUDING GST.
- "disc_percent" is the discount percentage shown on the invoice.
- "amount" is the line total as printed on the invoice (after discount, before GST).

The correct relationship is: amount = qty × rate × (1 - disc_percent/100)

Many Indian invoices show columns like: Rate | Discount% | Amount
In this case "Rate" is already the pre-discount rate — use it directly.

Some invoices show a discounted rate in the Rate column. To detect this:
  If the invoice shows an Amount column, back-calculate the pre-discount rate:
  rate = amount / (qty × (1 - disc_percent/100))

EXAMPLE (Dream Touch style invoice):
  Printed columns: Rate=331.10, Disc=14%, Qty=30, Amount=9933
  331.10 is the POST-discount rate. You must back-calculate:
  rate = 9933 / (30 × (1 - 14/100)) = 9933 / 25.8 = 385.00  ← this is what goes in "rate"
  disc_percent = 14
  amount = 9933

EXAMPLE (standard invoice):
  Printed columns: Rate=1000, Disc=0%, Qty=5, Amount=5000
  rate = 1000, disc_percent = 0, amount = 5000

Always exclude GST from rate. If invoice shows GST-inclusive rate, divide by (1 + gst_percent/100).

BILL-LEVEL DISCOUNT RULE:
Some Indian invoices show a discount on the overall invoice value (not per line item). This is especially common in handwritten invoices. Look for ANY of these patterns anywhere between the line items subtotal and the GST section:
  - Words: "Discount", "Trade Discount", "Less", "Less Discount", "(-)", or just a "−" / "-" sign next to an amount
  - A percentage stated at bill level (e.g. "Less 5%", "Discount 10%")
  - A fixed rupee amount below the subtotal that is being subtracted (e.g. "Less  500", "- 250.00")
  - Handwritten invoices often just write "Less" followed by an amount with no label

When a bill-level discount is present:
  - Set "bill_discount_amount" to the rupee value of the discount
  - Set "bill_discount_percent" to the percentage if it was stated as a %, or null if it was a fixed rupee amount
  - All line items should have disc_percent = 0 (the discount is NOT per-line)
  - GST is calculated on (subtotal - bill_discount_amount), NOT on the full subtotal
  - The invoice flow is: Subtotal → minus Bill Discount → Taxable Value → plus GST → Total

TOTAL IN WORDS RULE:
On computer-generated Indian invoices, the total amount is almost always printed in words (e.g. "Rupees One Hundred Eighteen Only", "Rs. One Thousand Two Hundred and Fifty Only"). This appears near the bottom of the invoice, often labelled "Amount in Words", "Total in Words", or just written out with "Only" as a suffix.

Use this when:
  - The numeric total is not visible (cut off, poorly scanned, obscured)
  - The numeric total field reads 0 or is missing
  - You can compute a total from line items + GST but want to cross-verify

How to parse:
  - Convert the words to a number (e.g. "One Hundred Eighteen" → 118)
  - Use that number as the "total" field
  - Set confidence slightly lower (subtract 0.05) since you derived total from words rather than reading it directly
  - The "Only" suffix is just a convention — ignore it when parsing

If both numeric total and words total are present and they disagree by more than ₹1, prefer the words total (it is harder to OCR-misread words than digits) and flag the discrepancy by lowering confidence.

SELF-CORRECTION STEP — always do this before finalising each invoice:
  1. Compute: expected_total = sum_of_line_amounts - bill_discount_amount + cgst + sgst + igst + round_off
  2. Compare expected_total with the printed total on the invoice.
  3. If the difference is more than ₹1, scan the entire invoice document again for any number that is close to that difference (within ₹2 rounding).
  4. Check if that number appears next to "Less", "Discount", "−", or any subtraction indicator.
  5. If yes — that is a missed bill-level discount. Set bill_discount_amount to that value and recalculate.
  6. Only after this check should you finalise the invoice JSON.

When NO bill-level discount is present:
  - Set "bill_discount_amount": 0
  - Set "bill_discount_percent": null

Other rules:
- Line items: do NOT capture product/service names. HSN/SAC code is mandatory per line item.
- If a line item has no explicit HSN, put "UNKNOWN".
- Confidence: 1.0 = all fields clearly visible, 0.5 = some fields unclear/missing, 0.0 = cannot read.
- If multiple invoices exist in the document, return all of them."""


def normalize_hsn_codes(inv: dict) -> dict:
    """Strip dots and spaces from HSN/SAC codes (e.g. '1234.56.78' → '12345678')."""
    for item in inv.get("line_items", []):
        hsn = item.get("hsn", "")
        if hsn and hsn != "UNKNOWN":
            item["hsn"] = hsn.replace(".", "").replace(" ", "")
    return inv


def correct_line_item_rates(inv: dict) -> dict:
    """
    Self-correct extracted rates using the printed amount as ground truth.

    If the invoice has an amount column, we can always derive the true
    pre-discount, ex-GST rate regardless of what the AI extracted:
        rate = amount / (qty * (1 - disc_percent/100))

    This catches cases where Claude extracts the post-discount rate.
    """
    for item in inv.get("line_items", []):
        amount = item.get("amount")
        qty = item.get("qty", 0)
        disc = item.get("disc_percent", 0)

        if amount and qty and qty > 0:
            divisor = qty * (1 - disc / 100)
            if divisor > 0:
                correct_rate = round(amount / divisor, 2)
                # Only override if it meaningfully differs (>1% difference)
                current_rate = item.get("rate", 0)
                if current_rate == 0 or abs(correct_rate - current_rate) / max(correct_rate, 0.01) > 0.01:
                    item["rate"] = correct_rate

    return inv


def detect_bill_discount_from_total(inv: dict) -> dict:
    """
    Mathematical fallback: if computed total > invoice total by more than ₹1
    and no bill discount was already extracted, the difference is almost certainly
    an undetected bill-level discount (e.g. handwritten "Less ₹X").

    We auto-set bill_discount_amount = difference and mark it as auto-detected
    so the UI can flag it for human review.

    We do NOT apply this when computed < invoice total — that would mean the
    invoice total is higher than our numbers, which signals a different problem
    (missing line item, wrong rate) rather than a discount.
    """
    if inv.get("bill_discount_amount", 0) != 0:
        return inv  # already has a discount, don't override

    actual_total = inv.get("total", 0)
    if actual_total <= 0:
        return inv  # no printed total to compare against

    computed_subtotal = sum(
        item.get("qty", 0) * item.get("rate", 0) * (1 - item.get("disc_percent", 0) / 100)
        for item in inv.get("line_items", [])
    )
    tax = inv.get("cgst", 0) + inv.get("sgst", 0) + inv.get("igst", 0)
    expected = computed_subtotal + tax + inv.get("round_off", 0)
    diff = round(expected - actual_total, 2)

    if diff > 1:
        inv["bill_discount_amount"] = diff
        inv["bill_discount_percent"] = None
        inv["bill_discount_auto_detected"] = True  # flag for UI transparency

    return inv


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
    bill_discount = inv.get("bill_discount_amount", 0)
    tax = inv.get("cgst", 0) + inv.get("sgst", 0) + inv.get("igst", 0)
    expected_total = computed - bill_discount + tax + inv.get("round_off", 0)
    actual_total = inv.get("total", 0)
    if actual_total > 0 and abs(expected_total - actual_total) > 1:
        score -= 0.15
    return max(0.0, min(1.0, score))


MAX_PAGES = 8       # max pages sent per Claude call
DPI = 120           # DPI for scanned pages — higher than text PDFs for legibility
JPEG_QUALITY = 75   # JPEG compression — keeps each page under ~200 KB

# A page with fewer than this many characters is treated as a scan
TEXT_CHARS_THRESHOLD = 50


def _is_scanned_page(page) -> bool:
    """Return True if this PDF page is a scan (image-only, no extractable text)."""
    text = page.get_text("text").strip()
    return len(text) < TEXT_CHARS_THRESHOLD


def _pdf_native_text(file_bytes: bytes) -> list[dict]:
    """
    Extract text from a native (text-based) PDF page by page.
    Sends all page text in a single text block — fast and accurate.
    """
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages_text = []
    for i, page in enumerate(list(doc)[:MAX_PAGES]):
        text = page.get_text("text").strip()
        if text:
            pages_text.append(f"--- Page {i + 1} ---\n{text}")
    doc.close()

    combined = "\n\n".join(pages_text) if pages_text else "(no text extracted)"
    return [{"type": "text", "text": f"Invoice document text:\n\n{combined}"}]


def _pdf_scanned_images(file_bytes: bytes) -> list[dict]:
    """
    Render scanned PDF pages as JPEG images for Claude vision.
    """
    import fitz
    from PIL import Image

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    content_parts = []

    for page in list(doc)[:MAX_PAGES]:
        mat = fitz.Matrix(DPI / 72, DPI / 72)
        pix = page.get_pixmap(matrix=mat)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        b64 = base64.standard_b64encode(buf.getvalue()).decode()
        content_parts.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
        })

    doc.close()
    return content_parts


def _pdf_to_content(file_bytes: bytes) -> list[dict]:
    """
    Auto-detect PDF type and choose the right extraction method.
    - Native PDF (has selectable text) → extract text directly
    - Scanned PDF (image pages) → render as JPEG images for vision
    Mixed PDFs (some text, some scanned) are treated as scanned.
    """
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = list(doc)[:MAX_PAGES]
    scanned_pages = sum(1 for p in pages if _is_scanned_page(p))
    doc.close()

    is_scanned = scanned_pages > len(pages) / 2  # majority scanned → treat as scan

    logger.info(
        "PDF type detected: %s (%d/%d pages scanned)",
        "scanned" if is_scanned else "native",
        scanned_pages,
        len(pages),
    )

    if is_scanned:
        return _pdf_scanned_images(file_bytes)
    else:
        return _pdf_native_text(file_bytes)


def _image_to_content(file_bytes: bytes, media_type: str) -> list[dict]:
    """Convert image bytes to Claude content part, compressing if needed."""
    from PIL import Image

    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    # Resize if wider than 1600px (keeps it readable but small)
    if img.width > 1600:
        ratio = 1600 / img.width
        img = img.resize((1600, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    b64 = base64.standard_b64encode(buf.getvalue()).decode()
    return [{
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
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
        return _pdf_to_content(file_bytes)
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

    # Normalise HSN codes, correct rates, detect missed discounts, then score
    for inv in invoices:
        inv = normalize_hsn_codes(inv)
        inv = correct_line_item_rates(inv)
        inv = detect_bill_discount_from_total(inv)
        inv["confidence"] = compute_confidence(inv)

    return invoices, None


@router.post("/upload")
async def upload_invoices(
    files: list[UploadFile] = File(...),
    company_id: Optional[str] = Form(None),
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
