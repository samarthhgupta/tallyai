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
  "vendor_gstin": string or null,
  "vendor_address": string or null,
  "buyer_name": string or null,
  "buyer_gstin": string or null,
  "invoice_number": string,
  "invoice_date": string (YYYY-MM-DD),
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
  "charges": [
    {
      "description": string (e.g. "Postage", "Freight Charges", "Delivery Charges", "Packing Charges"),
      "amount": number,
      "gst_percent": number (usually 0; use 18 only if GST is explicitly shown on the charge)
    }
  ],
  "tax_type": "cgst_sgst" or "igst",
  "confidence": number between 0 and 1
}

CHARGES RULE:
Some invoices include additional charges OUTSIDE the line items — postage, freight, delivery, packing, handling, courier charges. These appear as separate rows between the line items and the GST/total section.
- Extract each such charge into the "charges" array with its description and amount.
- If the charge row is blank or zero, do NOT include it in the array.
- GST is rarely applied to these charges in Indian invoices. Only set gst_percent > 0 if GST is explicitly printed next to that charge.
- These charges are NOT line items and must NOT appear in the line_items array.
- They ARE included in the invoice total: Total = Taxable + GST + Charges + Round-off.

Return ONLY a JSON array [...] of invoice objects. No markdown, no explanation.

CRITICAL RATE RULE — read this carefully:
- "rate" must ALWAYS be the rate per unit BEFORE any discount, EXCLUDING GST.
- "disc_percent" is the EFFECTIVE combined discount percentage (see compound discount rule below).
- "amount" is the line total AFTER discount, BEFORE GST — this is usually the last column before GST (labelled "Net Amt", "Taxable", "Net Amount", or similar).

The correct relationship is: amount = qty × rate × (1 - disc_percent/100)

Many Indian invoices show columns like: Rate | Discount% | Amount
In this case "Rate" is already the pre-discount rate — use it directly.

Some invoices show a discounted rate in the Rate column. To detect this:
  If the invoice shows an Amount/Net Amt column, back-calculate the pre-discount rate:
  rate = amount / (qty × (1 - disc_percent/100))

COMPOUND DISCOUNT RULE — very common in Indian stationery/book invoices:

FORM 1 — Single cell with two percentages, e.g. "40+10.71" or "30+5":
  This means: first apply 40%, then apply 10.71% on the remainder.
  Convert to a single effective percentage:
    effective_disc = 1 - (1 - A/100) × (1 - B/100)
    disc_percent = effective_disc × 100

FORM 2 — Two SEPARATE discount columns, e.g. "Disc1%" and "Disc2%" (or "Trade Disc%" and "Cash Disc%"):
  These are also chained discounts applied sequentially. Combine them the same way:
    effective_disc = 1 - (1 - Disc1/100) × (1 - Disc2/100)
    disc_percent = effective_disc × 100
  IMPORTANT: If Disc2% = 0, the effective discount is just Disc1%.
  Do NOT add them (45 + 45 ≠ 90% — this is wrong). Always compound them.

EXAMPLE (Bharat Book Depot style — compound single-cell discount):
  Printed columns: Rate=40, Amount=1,32,000, Disc%=40+10.71, Net Amt=70,717.68, GST%=12
  - "Amount" here is qty×rate = 3300×40 = 1,32,000 (PRE-discount — ignore for our amount field)
  - "Net Amt" = 70,717.68 is the post-discount taxable amount — THIS goes in "amount"
  - effective_disc = 1 - (1-0.40)×(1-0.1071) = 1 - 0.60×0.8929 = 46.43%
  So: rate=40, disc_percent=46.43, amount=70717.68
  Verify: 3300 × 40 × (1 - 46.43/100) ≈ 70,717.68 ✓

EXAMPLE (J.B. Book Agency style — two separate discount columns):
  Printed columns: Rate=399, Amount=2,793, Disc1%=45, Disc2%=0, Net Amount=1,536.15, GST%=0
  - "Amount" = 7×399 = 2,793 is PRE-discount gross — ignore for our amount field
  - "Net Amount" = 1,536.15 is post-discount taxable — THIS goes in "amount"
  - effective_disc = 1 - (1-0.45)×(1-0) = 45%
  So: rate=399, disc_percent=45, amount=1536.15
  Verify: 7 × 399 × (1 - 45/100) = 2,793 × 0.55 = 1,536.15 ✓

EXAMPLE (Dream Touch style — single discount, post-discount rate in Rate column):
  Printed columns: Rate=331.10, Disc=14%, Qty=30, Amount=9933
  331.10 is the POST-discount rate. Back-calculate:
  rate = 9933 / (30 × (1 - 14/100)) = 9933 / 25.8 = 385.00
  disc_percent = 14, amount = 9933

EXAMPLE (standard invoice — no discount):
  Printed columns: Rate=1000, Disc=0%, Qty=5, Amount=5000
  rate = 1000, disc_percent = 0, amount = 5000

Always exclude GST from rate. If invoice shows GST-inclusive rate, divide by (1 + gst_percent/100).

COLUMN IDENTIFICATION RULE — when an invoice has both "Amount" and "Net Amt" columns:
  - "Amount" / "Gross Amount" = qty × rate (pre-discount gross) — DO NOT use this as the "amount" field
  - "Net Amt" / "Net Amount" / "Taxable" / "Value" = after ALL discounts, before GST — USE THIS as the "amount" field
  - When in doubt: the "amount" field must satisfy  qty × rate × (1 - disc_percent/100) ≈ amount.
    Cross-check using the printed Net Amount column — they must agree.

BUYER FIELDS:
- "buyer_name": the name of the company the invoice is addressed TO (appears under "Bill To", "Consignee", "Buyer", "Ship To"). This is NOT the vendor/seller.
- "buyer_gstin": the GSTIN of the buyer/recipient, usually printed next to the buyer's name or address.
- If the invoice does not show buyer details, set both to null.

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

COMPLETENESS CHECK — do this after extracting all invoices, before returning:
  1. Count the number of distinct invoice numbers / bill numbers you found in the document.
  2. Scan the ENTIRE document again from top to bottom — look for ANY of these invoice boundary markers you may have missed:
     - A new vendor name / company letterhead
     - A new "Invoice No." / "Bill No." / "Tax Invoice" / "Bill of Supply" header
     - A new "Bill To" / "Buyer" section
     - A separator line, page break, or clear visual boundary between invoices
     - A different paper colour or layout style (e.g. a yellow/coloured invoice among white ones)
     - A new barcode or QR code header
  3. For EACH distinct invoice boundary found, verify you have a corresponding JSON object in your output.
  4. If any invoice was missed, extract it now and add it to the array.
  5. Only return the final JSON array after this completeness check passes.

When NO bill-level discount is present:
  - Set "bill_discount_amount": 0
  - Set "bill_discount_percent": null

MULTI-PAGE INVOICE RULE:
A single invoice often spans two or more pages. This is common for scanned invoices. Recognise a multi-page invoice by:

EXPLICIT markers (easy to detect):
  - "Page 1 of 2" / "Page 2 of 2" printed at the bottom
  - "Continued..." or "Contd..." at the bottom of page 1
  - "...Continued" or a page number at the top of page 2
  - The same invoice number appearing on consecutive pages

IMPLICIT markers (no explicit label — use these signals):
  - A page ends abruptly with only line items and NO totals section, no GST row, no Grand Total, no "Amount in Words" — this page is incomplete
  - When a page is incomplete, look at the LAST serial number (S.No.) of the line items on that page
  - Then check the NEXT page: if the FIRST serial number on the next page continues the sequence (e.g. page 1 ends at S.No. 7, page 2 starts at S.No. 8), they belong to the same invoice
  - Even if the next page has a different layout or no header, treat it as a continuation
  - The totals, GST, and Grand Total on the continuation page belong to the combined invoice

When you see multiple pages that belong to the same invoice:
  - Combine ALL line items from ALL pages into ONE invoice object
  - The GST amounts, totals, and round-off are usually on the LAST page — use those
  - Use the invoice number, date, vendor, and buyer details from whichever page shows them
  - Do NOT return a separate JSON object for each page — one invoice = one JSON object
  - If page 2 has no invoice number but clearly continues page 1 (same vendor, same format, or continuing serial numbers), treat it as the same invoice

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

    amount field should be post-discount, pre-GST (Net Amt column).
    Back-calculates the true pre-discount, ex-GST rate:
        rate = amount / (qty * (1 - disc_percent/100))

    Also sanitises compound discounts if Claude returned them as a string
    like "40+10.71" instead of converting to effective %.
    """
    for item in inv.get("line_items", []):
        # Sanitise disc_percent — handle "40+10.71" strings from Claude
        # Also handles cases where Claude summed two discount columns (e.g. 45+0=45 or 45+45=90 — wrong)
        disc = item.get("disc_percent", 0)
        if isinstance(disc, str) and "+" in disc:
            parts = disc.split("+")
            try:
                effective = 1.0
                for p in parts:
                    effective *= (1 - float(p.strip()) / 100)
                disc = round((1 - effective) * 100, 4)
                item["disc_percent"] = disc
            except ValueError:
                disc = 0
                item["disc_percent"] = 0
        elif isinstance(disc, (int, float)):
            disc = float(disc)

        amount = item.get("amount")
        qty = item.get("qty", 0)

        if amount and qty and qty > 0:
            divisor = qty * (1 - disc / 100)
            if divisor > 0:
                correct_rate = round(amount / divisor, 2)
                current_rate = item.get("rate", 0)
                # Only override if it meaningfully differs (>1% difference)
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


# Minimum meaningful text characters across the whole document
TEXT_MIN_CHARS = 80
# Pixel brightness threshold — 0=black, 255=white; pages above this are "blank"
BLANK_BRIGHTNESS = 252
# Fraction of pixels that must exceed BLANK_BRIGHTNESS for a page to be considered blank
BLANK_PIXEL_FRACTION = 0.97


def _is_blank_image(img) -> bool:
    """Return True if the PIL image is overwhelmingly white (blank page)."""
    import struct
    pixels = list(img.convert("L").getdata())  # greyscale
    white = sum(1 for p in pixels if p >= BLANK_BRIGHTNESS)
    return white / len(pixels) >= BLANK_PIXEL_FRACTION if pixels else True


class BlankDocumentError(Exception):
    """Raised when a document has no meaningful content worth sending to Claude."""
    pass


def _prescreen_pdf(file_bytes: bytes) -> None:
    """Raise BlankDocumentError if the PDF is blank or has no usable content."""
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = list(doc)[:MAX_PAGES]

    if not pages:
        doc.close()
        raise BlankDocumentError("PDF has no pages.")

    total_text = ""
    all_blank_images = True

    for page in pages:
        total_text += page.get_text("text").strip()
        if _is_scanned_page(page):
            # Render and check brightness
            from PIL import Image
            mat = fitz.Matrix(72 / 72, 72 / 72)  # 72 DPI is enough for blank detection
            pix = page.get_pixmap(matrix=mat)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            if not _is_blank_image(img):
                all_blank_images = False
        else:
            all_blank_images = False  # native text page — not an image blank

    doc.close()

    is_native = len(total_text) >= TEXT_CHARS_THRESHOLD
    if is_native and len(total_text) < TEXT_MIN_CHARS:
        raise BlankDocumentError(f"PDF text content too short ({len(total_text)} chars) — likely blank or corrupt.")
    if not is_native and all_blank_images:
        raise BlankDocumentError("All scanned pages appear to be blank (white).")


def _prescreen_image(file_bytes: bytes) -> None:
    """Raise BlankDocumentError if the image is blank."""
    from PIL import Image

    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    if _is_blank_image(img):
        raise BlankDocumentError("Image appears to be blank (white page).")


def _prescreen_text(text: str) -> None:
    """Raise BlankDocumentError if a text document has no meaningful content."""
    if len(text.strip()) < TEXT_MIN_CHARS:
        raise BlankDocumentError(f"Document has no meaningful text content ({len(text.strip())} chars).")



async def _build_content_parts(upload: UploadFile) -> list[dict]:
    """
    Read an UploadFile, run a blank/content pre-screen, and return Claude content parts.
    Raises BlankDocumentError before touching Claude if the file has no useful content.
    """
    file_bytes = await upload.read()
    filename = (upload.filename or "").lower()
    content_type = (upload.content_type or "").lower()

    if filename.endswith(".pdf") or "pdf" in content_type:
        _prescreen_pdf(file_bytes)
        return _pdf_to_content(file_bytes)
    elif filename.endswith(".png") or "png" in content_type:
        _prescreen_image(file_bytes)
        return _image_to_content(file_bytes, "image/png")
    elif filename.endswith((".jpg", ".jpeg")) or "jpeg" in content_type:
        _prescreen_image(file_bytes)
        return _image_to_content(file_bytes, "image/jpeg")
    elif filename.endswith(".docx"):
        parts = _docx_to_text(file_bytes)
        _prescreen_text(parts[0]["text"])
        return parts
    elif filename.endswith(".doc"):
        parts = _doc_to_text(file_bytes)
        _prescreen_text(parts[0]["text"])
        return parts
    else:
        try:
            text = file_bytes.decode("utf-8", errors="ignore")
        except Exception:
            text = ""
        _prescreen_text(text)
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
    except BlankDocumentError as exc:
        logger.info("Pre-screen rejected %s: %s", upload.filename, exc)
        return [], f"Skipped (no invoice content): {exc}"
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
        # Claude sometimes wraps output in markdown fences or adds commentary.
        # Most robust recovery: find the outermost JSON array by locating the
        # first '[' and the last ']' in the response and parsing that slice.
        start = raw_text.find("[")
        end = raw_text.rfind("]")
        if start != -1 and end != -1 and end > start:
            try:
                invoices = json.loads(raw_text[start : end + 1])
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


def _merge_cross_file_invoices(file_results: list[dict]) -> list[dict]:
    """
    Two cases for invoices sharing the same invoice number across files:

    1. Multi-page split (one or both pages incomplete) → MERGE into one invoice.
       A page is "incomplete" if total == 0 or line_items is empty.

    2. True duplicate (both are complete invoices) → FLAG as duplicate.
       Do not merge; mark the later occurrence with duplicate_of_filename so
       the UI can prompt the human to reject it.
    """
    from collections import defaultdict

    index: dict = defaultdict(list)
    for fi, fr in enumerate(file_results):
        for ii, inv in enumerate(fr["invoices"]):
            num = (inv.get("invoice_number") or "").strip().upper()
            if num:
                index[num].append((fi, ii, inv))

    merged_keys: set = set()

    for num, entries in index.items():
        if len(entries) < 2:
            continue

        entries.sort(key=lambda x: x[0])
        base_fi, base_ii, base = entries[0]

        for fi, ii, page in entries[1:]:
            base_complete = base.get("total", 0) > 0 and len(base.get("line_items", [])) > 0
            page_complete = page.get("total", 0) > 0 and len(page.get("line_items", [])) > 0

            if base_complete and page_complete:
                # Both are complete → true duplicate
                page["duplicate_of"] = base.get("invoice_number", "")
                page["duplicate_of_filename"] = file_results[base_fi]["filename"]
            else:
                # At least one is incomplete → multi-page split, merge them
                base["line_items"] = base.get("line_items", []) + page.get("line_items", [])

                for field in ("vendor_name", "vendor_gstin", "vendor_address",
                              "buyer_name", "buyer_gstin", "invoice_date", "tax_type"):
                    if not base.get(field) and page.get(field):
                        base[field] = page[field]

                if base.get("total", 0) == 0 and page.get("total", 0) > 0:
                    for f in ("subtotal", "bill_discount_amount", "bill_discount_percent",
                              "cgst", "sgst", "igst", "round_off", "total"):
                        if page.get(f) is not None:
                            base[f] = page[f]

                base["_merged_from_pages"] = True
                merged_keys.add((fi, ii))

        # Re-run post-processing on merged invoice only
        if not base.get("duplicate_of"):
            base = normalize_hsn_codes(base)
        base = correct_line_item_rates(base)
        base = detect_bill_discount_from_total(base)
        base["confidence"] = compute_confidence(base)
        file_results[base_fi]["invoices"][base_ii] = base

    # Remove entries that were merged into another invoice
    for fi, fr in enumerate(file_results):
        fr["invoices"] = [
            inv for ii, inv in enumerate(fr["invoices"])
            if (fi, ii) not in merged_keys
        ]

    return file_results


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

    for upload in files:
        invoices, error = await _extract_invoices_from_file(upload, client)
        file_results.append({
            "filename": upload.filename or "unknown",
            "invoices": invoices,
            "error": error,
        })

    # Merge invoices with the same invoice number across different files
    # (handles the case where a multi-page invoice was scanned as separate image files)
    file_results = _merge_cross_file_invoices(file_results)

    total_invoices = sum(len(fr["invoices"]) for fr in file_results)

    return {
        "batch_id": batch_id,
        "file_results": file_results,
        "total_invoices": total_invoices,
    }
