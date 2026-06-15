# UOM Architecture

## Canonical Principle

Stock Item Master UOM is the authoritative source of truth for all UOM values
sent to Tally. The resolution chain is:

```
1. Stock Item Master UOM   (stockItem.unit)
2. Invoice line item UOM   (item.uom — normalised)
3. Default                 ("Nos")
```

Once a stock item has been matched to a Stock Item Master record, the invoice
UOM is ignored for export purposes. An invoice saying `Feet` against a master
that says `Pcs` will export as `Pcs`.

This rule is implemented in `resolveUom()` in `frontend/src/lib/uomRegistry.ts`
and called at every XML output point in `frontend/src/lib/xmlGenerator.ts`.

**Do not revert this to invoice-first.** The old logic was:
```typescript
const uom = item.uom || stockItem.unit || 'NOS';  // WRONG — invoice-first
```
The correct logic is:
```typescript
const uom = resolveUom(stockItem.unit, item.uom);  // master-first
```

---

## Canonical UOM Registry

All canonical UOM values are defined in `frontend/src/lib/uomRegistry.ts`
(`CANONICAL_UOMS` array) and seeded into the `uom_canonical` DB table via
`supabase/migrations/035_uom_registry.sql`.

| Canonical | Full Name      | GST Code |
|-----------|----------------|----------|
| Pcs       | Pieces         | PCS      |
| Nos       | Numbers        | NOS      |
| Set       | Sets           | SET      |
| Pair      | Pairs          | PAR      |
| Doz       | Dozens         | DOZ      |
| Kg        | Kilograms      | KGS      |
| Gm        | Grams          | GMS      |
| Mtr       | Metres         | MTR      |
| Ft        | Feet           | FT       |
| Sq Ft     | Square Feet    | SQF      |
| Ltr       | Litres         | LTR      |
| Ml        | Millilitres    | MLT      |
| Box       | Boxes          | BOX      |
| Bag       | Bags           | BAG      |
| Roll      | Rolls          | ROL      |
| Bdl       | Bundles        | BDL      |
| Bal       | Bales          | BAL      |
| Tray      | Trays          | TRY      |
| Pkt       | Packets        | PKT      |
| Sht       | Sheets         | SHT      |
| Strp      | Strips         | STP      |
| Tube      | Tubes          | TBE      |
| Tin       | Tins           | TIN      |
| Can       | Cans           | CAN      |
| Coil      | Coils          | COL      |
| Drum      | Drums          | DRM      |
| Sq Mtr    | Square Metres  | SQM      |

The `name` column of `uom_canonical` is the value stored in
`stock_item_masters.unit` and emitted in Tally XML `<BASEUNITS>` and
`<RATE>` / `<ACTUALQTY>` / `<BILLEDQTY>` tags.

---

## Alias Normalization

Every entry point where a UOM value enters the system applies `normalizeUom()`
before storage. This prevents non-canonical values from ever reaching the
database.

### Invoice extraction (backend)

`backend/routes/invoices.py` — `normalize_uoms()` runs immediately after
Claude extracts line items, before the invoice is stored. The function strips
numeric prefixes (`5 Pcs` → `Pcs`) and resolves aliases via `_UOM_ALIAS`.

Call sites — all three extraction pipeline branches call it:
```python
inv = normalize_hsn_codes(inv)
inv = normalize_uoms(inv)          # ← normalises every line_item[].uom
inv = correct_line_item_rates(inv)
```

### Stock item creation (frontend form)

`frontend/src/app/masters/stock-items/page.tsx` — `handleSubmit()` normalises
the `unit` field before calling `addStockItem` / `updateStockItem`:
```typescript
const resolvedUnit = rawUnit ? normalizeUom(rawUnit).canonical : 'Nos';
```

### Stock item Excel import

Same file — the Excel import handler normalises the unit column for every row:
```typescript
unit: rawUnit ? normalizeUom(rawUnit).canonical : 'Nos',
```

### Numeric prefix stripping

`normalizeUom()` handles compound values like `5 Pcs` by extracting the
numeric prefix and resolving the remainder:
```typescript
const numMatch = trimmed.match(/^(\d+)\s+(.+)$/);
// "5 Pcs" → numericPrefix=5, uomStr="Pcs" → canonical="Pcs"
```
The numeric prefix is discarded. Packaging quantities are not part of the UOM.

---

## XML Generation

`frontend/src/lib/xmlGenerator.ts` is the only file that produces Tally XML.
All UOM values in the output go through `resolveUom()`:

| XML element | Code |
|---|---|
| `<RATE>value/UOM</RATE>` | `resolveUom(stockItem.unit, item.uom)` (line ~740) |
| `<ACTUALQTY>` / `<BILLEDQTY>` | same resolved value |
| `<BASEUNITS>` in stock item master | `resolveUom(s.unit, null)` |
| `<UNIT>` definition blocks | `resolveUom(s.unit, null)` via `buildUnitBlock()` |

`buildUnitBlock()` uses `getCanonical(unitName)` from the registry to produce
the correct `<ORIGINALNAME>` and `<GSTREPORUOM>` fields. Unknown UOM values
fall back to `unitName` as the formal name, which produces a valid but
unrecognised unit in Tally — this is the intended behaviour for genuinely new
units pending governance review.

The `UNIT_FORMAL_NAMES` hardcoded dictionary that previously existed in this
file has been removed. The registry is the single source of truth.

---

## Export Preview

The Export Preview table in `frontend/src/app/xml/page.tsx` displays the same
UOM that the XML will use.

**Inventory mode**: The `PreviewRow.uom` field is populated by
`buildTallyPreview()` in `xmlGenerator.ts` using `resolveUom()` (line ~2071).
The display row reads `row.uom` directly — it is already resolved.

**Accounting mode**: There is no stock item match. The invoice UOM is
normalised via `normalizeUom(item.uom).canonical` before display. UOM does not
appear in accounting-mode Tally voucher XML (no `ALLINVENTORYENTRIES`), so
this is informational only.

Preview and XML are always consistent because both derive UOM from the same
`resolveUom()` call in `xmlGenerator.ts`. There is no separate display-side
UOM resolution.

---

## Historical Invoice Data

Invoice line items are stored as JSONB in `invoices.line_items[].uom`. Records
created before June 2026 may contain non-canonical values such as `pcs`, `PCS`,
`Pc.`, `Each`, `PANEL`.

**These values are intentionally not migrated** for the following reasons:

1. XML generation uses master-first precedence — the raw stored value is never
   read for Tally output when a stock master is matched.
2. The invoice editing screens (`InvoiceCard`, `InvoiceDetailPanel`) and Excel
   export intentionally show the original extracted value as a source document
   audit trail.
3. The risk of corrupting accepted invoice records outweighs the cosmetic
   benefit of normalising historical display values.

If a future decision is made to run the JSONB migration, it must exclude
invoices where `tally_ledger_acceptance IS NOT NULL` (accepted invoices are
locked) and must be preceded by a full audit of affected records.

---

## Future UOM Governance

When a new UOM value needs to be added to the system, update all four of the
following locations to keep them in sync:

### 1. `frontend/src/lib/uomRegistry.ts`

Add the canonical entry to `CANONICAL_UOMS`:
```typescript
{ name: 'NewUnit', fullName: 'New Units', gstCode: 'NWU' },
```

Add all known aliases to `ALIAS_MAP`:
```typescript
'NEWUNIT': 'NewUnit', 'New Unit': 'NewUnit', 'new unit': 'NewUnit',
```

### 2. `backend/routes/invoices.py`

Add the canonical name to `_UOM_CANONICAL`:
```python
_UOM_CANONICAL = { ..., 'NewUnit' }
```

Add aliases to `_UOM_ALIAS`:
```python
'NEWUNIT': 'NewUnit', 'New Unit': 'NewUnit',
```

### 3. `supabase/migrations/035_uom_registry.sql` (or a new migration)

Add a canonical INSERT:
```sql
INSERT INTO uom_canonical (name, full_name, gst_uom_code, sort_order)
VALUES ('NewUnit', 'New Units', 'NWU', 28)
ON CONFLICT (name) DO NOTHING;
```

Add alias INSERTs:
```sql
INSERT INTO uom_alias (alias, canonical_id, company_id)
SELECT 'NEWUNIT', id, NULL FROM uom_canonical WHERE name = 'NewUnit'
ON CONFLICT DO NOTHING;
```

### 4. This document

Add the new canonical to the registry table above.

### Unknown UOM governance

If an invoice arrives with a UOM that is not in the registry, `normalizeUom()`
returns `{ isKnown: false }`. The raw value passes through unchanged. It is
stored in the invoice JSONB and used as the UOM fallback if no master is
matched. A `uom_pending_review` table exists for future approval workflow
implementation — insert unknown UOMs there for review before adding them as
new canonicals.

---

## Known Exceptions

Three stock item master records intentionally have `unit = NULL`:

| tally_item_name        | Reason                                      |
|------------------------|---------------------------------------------|
| `Stock (Exempt + 18%)` | Generic catch-all — no fixed UOM applicable |
| `STOCK@12%`            | Generic catch-all — no fixed UOM applicable |
| `STOCK@5%`             | Generic catch-all — no fixed UOM applicable |

These records have no `alias_name` and no `hsn_code`. They cannot be matched
by `findStockItem()` through any code path (HSN match requires a non-null
`hsn_code`; description match requires the invoice description to equal
`STOCK@12%` literally, which never occurs).

Because they are never matched, their `unit = NULL` has no effect on XML
output. Setting them to `Nos` would be semantically incorrect (they are not
piece-based items) and operationally irrelevant.

**Do not set these to a canonical UOM.** Leave them null.
