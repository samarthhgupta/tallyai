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
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

import time

import anthropic
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from lib.prompt_loader import get_system_prompt
from lib.extraction_logger import log_extraction


def _d(value) -> Decimal:
    """Convert any numeric value to Decimal safely via string to avoid fp noise."""
    return Decimal(str(value)) if value is not None else Decimal("0")


def _round2(value) -> float:
    """Round a Decimal to 2 decimal places using ROUND_HALF_UP, return float."""
    return float(_d(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _line_amount(qty, rate, disc_percent) -> Decimal:
    """Exact decimal calculation: qty × rate × (1 - disc/100)."""
    q = _d(qty)
    r = _d(rate)
    d = _d(disc_percent)
    return q * r * (1 - d / Decimal("100"))

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
      "description": string (product or service name exactly as printed in the line items table),
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
      "gst_percent": number (0 if non-taxable; otherwise use the rate determined by the GST Classification & Mismatch Resolution rule below)
    }
  ],
  "is_computer_generated": boolean (true if the invoice is clearly printed/computer-generated with consistent fonts and layout; false if handwritten or unclear),
  "is_gst_inclusive_amounts": boolean (true if the Amount column on the invoice is GST-inclusive; false if GST-exclusive — determined by your detection step above),
  "tax_type": "cgst_sgst" or "igst",
  "confidence": number between 0 and 1
}

CHARGES RULE:
Some invoices include additional charges such as postage, freight, freight & forwarding, delivery, builty, packing, handling, courier charges. Where these appear determines how to extract them:

CASE 1 — Charge appears AMONG the line items WITH an HSN/SAC code:
  Treat it exactly like a regular line item. Put it in "line_items", not in "charges".
  It WILL appear in the HSN Summary. GST applies per the rate column.
  Example: "Builty Charges  HSN:9965  Qty:1  Rate:50  GST:0%" → goes in line_items.
  Example: "Freight & Forwarding  HSN:9965  Qty:1  Rate:200  GST:18%" → goes in line_items.

CASE 2 — Charge appears AFTER the line items subtotal WITHOUT an HSN code AND no GST shown on it:
  Initially put it in the "charges" array with gst_percent=0.
  Then run the MISMATCH RESOLUTION ENGINE below — GST may still apply.
  Example: "Freight & Forwarding: ₹995" with no GST shown → charges[], gst_percent=0 initially.

CASE 3 — Charge appears AFTER the line items subtotal WITH an HSN code:
  Even though it is after the subtotal, the HSN code means it must go in "line_items".
  Apply GST as shown. It WILL appear in the HSN Summary.

  - If the charge row is blank or zero, do NOT include it anywhere.

ADDITIONAL CHARGES — GST CLASSIFICATION:

FREIGHT-RELATED charges (SAC 9965, default GST 5%):
  Freight, Freight Charges, Freight & Forwarding, F&F Charges, Transport Charges,
  Transportation Charges, Delivery Charges, Builty Charges, LR Charges,
  Lorry Charges, Cartage Charges.

POSTAL/COURIER charges (SAC 9968, default GST 18%):
  Postage, Postal Charges, Courier Charges, Courier Service,
  Dispatch Charges, Shipping Charges, Shipping Service.

GST RATE PRIORITY ORDER (invoice evidence always overrides defaults):
  Priority 1: Explicit GST rate printed against the charge on the invoice → use that rate.
  Priority 2: The charge's SAC appears in the invoice's HSN/SAC summary → use that rate.
  Priority 3: The charge appears in the invoice's GST/Tax summary → use that rate.
  Priority 4: Apply default classification rate (5% for freight-related, 18% for postal/courier).

SPECIAL CASE — freight embedded in product value:
  If no separate freight line exists and the product taxable value already includes freight,
  do NOT create a separate charge. GST follows the product GST rate, not the freight rate.

SPECIAL CASE — reimbursement/non-taxable charge:
  If a charge is shown but no GST is charged on it AND it is absent from the tax summary,
  treat it as non-taxable: gst_percent=0. Do not automatically apply GST.

MISMATCH RESOLUTION ENGINE — run this whenever computed total ≠ invoice grand total:

CRITICAL PRINCIPLE: A mismatch does not automatically mean an extraction error.
Before flagging anything for review, first test whether GST on additional charges
explains the gap. This is the most common cause of mismatches on Indian invoices.

VALIDATION HIERARCHY — investigate mismatches in this order:
  Step 1: Re-check line-item arithmetic (qty × rate × (1−disc%)).
  Step 2: Re-check discount calculations (line-level vs bill-level, no double-discount).
  Step 3: Re-check GST treatment on goods (rate%, tax type CGST+SGST vs IGST).
  Step 4: Test whether freight-related charges are taxable under SAC 9965 @ 5%.
  Step 5: Test whether courier/postage charges are taxable under SAC 9968 @ 18%.
  Step 6: Test other rates (12%, 18%) if steps 4–5 don't resolve it.
  Step 7: If reconciliation succeeds at any step → classify charge as taxable (see below).
  Step 8: If no test resolves the mismatch → keep charges as non-taxable, flag for review.

HOW TO TEST:
  For each charge in charges[]:
    gap = invoice_grand_total − current_computed_total
    potential_gst = charge.amount × applicable_gst_rate   (use priority order above)
    if |potential_gst − gap| ≤ ₹2:
      → GST IS charged on this additional charge. Proceed to extraction below.

  Also test combined charges if two or more charges together explain the gap.

EXTRACTION AFTER SUCCESSFUL RECONCILIATION:
  When applying GST to a charge resolves the mismatch:
    → Update charges[].gst_percent to the applicable rate.
    → The charge stays in charges[] with its description and amount unchanged.
    → DO NOT move the charge from charges[] to line_items[].
  The frontend automatically includes charges with gst_percent > 0 in the HSN Summary.
  Assign high confidence when this reconciliation fully closes the gap.

  CRITICAL — why charges must NOT move to line_items[]:
    If the invoice also has a bill-level discount, moving a charge to line_items[]
    causes the discount to be pro-rated to the charge, which is always wrong
    (discounts apply to goods, not to freight or postage).

EXAMPLE — Laxmi Agency invoice L-1154 (the canonical example — memorise this):
  Invoice layout:
    Line items table: S.No.1 | LOTUS TOWEL | HSN 63026090 | Qty 120 | Price 180 | Amount 21,600
    No Discount% column in the line items table.
    Below the goods lines:
      Less: Discount           @ 6.00%   = 1,296.00
      Add:  Freight & Forwarding Charges = 995.00
      Add:  SGST                @ 2.50%  = 532.48
      Add:  CGST                @ 2.50%  = 532.48
      Add:  Rounded Off (+)              = 0.04
      Grand Total 120 Pcs.               ₹22,364.00
    Tax summary: Taxable = 21,299.00 | CGST = 532.48 | SGST = 532.48

  CORRECT extraction:
    line_items: [{hsn:"63026090", gst_percent:5, qty:120, rate:180, disc_percent:0, amount:21600}]
    bill_discount_percent: 6
    bill_discount_amount: 1296   (= 21,600 × 6%)
    charges: [{description:"Freight & Forwarding Charges", amount:995, gst_percent:5}]
    Verify: subtotal=21,600 | discount=1,296 | taxable goods=20,304 | freight=995
            total taxable=20,304+995=21,299 | CGST=21,299×2.5%=532.475≈532.48 ✓
            total=21,299+532.48+532.48+0.04=22,364.00 ✓

  WRONG extraction (what you must NEVER do):
    line_items[0].disc_percent = 6   ← discount applied at LINE level
    bill_discount_amount = 1296      ← same discount applied AGAIN at bill level
    → taxable = (21,600×0.94) − 1,296 = 19,008 (WRONG, double-discounted)

  The discount "@ 6.00% = 1,296" appears BELOW the goods lines = bill-level.
  The 6% is calculated on goods only (21,600), not on freight.
  disc_percent on ALL line items must be 0. Never set it to 6.

EXAMPLE — Freight at explicit 12%:
  Freight Charges = ₹1,000, invoice shows "@ 12%" against it.
  Use 12% (Priority 1 overrides the 5% default).
  → Update charges[].gst_percent = 12. Keep in charges[].

EXAMPLE — Postage with GST:
  Line items taxable = ₹5,000 | GST 12% = ₹600 | Postage = ₹500
  Computed total = ₹6,100 | Invoice grand total = ₹6,190
  Gap = ₹90 → Test: ₹500 × 18% = ₹90 ✓
  → Update charges[Postage].gst_percent = 18. Keep in charges[].

EXAMPLE — Non-taxable freight (reimbursement):
  Freight shown as ₹200. No GST row for 9965. Tax summary matches without freight GST.
  → Keep in charges[], gst_percent=0. No change needed.

LINE ITEM COMPLETENESS — extract exactly what is in the table, no more, no less:
  1. Count the serial numbers (S.No.) in the invoice's line items table. If S.No. runs 1 to N, you must have EXACTLY N line items — not N-1 (skip), not N+1 (hallucinate).
  2. ONLY extract rows that have an explicit S.No. in the line items table. Do NOT extract:
     - Subtotal rows, total rows, tax rows, round-off rows
     - Charges mentioned in the footer or below the subtotal (those go in "charges")
     - Anything from the invoice header, address block, or summary section
     - Numbers that appear elsewhere on the invoice but not in the line items table
  3. If you are uncertain whether a row is a line item or a summary row, check: does it have a serial number? If not, it is NOT a line item.

Return ONLY a JSON array [...] of invoice objects. No markdown, no explanation.

COMPUTER-GENERATED INVOICE RULE:
If an invoice is clearly computer-generated (consistent fonts, printed layout, machine-calculated totals), set "is_computer_generated": true.
- All values on a computer-generated invoice are mathematically exact — trust them completely.
- Extract the Rate column value EXACTLY as printed — do NOT recalculate or estimate.
- Extract the Amount column value EXACTLY as printed — do NOT recalculate.
- Do NOT look for hidden discounts or assume any mismatch is an error.
- The printed total IS the correct total. Extract it exactly as shown.

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

EXAMPLE (MRP + Disc% + Rate/Price column invoice):
  Some invoices show: MRP | Disc% | Rate/Price | Qty | Amount
  In this case the "Rate" or "Price" column is ALREADY the post-discount price (MRP × (1 - Disc%)).
  To find the true pre-discount rate (what goes in our "rate" field), use the Amount column:
    Our rate = Amount / (Qty × (1 - Disc%/100))   → this gives back the MRP
  Cross-check: MRP × (1 - Disc%) should ≈ the printed Rate/Price column.
  Example: MRP=500, Disc%=20, Rate(printed)=400, Qty=3, Amount=1200
    Our rate = 1200 / (3 × 0.80) = 500 = MRP ✓   disc_percent=20, amount=1200

EXAMPLE (Dream Touch style — single discount, post-discount rate in Rate column):
  Printed columns: Rate=331.10, Disc=14%, Qty=30, Amount=9933
  331.10 is the POST-discount rate. Back-calculate:
  rate = 9933 / (30 × (1 - 14/100)) = 9933 / 25.8 = 385.00
  disc_percent = 14, amount = 9933

EXAMPLE (standard invoice — no discount):
  Printed columns: Rate=1000, Disc=0%, Qty=5, Amount=5000
  rate = 1000, disc_percent = 0, amount = 5000

Always exclude GST from rate. If invoice shows GST-inclusive rate, divide by (1 + gst_percent/100).

GST-INCLUSIVE AMOUNT COLUMN DETECTION — do this FIRST before extracting any line item:

Many Indian invoices print the Amount column as GST-inclusive (taxable value + GST together).
You MUST detect which type the invoice has before extracting "amount" for each line item.

STEP 1 — Check using the GST summary table (most reliable):
  If the invoice has a GST/Tax summary at the bottom showing Taxable Value, CGST, SGST, IGST:
  - Add up all printed line item amounts → call this SumAmounts
  - Compare SumAmounts with the Taxable Value from the GST summary:
      If SumAmounts ≈ Taxable Value (within ₹2) → Amount column is GST-EXCLUSIVE → use amounts directly
      If SumAmounts ≈ Taxable Value + Total Tax (within ₹2) → Amount column is GST-INCLUSIVE → convert each amount

STEP 2 — Check using invoice reconciliation (if no GST summary):
  - GST-exclusive: SumAmounts + GST + Charges + Round-off ≈ Grand Total
  - GST-inclusive: SumAmounts + Charges + Round-off ≈ Grand Total (GST already inside amounts)
  Test both. Choose whichever reconciles with the Grand Total.

STEP 3 — Column label hints:
  Labels suggesting GST-EXCLUSIVE: "Net Amt", "Net Amount", "Taxable Amt", "Taxable Value", "Amount After Disc"
  Labels suggesting GST-INCLUSIVE: "Amount (₹)", "Total Amt", "Invoice Amt", "Gross Amt", or no qualifier

WHEN AMOUNT COLUMN IS GST-INCLUSIVE — full back-calculation and verification procedure:

The "amount" field we store must ALWAYS be taxable (GST-exclusive, post-discount). Convert:
  stored_amount = printed_amount ÷ (1 + gst_percent/100)
Then back-calculate the pre-discount ex-GST rate:
  rate = stored_amount ÷ qty ÷ (1 − disc_percent/100)

After extracting all line items, run ALL SIX checks below. If any check fails, re-examine
the failing line item before finalising the JSON.

CHECK 1 — Confirm GST-inclusive detection using the GST summary (by HSN group):
  For each HSN group: sum the stored_amounts (ex-GST) and compare to the printed taxable in
  the GST summary. They must agree within ₹2.
  If they do not agree, re-examine your GST-inclusive/exclusive decision for that HSN group.

CHECK 2 — Verify the Price column for every line item:
  After stripping GST: stored_amount ÷ qty must equal the "Price" column printed on the invoice.
  Formula: printed_amount ÷ (1 + gst%) ÷ qty = printed_Price
  If any line does not match, the Qty or GST% was likely read incorrectly.

CHECK 3 — Forward round-trip for every line item:
  Starting from your extracted rate, work forward and reproduce the printed Amount:
  rate × (1 − disc%) × qty × (1 + gst%) = printed_Amount   (within ₹1)
  If it does not match, the disc_percent or rate is wrong.

CHECK 4 — HSN-wise taxable subtotals vs GST summary:
  For each HSN code, sum the stored_amounts of all line items with that HSN.
  Compare to the taxable value in the invoice's GST/Tax summary table.
  They must agree within ₹2. A larger gap means a line item was missed or assigned the wrong HSN.

CHECK 5 — GST amount verification:
  For each HSN group: stored_taxable × gst_rate / 2 = CGST = SGST (for CGST+SGST invoices)
                  or: stored_taxable × gst_rate = IGST (for IGST invoices)
  Compare computed GST to what is printed in the GST summary. Must agree within ₹2.

CHECK 6 — Grand Total reconciliation:
  Sum all stored_amounts → Taxable Value
  Add all GST amounts (CGST + SGST or IGST)
  Add charges, round-off
  Result must equal the printed Grand Total within ₹2.
  Any remaining gap after checks 1–5 pass is usually one paisa of rounding — acceptable.
  A gap larger than ₹2 means something is wrong: re-examine line items, disc%, or charges.

EXAMPLE — Shri Ganesh Traders (invoice SGT/495/2024-25):
  Invoice columns: S.N. | Description | HSN | Qty | Unit | MRP | Discount% | Price | Amount(₹)
  "Price" = post-discount ex-GST rate per unit. "Amount" = GST-inclusive total.
  GST summary: HSN 63041910 @ 5% Taxable=1,25,180 | HSN 63023100 @ 12% Taxable=33,999.74
  Grand Total: ₹1,69,519.00. Round Off: +₹0.30.

  CHECK 1 (detect GST-inclusive):
    Lines 1–3 printed amounts: 42,000 + 65,310 + 24,129 = 1,31,439
    1,25,180 × 1.05 = 1,31,439 ✓ → GST-inclusive confirmed for 63041910
    Lines 4–6 printed amounts: 8,829.76 + 9,932.70 + 19,317.24 = 38,079.70
    38,079.70 ÷ 1.12 = 33,999.73 ≈ 33,999.74 ✓ → GST-inclusive confirmed for 63023100

  Line 1 (HSN 63041910, Qty=80, Disc=0%, GST=5%, Amount=42,000):
    stored_amount = 42,000 ÷ 1.05 = 40,000   rate = 40,000 ÷ 80 ÷ 1.00 = 500
  Line 2 (HSN 63041910, Qty=100, Disc=0%, GST=5%, Amount=65,310):
    stored_amount = 65,310 ÷ 1.05 = 62,200   rate = 62,200 ÷ 100 ÷ 1.00 = 622
  Line 3 (HSN 63041910, Qty=60, Disc=0%, GST=5%, Amount=24,129):
    stored_amount = 24,129 ÷ 1.05 = 22,980   rate = 22,980 ÷ 60 ÷ 1.00 = 383
  Line 4 (HSN 63023100, Qty=4, Disc=8%, GST=12%, Amount=8,829.76):
    stored_amount = 8,829.76 ÷ 1.12 = 7,883.71   rate = 7,883.71 ÷ 4 ÷ 0.92 = 2,142.31
  Line 5 (HSN 63023100, Qty=6, Disc=8%, GST=12%, Amount=9,932.70):
    stored_amount = 9,932.70 ÷ 1.12 = 8,868.48   rate = 8,868.48 ÷ 6 ÷ 0.92 = 1,606.61
  Line 6 (HSN 63023100, Qty=6, Disc=8%, GST=12%, Amount=19,317.24):
    stored_amount = 19,317.24 ÷ 1.12 = 17,247.54   rate = 17,247.54 ÷ 6 ÷ 0.92 = 3,124.55

  CHECK 2 (Price column cross-check):
    Line 1: 42,000÷1.05÷80=500 = printed Price 500 ✓
    Line 4: 8,829.76÷1.12÷4=1,970.93 = printed Price 1,970.93 ✓  (all 6 lines pass)

  CHECK 3 (forward round-trip):
    Line 4: 2,142.31×0.92×4×1.12 = 8,829.76 ✓  (all 6 lines pass)

  CHECK 4 (HSN taxable subtotals):
    63041910: 40,000+62,200+22,980 = 1,25,180 = GST summary 1,25,180 ✓
    63023100: 7,883.71+8,868.48+17,247.54 = 33,999.73 ≈ 33,999.74 ✓

  CHECK 5 (GST amounts):
    63041910: 1,25,180×2.5% = 3,129.50 CGST = 3,129.50 SGST ✓
    63023100: 33,999.73×6% = 2,039.98 CGST = 2,039.98 SGST ✓

  CHECK 6 (Grand Total):
    1,59,179.73 + 10,338.96 + 0.30 = 1,69,518.99 ≈ 1,69,519.00 ✓
    (₹0.01 gap = rounding of 33,999.73 vs 33,999.74 — acceptable)

  NOTE: In this invoice layout "Price" = post-discount ex-GST price per unit.
  "Amount" = qty × Price × (1+GST%). disc_percent is applied at line level.
  For discounted lines: rate = Price ÷ (1 − disc%)
  For non-discounted lines: rate = Price directly.

SET is_gst_inclusive_amounts: true in the invoice JSON when you detect GST-inclusive amounts,
so the backend knows not to re-apply its own conversion.

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

STEP 1 — LOCATE where the discount appears on the invoice:

  LOCATION A — Inside the line items table, in a "Disc%" or "Discount%" column:
    → This is a LINE-ITEM discount.
    → Set disc_percent on each affected line item.
    → Set bill_discount_amount = 0 and bill_discount_percent = null.

  LOCATION B — Below the line items subtotal, before the GST section:
    → This is a BILL-LEVEL discount.
    → Look for: "Discount", "Trade Discount", "Less", "Less Discount", "(-)",
      a "−" / "-" sign next to an amount, "Less 5%", "Discount 10%",
      a fixed rupee amount being subtracted, or (in handwritten invoices) just "Less ₹X".
    → Set bill_discount_amount to the rupee value.
    → Set bill_discount_percent to the % if stated as a percentage, else null.
    → Set disc_percent = 0 on ALL line items — the discount is NOT per line.
    → GST is calculated on (subtotal − bill_discount_amount), NOT on the full subtotal.
    → Invoice flow: Subtotal → minus Bill Discount → Taxable Value → plus GST → Total.

STEP 2 — CRITICAL ANTI-DOUBLE-DISCOUNT CHECK:
  A discount must be applied EXACTLY ONCE across the whole extraction.
  NEVER apply the same discount at both line-item level AND bill level.

  Before finalising, verify:
    computed_taxable = sum(qty × rate × (1 − disc_percent/100)) − bill_discount_amount
  This must match the Taxable Value printed on the invoice (within ₹2).
  If it does not match, you have double-discounted. Fix it by choosing only one location:
    - If the discount column is inside the line items table → line-item level only, bill_discount=0.
    - If the discount row is below the subtotal → bill level only, all disc_percent=0.

EXAMPLE of double-discounting to AVOID (Laxmi Agency invoice L-1154):
  Invoice shows: line items table has NO Discount% column.
  "Less: Discount @ 6.00% = 1,296" appears as a row BELOW the goods lines.
  WRONG extraction:
    line_items[0].disc_percent = 6   ← discount applied at line level (WRONG — no disc column in table)
    bill_discount_percent = 6        ← same discount applied again at bill level
    computed_taxable = (120×180×0.94) − 1,296 = 20,304 − 1,296 = 19,008  ← WRONG
  CORRECT extraction:
    line_items[0].disc_percent = 0   ← no Discount% column in line items table → must be 0
    bill_discount_percent = 6        ← discount is BELOW subtotal → bill level only
    bill_discount_amount = 1,296     ← 21,600 × 6% = 1,296
    computed_taxable = 21,600 − 1,296 = 20,304  ← matches invoice ✓

  RULE: If the invoice's line items table has NO Discount% column, then disc_percent=0
  on every line item, always. The discount lives at bill level only.

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
- Do NOT include a "confidence_reasons" field — it is computed server-side.
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
        rate = amount / (qty × (1 - disc_percent/100))

    Uses Decimal arithmetic throughout to eliminate floating-point rounding
    errors (e.g. 2141.9999... incorrectly rounding to 2141 instead of 2142).

    Also sanitises compound discounts if Claude returned them as a string
    like "40+10.71" instead of converting to effective %.
    """
    for item in inv.get("line_items", []):
        # Sanitise disc_percent — handle "40+10.71" strings from Claude
        disc_raw = item.get("disc_percent", 0)
        if isinstance(disc_raw, str) and "+" in disc_raw:
            parts = disc_raw.split("+")
            try:
                effective = Decimal("1")
                for p in parts:
                    effective *= (1 - _d(p.strip()) / Decimal("100"))
                disc = _round2((1 - effective) * Decimal("100"))
                item["disc_percent"] = disc
            except Exception:
                disc = 0.0
                item["disc_percent"] = 0.0
        else:
            disc = float(disc_raw) if disc_raw else 0.0

        amount = item.get("amount")
        qty = item.get("qty", 0)
        gst_pct = item.get("gst_percent", 0)

        # Claude already converts GST-inclusive amounts to GST-exclusive per the
        # system prompt instructions. Do NOT re-divide here — that would double-convert.
        effective_amount = _d(amount) if amount else Decimal("0")

        if effective_amount and qty and qty > 0:
            divisor = _d(qty) * (1 - _d(disc) / Decimal("100"))
            if divisor > 0:
                raw = effective_amount / divisor
                # Round to 2 decimal places first
                rate_2dp = float(raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
                # If within ₹0.10 of a whole number, snap to that integer.
                # Indian invoice rates are whole rupees; the small gap (e.g. 2141.96
                # instead of 2142) is a back-calculation artifact from the invoice
                # software rounding the price column (1970.64 = 2142 × 0.92).
                nearest_int = round(rate_2dp)
                correct_rate = float(nearest_int) if abs(rate_2dp - nearest_int) < 0.10 else rate_2dp
                current_rate = item.get("rate", 0)
                pct_diff = abs(correct_rate - current_rate) / max(correct_rate, 0.01)
                abs_diff = abs(correct_rate - current_rate)
                # Override if >1% difference (wrong column extracted by Claude)
                # OR if the back-calc gives a clean whole-rupee rate and the extracted
                # rate is off by ≥₹0.50 — catches off-by-one errors like 2141 vs 2142
                # where the % gap is tiny but the rupee difference is real.
                is_whole = correct_rate == float(int(correct_rate))
                if current_rate == 0 or pct_diff > 0.01 or (is_whole and abs_diff >= 0.5):
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

    if inv.get("is_computer_generated"):
        return inv  # computer-generated invoices have correct calculations — trust them

    actual_total = inv.get("total", 0)
    if actual_total <= 0:
        return inv  # no printed total to compare against

    computed_subtotal = sum(
        _line_amount(item.get("qty", 0), item.get("rate", 0), item.get("disc_percent", 0))
        for item in inv.get("line_items", [])
    )
    tax = _d(inv.get("cgst", 0)) + _d(inv.get("sgst", 0)) + _d(inv.get("igst", 0))
    expected = computed_subtotal + tax + _d(inv.get("round_off", 0))
    diff = _round2(expected - _d(actual_total))

    if diff > 1:
        inv["bill_discount_amount"] = diff
        inv["bill_discount_percent"] = None
        inv["bill_discount_auto_detected"] = True  # flag for UI transparency

    return inv


def compute_confidence(inv: dict) -> float:
    score = inv.get("confidence", 0.5)
    reasons: list[str] = []

    if not inv.get("vendor_gstin"):
        score -= 0.05
        reasons.append("Missing vendor GSTIN")
    if not inv.get("invoice_number"):
        score -= 0.1
        reasons.append("Missing invoice number")
    if not inv.get("invoice_date"):
        score -= 0.1
        reasons.append("Missing invoice date")
    if not inv.get("line_items"):
        score -= 0.2
        reasons.append("No line items extracted")

    computed = sum(
        _line_amount(item.get("qty", 0), item.get("rate", 0), item.get("disc_percent", 0))
        for item in inv.get("line_items", [])
    )
    bill_discount = _d(inv.get("bill_discount_amount", 0))
    tax = _d(inv.get("cgst", 0)) + _d(inv.get("sgst", 0)) + _d(inv.get("igst", 0))
    charges = sum(_d(c.get("amount", 0)) for c in inv.get("charges", []))
    charges_gst = sum(
        _d(c.get("amount", 0)) * _d(c.get("gst_percent", 0)) / _d(100)
        for c in inv.get("charges", [])
        if c.get("gst_percent", 0)
    )
    expected_total = computed - bill_discount + tax + charges + charges_gst + _d(inv.get("round_off", 0))
    actual_total = _d(inv.get("total", 0))

    if actual_total > 0 and abs(expected_total - actual_total) > 1:
        diff = expected_total - actual_total
        direction = "over" if diff > 0 else "under"
        reasons.append(
            f"Computed total ₹{float(expected_total):,.2f} is ₹{float(abs(diff)):,.2f} {direction} invoice total ₹{float(actual_total):,.2f}"
        )
        score -= 0.15

    inv["confidence_reasons"] = reasons
    return max(0.0, min(1.0, score))


MAX_PAGES_PER_CHUNK = 8   # max image pages sent per Claude call (vision limit)
MAX_NATIVE_PAGES = 200    # cap for native-text PDFs (text is cheap in context)
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
    No page limit since text is cheap in the context window.
    """
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages_text = []
    for i, page in enumerate(list(doc)[:MAX_NATIVE_PAGES]):
        text = page.get_text("text").strip()
        if text:
            pages_text.append(f"--- Page {i + 1} ---\n{text}")
    doc.close()

    combined = "\n\n".join(pages_text) if pages_text else "(no text extracted)"
    return [{"type": "text", "text": f"Invoice document text:\n\n{combined}"}]


def _render_page_to_b64(page) -> str:
    """Render a single PDF page to a base64 JPEG string."""
    import fitz
    from PIL import Image

    mat = fitz.Matrix(DPI / 72, DPI / 72)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return base64.standard_b64encode(buf.getvalue()).decode()


def _pdf_scanned_images_chunked(file_bytes: bytes) -> list[list[dict]]:
    """
    Render scanned PDF pages as JPEG images, chunked into groups of MAX_PAGES_PER_CHUNK.
    Returns a list of content-part lists — one per chunk — to be sent in separate Claude calls.
    """
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = list(doc)
    chunks: list[list[dict]] = []

    for start in range(0, len(pages), MAX_PAGES_PER_CHUNK):
        chunk_pages = pages[start:start + MAX_PAGES_PER_CHUNK]
        content_parts = []
        for page in chunk_pages:
            b64 = _render_page_to_b64(page)
            content_parts.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
            })
        chunks.append(content_parts)

    doc.close()
    return chunks


def _pdf_to_content(file_bytes: bytes) -> list[dict]:
    """
    Auto-detect PDF type and choose the right extraction method.
    - Native PDF (has selectable text) → extract text directly (no page limit)
    - Scanned PDF (image pages) → first chunk only; chunked path handled separately
    Mixed PDFs (some text, some scanned) are treated as scanned.
    """
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = list(doc)[:MAX_PAGES_PER_CHUNK]
    scanned_pages = sum(1 for p in pages if _is_scanned_page(p))
    doc.close()

    is_scanned = scanned_pages > len(pages) / 2  # majority scanned → treat as scan

    logger.info(
        "PDF type detected: %s (%d/%d sample pages scanned)",
        "scanned" if is_scanned else "native",
        scanned_pages,
        len(pages),
    )

    if is_scanned:
        # Return first chunk only — caller must use _pdf_scanned_images_chunked for full doc
        chunks = _pdf_scanned_images_chunked(file_bytes)
        return chunks[0] if chunks else []
    else:
        return _pdf_native_text(file_bytes)


def _is_scanned_pdf(file_bytes: bytes) -> bool:
    """Return True if the majority of sample pages in the PDF are scanned (image-only)."""
    import fitz

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = list(doc)[:MAX_PAGES_PER_CHUNK]
    scanned = sum(1 for p in pages if _is_scanned_page(p))
    doc.close()
    return scanned > len(pages) / 2


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
    pages = list(doc)[:MAX_PAGES_PER_CHUNK]

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



def _parse_claude_json(raw_text: str) -> tuple[list[dict], Optional[str]]:
    """Parse Claude's response into a list of invoice dicts. Returns (invoices, error)."""
    import json

    try:
        invoices = json.loads(raw_text)
        if not isinstance(invoices, list):
            invoices = [invoices]
        return invoices, None
    except json.JSONDecodeError:
        start = raw_text.find("[")
        end = raw_text.rfind("]")
        if start != -1 and end != -1 and end > start:
            try:
                invoices = json.loads(raw_text[start : end + 1])
                if not isinstance(invoices, list):
                    invoices = [invoices]
                return invoices, None
            except json.JSONDecodeError:
                pass
        return [], f"Could not parse Claude response as JSON: {raw_text[:200]}"


def _call_claude_extract(client: anthropic.Anthropic, content_parts: list[dict], system_prompt: str, chunk_label: str = "") -> tuple[list[dict], Optional[str]]:
    """Send content_parts to Claude and return parsed invoices."""
    try:
        response = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=8192,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": content_parts
                    + [{"type": "text", "text": "Extract all invoices from this document."}],
                }
            ],
        )
        raw_text = response.content[0].text.strip()
        if response.stop_reason == "max_tokens":
            logger.warning("Claude hit max_tokens%s — response may be truncated (%d chars)", chunk_label, len(raw_text))
    except Exception as exc:
        logger.exception("Claude API call failed%s", chunk_label)
        return [], f"Claude API error: {exc}"

    return _parse_claude_json(raw_text)


async def _extract_invoices_from_file(
    upload: UploadFile, client: anthropic.Anthropic, batch_id: str = ""
) -> tuple[list[dict], Optional[str]]:
    """
    Extract invoices from a single file.
    For scanned PDFs with many pages, processes in chunks of MAX_PAGES_PER_CHUNK
    and merges all results. Returns (invoices_list, error_or_None).
    """
    file_bytes = await upload.read()
    filename = (upload.filename or "").lower()
    content_type = (upload.content_type or "").lower()
    is_pdf = filename.endswith(".pdf") or "pdf" in content_type

    t0 = time.monotonic()

    # For scanned PDFs: chunk into groups of MAX_PAGES_PER_CHUNK and call Claude per chunk
    if is_pdf:
        try:
            _prescreen_pdf(file_bytes)
        except BlankDocumentError as exc:
            logger.info("Pre-screen rejected %s: %s", upload.filename, exc)
            return [], f"Skipped (no invoice content): {exc}"
        except Exception as exc:
            logger.exception("Failed to process file %s", upload.filename)
            return [], f"Could not process file: {exc}"

        if _is_scanned_pdf(file_bytes):
            chunks = _pdf_scanned_images_chunked(file_bytes)
            logger.info("Scanned PDF %s: %d pages → %d chunks", upload.filename, sum(len(c) for c in chunks), len(chunks))
            system_prompt = get_system_prompt(fallback=SYSTEM_PROMPT)
            all_invoices: list[dict] = []
            first_error: Optional[str] = None
            for i, chunk in enumerate(chunks):
                chunk_label = f" (chunk {i+1}/{len(chunks)} of {upload.filename})"
                invs, err = _call_claude_extract(client, chunk, system_prompt, chunk_label)
                if err and not invs:
                    if first_error is None:
                        first_error = err
                    logger.warning("Chunk %d/%d failed: %s", i+1, len(chunks), err)
                all_invoices.extend(invs)

            if not all_invoices and first_error:
                return [], first_error

            for inv in all_invoices:
                inv = normalize_hsn_codes(inv)
                inv = correct_line_item_rates(inv)
                inv = detect_bill_discount_from_total(inv)
                inv["confidence"] = compute_confidence(inv)

            processing_ms = int((time.monotonic() - t0) * 1000)
            log_extraction(batch_id=batch_id, file_name=upload.filename or "unknown", invoices=all_invoices, processing_ms=processing_ms)
            return all_invoices, None

    # Non-PDF or native-text PDF: single Claude call
    try:
        if is_pdf:
            content_parts = _pdf_native_text(file_bytes)
        elif filename.endswith(".png") or "png" in content_type:
            _prescreen_image(file_bytes)
            content_parts = _image_to_content(file_bytes, "image/png")
        elif filename.endswith((".jpg", ".jpeg")) or "jpeg" in content_type:
            _prescreen_image(file_bytes)
            content_parts = _image_to_content(file_bytes, "image/jpeg")
        elif filename.endswith(".docx"):
            parts = _docx_to_text(file_bytes)
            _prescreen_text(parts[0]["text"])
            content_parts = parts
        elif filename.endswith(".doc"):
            parts = _doc_to_text(file_bytes)
            _prescreen_text(parts[0]["text"])
            content_parts = parts
        else:
            try:
                text = file_bytes.decode("utf-8", errors="ignore")
            except Exception:
                text = ""
            _prescreen_text(text)
            content_parts = [{"type": "text", "text": text}]
    except BlankDocumentError as exc:
        logger.info("Pre-screen rejected %s: %s", upload.filename, exc)
        return [], f"Skipped (no invoice content): {exc}"
    except Exception as exc:
        logger.exception("Failed to process file %s", upload.filename)
        return [], f"Could not process file: {exc}"

    system_prompt = get_system_prompt(fallback=SYSTEM_PROMPT)
    invoices, err = _call_claude_extract(client, content_parts, system_prompt, f" ({upload.filename})")
    if err and not invoices:
        return [], err

    for inv in invoices:
        inv = normalize_hsn_codes(inv)
        inv = correct_line_item_rates(inv)
        inv = detect_bill_discount_from_total(inv)
        inv["confidence"] = compute_confidence(inv)

    processing_ms = int((time.monotonic() - t0) * 1000)
    log_extraction(batch_id=batch_id, file_name=upload.filename or "unknown", invoices=invoices, processing_ms=processing_ms)

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
        invoices, error = await _extract_invoices_from_file(upload, client, batch_id)
        if error:
            log_extraction(batch_id=batch_id, file_name=upload.filename or "unknown",
                           invoices=[], processing_ms=0, error=error)
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
