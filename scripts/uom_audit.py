#!/usr/bin/env python3
"""
UOM Pre-Migration Audit Report
================================
Read-only. Makes NO changes to the database.

Usage:
    export SUPABASE_ACCESS_TOKEN=<your-personal-access-token>
    python3 scripts/uom_audit.py

The personal access token is found at:
    https://supabase.com/dashboard/account/tokens
"""

import os, json, sys, urllib.request, urllib.error, re
from collections import defaultdict

TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
if not TOKEN:
    print("ERROR: SUPABASE_ACCESS_TOKEN environment variable not set.")
    print("Get your token from https://supabase.com/dashboard/account/tokens")
    sys.exit(1)

URL = "https://api.supabase.com/v1/projects/idstdsuvxqzoankkfgde/database/query"

def run_sql(sql):
    data = json.dumps({"query": sql}).encode("utf-8")
    req = urllib.request.Request(URL, data=data, method="POST")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "TallyAI-UOM-Audit/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"HTTP {e.code}: {body[:500]}")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

# ---------------------------------------------------------------------------
# Canonical UOM registry (approved by user)
# ---------------------------------------------------------------------------
CANONICAL_UOMS = {
    "Pcs": "Pieces", "Nos": "Numbers", "Set": "Sets", "Pair": "Pairs",
    "Doz": "Dozens", "Kg": "Kilograms", "Gm": "Grams", "Mtr": "Metres",
    "Ft": "Feet", "Sq Ft": "Square Feet", "Ltr": "Litres", "Ml": "Millilitres",
    "Box": "Boxes", "Bag": "Bags", "Roll": "Rolls", "Bdl": "Bundles",
    "Bal": "Bales", "Tray": "Trays", "Pkt": "Packets", "Sht": "Sheets",
    "Strp": "Strips", "Tube": "Tubes", "Tin": "Tins", "Can": "Cans",
}

ALIAS_MAP = {
    # Pcs
    "PCS": "Pcs", "pcs": "Pcs", "Pc": "Pcs", "pc": "Pcs", "PC": "Pcs",
    "Pcs.": "Pcs", "pcs.": "Pcs", "Piece": "Pcs", "Pieces": "Pcs",
    "PANEL": "Pcs", "PANELS": "Pcs", "Unit": "Pcs", "Units": "Pcs", "UNIT": "Pcs",
    # Nos
    "NOS": "Nos", "nos": "Nos", "Number": "Nos", "Numbers": "Nos", "Num": "Nos",
    # Set
    "SET": "Set", "set": "Set", "Sets": "Set", "SETS": "Set",
    # Pair
    "PAIR": "Pair", "pair": "Pair", "Pairs": "Pair", "Pr": "Pair", "PR": "Pair",
    # Doz
    "DOZ": "Doz", "doz": "Doz", "Dozen": "Doz", "Dozens": "Doz", "DZN": "Doz",
    # Kg
    "KG": "Kg", "kg": "Kg", "Kgs": "Kg", "KGS": "Kg",
    "Kilogram": "Kg", "Kilograms": "Kg",
    # Gm
    "GM": "Gm", "gm": "Gm", "g": "Gm", "Gram": "Gm", "Grams": "Gm", "GMS": "Gm",
    # Mtr
    "MTR": "Mtr", "mtr": "Mtr", "Meter": "Mtr", "Meters": "Mtr",
    "Metre": "Mtr", "Metres": "Mtr",
    # Ft
    "FT": "Ft", "ft": "Ft", "FEET": "Ft", "Feet": "Ft", "foot": "Ft", "Foot": "Ft",
    # Sq Ft
    "SQ FT": "Sq Ft", "sq ft": "Sq Ft", "Sqft": "Sq Ft", "SQFT": "Sq Ft",
    "Sq. Ft.": "Sq Ft",
    # Ltr
    "LTR": "Ltr", "ltr": "Ltr", "L": "Ltr", "Litre": "Ltr", "Litres": "Ltr",
    "Liter": "Ltr", "Liters": "Ltr",
    # Ml
    "ML": "Ml", "ml": "Ml", "Millilitre": "Ml", "Milliliter": "Ml",
    # Box
    "BOX": "Box", "box": "Box", "Boxes": "Box", "BOXES": "Box",
    "Carton": "Box", "CARTON": "Box", "Cartons": "Box", "CTN": "Box", "ctn": "Box",
    # Bag
    "BAG": "Bag", "bag": "Bag", "Bags": "Bag", "BAGS": "Bag",
    # Roll
    "ROLL": "Roll", "roll": "Roll", "Rolls": "Roll", "ROLLS": "Roll",
    # Bdl
    "BUNDLE": "Bdl", "Bundle": "Bdl", "Bundles": "Bdl", "BDL": "Bdl", "bdl": "Bdl",
    # Bal
    "BALE": "Bal", "Bale": "Bal", "Bales": "Bal", "BAL": "Bal",
    # Tray
    "TRAY": "Tray", "Trays": "Tray", "TRAYS": "Tray",
    # Pkt
    "PACKET": "Pkt", "Packet": "Pkt", "Packets": "Pkt", "PKT": "Pkt",
    # Sht
    "SHEET": "Sht", "Sheet": "Sht", "Sheets": "Sht", "SHT": "Sht",
    # Strp
    "STRIP": "Strp", "Strip": "Strp", "Strips": "Strp",
    # Tube
    "TUBE": "Tube", "Tubes": "Tube",
    # Tin
    "TIN": "Tin", "Tins": "Tin",
    # Can
    "CAN": "Can", "Cans": "Can", "CANS": "Can",
}

# These are already canonical (no change needed, exact match)
CANONICAL_SET = set(CANONICAL_UOMS.keys())

def normalize(raw):
    """Returns (canonical, change_type) where change_type is:
       'no_change'   - already canonical
       'alias'       - known alias → canonical
       'numeric'     - had numeric prefix, stripped
       'unknown'     - not in registry
    """
    if raw is None:
        return None, 'null'
    s = raw.strip()

    # Strip numeric prefix: "5 Pcs" → "Pcs"
    m = re.match(r'^(\d+)\s+(.+)$', s)
    if m:
        remainder = m.group(2).strip()
        resolved = ALIAS_MAP.get(remainder) or (remainder if remainder in CANONICAL_SET else None)
        if resolved:
            return resolved, 'numeric'
        return remainder, 'numeric_unknown'

    if s in CANONICAL_SET:
        return s, 'no_change'
    if s in ALIAS_MAP:
        return ALIAS_MAP[s], 'alias'
    return s, 'unknown'

def divider(title):
    print()
    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)

def table(headers, rows, col_widths=None):
    if not col_widths:
        col_widths = [max(len(str(r[i])) for r in ([headers] + rows)) for i in range(len(headers))]
    fmt = "  " + "  ".join(f"{{:<{w}}}" for w in col_widths)
    sep = "  " + "  ".join("-" * w for w in col_widths)
    print(fmt.format(*headers))
    print(sep)
    for row in rows:
        print(fmt.format(*[str(x) for x in row]))

# ---------------------------------------------------------------------------
print()
print("╔══════════════════════════════════════════════════════════════════════╗")
print("║         TallyAI — UOM Pre-Migration Audit Report (READ ONLY)        ║")
print("╚══════════════════════════════════════════════════════════════════════╝")

# ---------------------------------------------------------------------------
divider("SECTION 1 — STOCK ITEM MASTER: All Distinct UOM Values")
# ---------------------------------------------------------------------------

rows = run_sql("""
    SELECT
        COALESCE(unit, '(null)') AS current_uom,
        COUNT(*) AS count
    FROM stock_item_masters
    GROUP BY unit
    ORDER BY count DESC, unit
""")

master_uoms = {}
for r in rows:
    master_uoms[r['current_uom']] = int(r['count'])

norm_rows = []
for uom, cnt in sorted(master_uoms.items(), key=lambda x: -x[1]):
    raw = None if uom == '(null)' else uom
    canonical, change_type = normalize(raw)
    if change_type == 'null':
        proposed = '(to be inferred/Nos)'
        action = 'INFER'
    elif change_type == 'no_change':
        proposed = canonical
        action = 'no change'
    elif change_type == 'alias':
        proposed = canonical
        action = 'NORMALIZE'
    elif change_type == 'numeric':
        proposed = canonical
        action = 'STRIP PREFIX'
    elif change_type == 'numeric_unknown':
        proposed = canonical
        action = 'REVIEW'
    else:
        proposed = '???'
        action = 'UNKNOWN — REVIEW'
    norm_rows.append((uom, cnt, proposed, action))

table(
    ['Current UOM', 'Count', 'Proposed UOM', 'Action'],
    norm_rows,
    [20, 6, 20, 20]
)

total_masters = sum(master_uoms.values())
print(f"\n  Total stock item master records: {total_masters}")

# Tally risk: Nos/NOS which may be in existing Tally company
tally_risk_uoms = ['Nos', 'NOS', 'nos', 'Numbers']
tally_risk_items = [(u, c) for u, c in master_uoms.items() if u in tally_risk_uoms]
if tally_risk_items:
    print(f"\n  ⚠  Potential Tally conflict (these were likely sent to Tally as 'Nos'):")
    for u, c in tally_risk_items:
        print(f"     {u}: {c} record(s)")

# ---------------------------------------------------------------------------
divider("SECTION 2 — INVOICE UOM VALUES (Accepted vs Unaccepted)")
# ---------------------------------------------------------------------------

invoice_rows = run_sql("""
    SELECT
        COALESCE(li->>'uom', '(null)') AS uom,
        SUM(CASE WHEN tally_ledger_acceptance IS NOT NULL THEN 1 ELSE 0 END) AS accepted_count,
        SUM(CASE WHEN tally_ledger_acceptance IS NULL     THEN 1 ELSE 0 END) AS unaccepted_count
    FROM invoices,
         jsonb_array_elements(line_items) AS li
    GROUP BY li->>'uom'
    ORDER BY (accepted_count + unaccepted_count) DESC
""")

inv_table_rows = []
for r in invoice_rows:
    uom = r['uom']
    raw = None if uom == '(null)' else uom
    canonical, change_type = normalize(raw)
    if change_type in ('no_change', 'null'):
        action = 'no change' if change_type == 'no_change' else 'INFER'
        proposed = canonical if canonical else '(Nos)'
    elif change_type in ('alias', 'numeric'):
        proposed = canonical
        action = 'NORMALIZE'
    else:
        proposed = uom
        action = 'UNKNOWN — REVIEW'
    inv_table_rows.append((uom, r['accepted_count'], r['unaccepted_count'], proposed, action))

table(
    ['Invoice UOM', 'Accepted', 'Unaccepted', 'Proposed', 'Action'],
    inv_table_rows,
    [20, 9, 11, 20, 22]
)

total_line_items = sum(int(r['accepted_count']) + int(r['unaccepted_count']) for r in invoice_rows)
print(f"\n  Total invoice line items scanned: {total_line_items}")

# ---------------------------------------------------------------------------
divider("SECTION 3 — PROPOSED NORMALIZATION CHANGES (Changes Only)")
# ---------------------------------------------------------------------------

changes = [(cur, prop, action) for cur, cnt, prop, action in norm_rows
           if action not in ('no change',) and cur != '(null)']
inv_changes = [(cur, prop, action) for cur, acc, unacc, prop, action in inv_table_rows
               if action not in ('no change',) and cur != '(null)']

all_changes = {}
for cur, prop, action in changes + inv_changes:
    if cur not in all_changes:
        all_changes[cur] = (prop, action)

if all_changes:
    table(
        ['Current Value', 'Proposed Value', 'Action'],
        [(c, p, a) for c, (p, a) in sorted(all_changes.items())],
        [22, 22, 22]
    )
else:
    print("  No changes required — all UOMs already canonical.")

# ---------------------------------------------------------------------------
divider("SECTION 4 — NULL UOM ANALYSIS (Stock Items Without UOM)")
# ---------------------------------------------------------------------------

null_items = run_sql("""
    SELECT
        s.id,
        s.tally_item_name,
        s.alias_name,
        s.hsn_code,
        s.gst_percent
    FROM stock_item_masters s
    WHERE s.unit IS NULL OR s.unit = ''
    ORDER BY s.tally_item_name
""")

if not null_items:
    print("  No stock items with null/empty UOM found. ✓")
else:
    print(f"  Found {len(null_items)} stock item(s) with no UOM.\n")
    print("  Querying historical invoice data for inference...\n")

    inference_rows = []
    for item in null_items:
        name = item['tally_item_name']
        alias = item.get('alias_name') or ''

        # Query invoice line items where description matches name or alias
        hist = run_sql(f"""
            SELECT
                LOWER(TRIM(li->>'uom')) AS uom_lower,
                li->>'uom' AS uom_raw,
                COUNT(*) AS cnt
            FROM invoices,
                 jsonb_array_elements(line_items) AS li
            WHERE
                LOWER(TRIM(li->>'description')) = LOWER(TRIM({json.dumps(name)}))
                OR (
                    {json.dumps(bool(alias))}::boolean
                    AND LOWER(TRIM(li->>'description')) = LOWER(TRIM({json.dumps(alias)}))
                )
            GROUP BY li->>'uom'
            ORDER BY cnt DESC
            LIMIT 5
        """)

        if not hist:
            inferred = 'Nos'
            confidence = 'No history — default'
        else:
            total_hist = sum(int(h['cnt']) for h in hist)
            top = hist[0]
            top_raw = top['uom_raw']
            top_cnt = int(top['cnt'])
            canonical, _ = normalize(top_raw)
            pct = round(100 * top_cnt / total_hist) if total_hist > 0 else 0

            if pct >= 80:
                confidence = f'HIGH ({pct}% of {total_hist} line items)'
            elif pct >= 50:
                confidence = f'MEDIUM ({pct}% of {total_hist} line items)'
            else:
                confidence = f'LOW ({pct}% of {total_hist} line items) — REVIEW'

            inferred = canonical if canonical else 'Nos'

        inference_rows.append((name[:30], 'null', inferred, confidence))

    table(
        ['Stock Item', 'Current UOM', 'Inferred UOM', 'Confidence'],
        inference_rows,
        [32, 12, 14, 45]
    )

# ---------------------------------------------------------------------------
divider("SECTION 5 — TALLY RISK ANALYSIS")
# ---------------------------------------------------------------------------

tally_rows = run_sql("""
    SELECT
        s.tally_item_name,
        s.unit,
        s.hsn_code,
        s.gst_percent
    FROM stock_item_masters s
    WHERE LOWER(s.unit) IN ('nos', 'numbers', 'no', 'num')
    ORDER BY s.tally_item_name
""")

if not tally_rows:
    print("  No stock items found with 'Nos/NOS/Numbers' UOM.")
    print("  No Tally compatibility risk from UOM changes. ✓")
else:
    print(f"  Found {len(tally_rows)} stock item(s) using Nos/NOS/Numbers.")
    print()
    print("  These items may have been exported to Tally with unit = 'Nos'.")
    print("  Changing these to 'Pcs' could conflict with existing Tally masters.")
    print("  RECOMMENDATION: Do not auto-migrate these. Review manually.\n")
    table(
        ['Stock Item', 'Current UOM', 'HSN', 'GST%'],
        [(r['tally_item_name'][:35], r['unit'], r['hsn_code'] or '-', r['gst_percent'] or '-')
         for r in tally_rows],
        [37, 12, 12, 6]
    )

# ---------------------------------------------------------------------------
divider("SECTION 6 — MIGRATION SUMMARY")
# ---------------------------------------------------------------------------

# Recalculate categories
auto_safe = []
needs_review = []
tally_risk = []
cannot_infer = []
unknown_uom = []

for uom, cnt, proposed, action in norm_rows:
    if uom == '(null)':
        # Already handled in Section 4
        pass
    elif action == 'no change':
        pass
    elif action == 'NORMALIZE':
        if uom in tally_risk_uoms:
            tally_risk.append((uom, cnt, proposed))
        else:
            auto_safe.append((uom, cnt, proposed))
    elif action == 'STRIP PREFIX':
        auto_safe.append((uom, cnt, proposed))
    elif 'REVIEW' in action or 'UNKNOWN' in action:
        unknown_uom.append((uom, cnt, proposed))

for r in inv_table_rows:
    uom, acc, unacc, prop, action = r
    if 'UNKNOWN' in action and uom not in [x[0] for x in unknown_uom]:
        unknown_uom.append((uom, int(acc)+int(unacc), prop))

print(f"  ✓  SAFE — Auto-migrate ({len(auto_safe)} distinct values):")
if auto_safe:
    for uom, cnt, prop in auto_safe:
        print(f"       {uom} → {prop}  ({cnt} records)")
else:
    print("       (none)")

print()
print(f"  ⚠  TALLY RISK — Manual review required ({len(tally_risk)} distinct values):")
if tally_risk:
    for uom, cnt, prop in tally_risk:
        print(f"       {uom} → {prop}?  ({cnt} records)  [may conflict with existing Tally masters]")
else:
    print("       (none)")

null_count = master_uoms.get('(null)', 0)
print()
print(f"  ℹ  NULL UOM — {null_count} stock item(s) — infer from history or default to Nos")

print()
print(f"  ✗  UNKNOWN UOM — Cannot auto-resolve ({len(unknown_uom)} distinct values):")
if unknown_uom:
    for uom, cnt, prop in unknown_uom:
        print(f"       '{uom}'  ({cnt} occurrences)  — flag for review")
else:
    print("       (none)")

print()
print("=" * 72)
print("  END OF REPORT — No changes were made to the database.")
print("=" * 72)
print()
