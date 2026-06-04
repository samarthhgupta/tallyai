-- Migration 020: Charge Resolution Engine architecture decisions from Q&A session

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:charge:resolution_philosophy',
 'Charge Resolution is ledger-driven, not keyword-driven',
 'ARCHITECTURE DECISION: Charge resolution is fundamentally different from supplier and item resolution. The question being answered is: which expense ledger in this client''s Tally does this charge belong to? This is an accounting classification question, not an identity question. The resolution must be driven by: (1) the client''s existing ledger master structure, (2) historical mapping memory for this client, (3) charge description families as global fallback. It must NOT be driven by hardcoded keyword rules or global charge categories. The system adapts to how each client classifies expenses, not the other way around.'),

('logic:charge:separate_module',
 'Charge Resolution Engine is a standalone module separate from Item and Supplier Resolution',
 'ARCHITECTURE DECISION: Charge Resolution must be its own module, separate from Item Resolution and Supplier Resolution. Three different questions are being answered: Supplier = which legal entity is this? Item = which stock master is this? Charge = which expense ledger does this cost belong to? Different data sources (ledger master vs stock master vs supplier master), different matching logic, different confidence signals. Build three separate engines. The charge engine is the simplest of the three once historical memory is established.'),

('logic:charge:matching_hierarchy',
 'Charge resolution matching hierarchy — historical memory is first, not last',
 'ARCHITECTURE DECISION: The correct matching hierarchy for charge resolution is: (1) Historical mapping — exact charge description match for this client → auto-apply if confirmed 3+ times. (2) Historical mapping — similar charge description for this client → suggest with confidence. (3) Client ledger structure analysis — which of this client''s ledgers are expense-type and likely match this charge category. (4) Global charge family keywords — freight-family, labour-family, courier-family, packing-family as cold start fallback. (5) GST rate — to resolve between ledger variants (e.g. Freight 5% vs Freight 18%). Historical memory must be checked FIRST. Running the full pipeline and then overriding with history at the end is wrong — if the answer is already known from history, skip all other steps.'),

('logic:charge:two_outputs',
 'Charge resolution produces two separate outputs: ledger and GST rate',
 'ARCHITECTURE DECISION: Charge resolution always produces two distinct outputs, not one. OUTPUT 1 — Which ledger: the accounting classification. This is what gets stored in historical memory. OUTPUT 2 — What GST rate: the tax treatment. This must be determined fresh from the invoice evidence each time using the mismatch resolution engine. It must NOT be locked into the historical mapping. Reason: the same charge description (e.g. "Freight") may appear at 5% on most invoices but at 18% on others depending on the carrier type. The ledger stays consistent. The GST rate varies. Storing GST rate in history would cause wrong tax treatment when the rate changes on a specific invoice.'),

('logic:charge:confidence_escalation',
 'Charge mapping confidence escalation — three stages based on mapping history count',
 'ARCHITECTURE DECISION: Charge resolution behaviour changes based on how many times a charge description has been mapped for a specific client. STAGE 1 — First time description appears: always show the Charge Not Found popup. No auto-suggestion is confident enough. Accountant maps manually. STAGE 2 — Description mapped 1-2 times before: show popup but pre-select the previously used ledger as the suggestion. Accountant confirms or changes. One click instead of three. STAGE 3 — Description mapped 3+ times consistently to the same ledger: auto-apply the mapping. Show non-blocking advisory only. Accountant sees what happened but is not interrupted. This escalation makes the system progressively faster as it learns each client.'),

('logic:charge:historical_mapping_memory',
 'Historical mapping memory is client-specific and becomes the strongest signal over time',
 'ARCHITECTURE DECISION CONFIRMED BY USER: Historical mapping memory is the most important signal in the Charge Resolution Engine. When an accountant maps charge description X to ledger Y for client A, the system must remember this. On all future invoices for client A containing charge description X, the system automatically suggests or auto-applies ledger Y. This memory is strictly client-specific — the same charge description may map to different ledgers for different clients. Client A mapping "Hamali Charges" to "Loading Charges" does NOT mean Client B should do the same. Historical memory is stored per client and overrides all other signals once sufficient history exists.'),

('logic:charge:no_automatic_ledger_creation',
 'New ledgers must never be created automatically — always require accountant confirmation',
 'DECISION CONFIRMED BY USER: When a charge cannot be mapped to an existing ledger, the system shows a Charge Ledger Not Found popup. Never auto-creates. The popup offers three choices: (1) Map to Existing Ledger — searchable dropdown of client''s existing ledgers. (2) Create New Ledger — inline, without leaving the invoice review screen. (3) Edit and Retry — if the accountant wants to adjust the charge description before re-attempting. AI pre-fills the new ledger form with suggestions based on the client''s existing ledger master naming conventions, parent group, GST treatment, and GST rate. Accountant can accept, modify, or replace the suggestion entirely.'),

('logic:charge:inline_ledger_creation',
 'New ledgers must be creatable inline from the invoice review screen',
 'DECISION CONFIRMED BY USER: Creating a new ledger must happen directly from within the charge resolution popup, without navigating away from the invoice review screen. Workflow: Invoice Review → Charge Ledger Not Found Popup → Create New Ledger → AI pre-fills form based on client ledger master analysis → Accountant confirms or edits → Save → Continue. The AI-generated suggestion for a new ledger includes: Suggested Ledger Name (following client naming convention), Suggested Parent Group (e.g. Indirect Expenses), Suggested GST Treatment, Suggested GST Rate, Suggested Ledger Type. Accountant remains in control of all fields.'),

('logic:charge:no_freight_capitalization',
 'Freight and charges are always separate expense ledgers — never capitalized into inventory',
 'DECISION CONFIRMED BY USER: For this product and client base, freight and all additional charges are always booked as separate expense ledger entries. They are never distributed across stock items or merged into inventory valuation. Example: Inventory Purchase ₹100,000 + Freight ₹2,000 + Loading ₹500 → three separate ledger entries, not inventory cost of ₹102,500. The freight amount must not affect weighted average inventory cost in Tally. This is a product-level decision and is final for the current architecture.'),

('logic:charge:client_ledger_naming_convention',
 'Do not hardcode ledger names — learn from client ledger master upload',
 'ARCHITECTURE DECISION: The system must NOT hardcode charge ledger names like "Freight (18%)", "Freight (5%)", "Freight (Exempt)". These are one client''s naming convention. Different clients use different names: "Freight Expenses", "Freight Non-GST", "Cartage Charges", "Transport Expenses", etc. When suggesting new ledger names or matching existing ones, the system must analyse the client''s uploaded Ledger Master export to understand their specific naming convention, then generate suggestions that are consistent with that convention.'),

('logic:charge:global_charge_families',
 'Global charge families as cold start fallback before client history exists',
 'ARCHITECTURE DECISION: When a client has no mapping history, use global charge family knowledge as a fallback for initial suggestions. Defined families: FREIGHT FAMILY: Freight, Freight Charges, F&F, Freight & Forwarding, Transport, Transportation, Cartage, Carriage, LR Charges, Lorry Charges, Builty Charges, Delivery Charges. LABOUR FAMILY: Hamali, Loading, Unloading, Loading/Unloading, Labour Charges, Handling Charges, Coolie Charges. COURIER FAMILY: Postage, Postal Charges, Courier, Courier Charges, Dispatch Charges, Shipping. PACKING FAMILY: Packing, Packaging, Packing & Forwarding, P&F Charges. Global families only determine the category of expense — they do not determine the specific ledger. The specific ledger is always determined by the client''s own ledger master. As client history builds up, global families become irrelevant — client-specific history takes over completely.'),

('logic:charge:metadata_to_store',
 'Metadata fields required for accurate charge resolution and future learning',
 'ARCHITECTURE DECISION: Every charge mapping decision must store the following metadata for each client: charge_description_original (exact text from invoice), charge_description_normalized (lowercase stripped for matching), charge_family (freight/labour/courier/packing/other), mapped_ledger_id (FK to ledger master), mapped_gst_rate (GST rate at time of mapping — stored separately from ledger), resolution_method (auto_history / suggested_history / manual / global_fallback), mapping_confirmed_count (number of times accountant confirmed this exact mapping for this client), client_id (client-specific), first_seen_at (when this description first appeared for this client), last_seen_at (most recent invoice for this client with this description). This metadata enables confidence escalation, audit trails, and future cross-client pattern learning.'),

('logic:charge:edge_case_zero_amount',
 'Edge case: zero-amount charges must be filtered before resolution runs',
 'ARCHITECTURE DECISION: Some invoices print charge rows with ₹0 or blank amounts. These must be filtered out entirely before the charge resolution engine runs. A zero-amount charge must never trigger the Charge Ledger Not Found popup. Filter condition: exclude any charge entry where amount is null, zero, or blank. This applies at the data ingestion stage before any resolution logic is attempted.'),

('logic:charge:edge_case_discount_as_charge',
 'Edge case: bill-level discount is a negative ledger entry, not a charge',
 'ARCHITECTURE DECISION: Bill-level discounts appear in Tally as a ledger entry with a negative amount — typically under "Discount Received" (Indirect Income). Structurally this looks like a charge but with reversed sign. The charge resolution engine must NOT process bill-level discounts. Discounts must be handled by a separate discount mapping module. The boundary rule: charges[] entries with positive amounts → charge resolution. Bill discount (negative amount subtracted from subtotal) → discount mapping. These are different accounting treatments and must remain separate.'),

('logic:charge:edge_case_line_items_vs_charges_boundary',
 'Edge case: charge resolution only processes charges[], never line_items[]',
 'ARCHITECTURE DECISION: The extraction engine already determines whether a charge goes into line_items[] (if it has an HSN code in the line items table) or charges[] (if it appears below the subtotal without HSN). The charge resolution engine must only process entries from charges[]. Entries in line_items[] are stock items and go through item resolution, not charge resolution. If this boundary is violated, a freight charge that correctly landed in line_items[] will be mapped twice — once by item resolution and once by charge resolution — producing a duplicate ledger entry in Tally.'),

('logic:charge:edge_case_same_type_multiple_charges',
 'Edge case: multiple charges of the same type on one invoice',
 'ARCHITECTURE DECISION: A single invoice may contain two separate charges that map to the same ledger. Example: "Freight ₹500" and "Transport ₹200" both mapping to the "Freight Expenses" ledger. In Tally, these should be combined into one ledger entry of ₹700 rather than two separate entries for the same ledger. The charge resolution engine must detect when two resolved charges share the same ledger and combine their amounts before generating the Tally voucher entry. GST is then computed on the combined amount.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
