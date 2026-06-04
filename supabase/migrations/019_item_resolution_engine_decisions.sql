-- Migration 019: Item Resolution Engine architecture decisions from Q&A session

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:item:client_inventory_philosophy',
 'Most clients use Tally for accounting, not inventory management',
 'CRITICAL INSIGHT FROM USER: The majority of clients use Tally primarily for accounting, not as an inventory management system. Most clients organise purchases into stock ledgers based on HSN code and GST rate, not individual product names. Common naming conventions: "12345678@5%", "12345678 @ 5%", "STOCK@12%", "Stock (Exempt + 18%)". For these clients: quantity is often not maintained, UOM is often not maintained, pre-discount rates are often not maintained, individual products are not tracked. The accountant simply records taxable value + GST against the appropriate stock ledger. This is the majority client type. Exception: automobile dealerships, spare parts businesses, and similar inventory-heavy businesses maintain detailed stock masters, but these often use dedicated inventory/ERP systems with Tally as secondary accounting.'),

('logic:item:master_mirror_not_modes',
 'Item resolution uses Master-Mirroring, not two explicit operating modes',
 'ARCHITECTURE DECISION: Do not build two explicit modes (Accounting-Oriented Mode vs Inventory-Oriented Mode) for the item resolution engine. Instead use a Master-Mirror approach: analyse the client''s uploaded Tally stock master export and mirror whatever naming convention and structure already exists. Reasons: (1) Explicit mode classification can be wrong. (2) A single client may be accounting-oriented for some categories and inventory-oriented for others — rigid modes cannot handle this. (3) When a client evolves their practices, master-mirroring adapts automatically on the next upload. The client''s existing Tally masters are the source of truth for how the system should behave — no separate classification step is needed.'),

('logic:item:master_analysis_layer',
 'Layer 1: Master Analysis — runs when stock masters are uploaded',
 'When a client uploads their Tally stock item master export, run a one-time analysis that determines the client inventory profile: (1) What naming convention does this client use? (HSN@Rate% style, product name style, generic STOCK labels). (2) Does this client maintain UOM or not? (3) Does this client maintain quantity or not? (4) What GST rate groups exist in their masters? Store this as the client''s inventory profile. All subsequent item suggestions and new item creation must follow this profile to maintain consistency with the client''s existing Tally structure. The profile is updated automatically whenever new masters are uploaded.'),

('logic:item:resolution_layers',
 'Layer 2: Item Resolution — three-step matching process',
 'When a line item arrives from an invoice, attempt to match it to an existing stock master in this order: STEP 1 — HSN code + GST rate exact match. If a unique stock master exists with this exact HSN and GST rate, auto-map with no confirmation required. This single step resolves almost all accounting-oriented client line items because their masters are organised by HSN@GST%. STEP 2 — Description similarity match against existing item names (for inventory-oriented clients where step 1 is insufficient). If high confidence match found, show suggestion and ask accountant to confirm. STEP 3 — No match found. Trigger the item not found popup with three options: map to existing, create new inline, or edit and retry. For accounting-oriented clients step 1 covers the vast majority of cases. Steps 2 and 3 are primarily for inventory-oriented clients.'),

('logic:item:new_item_suggestion_style',
 'Layer 3: New item suggestions must match client naming convention, not a standard format',
 'When no stock master match is found and the system suggests a new item to create, the suggestion must be generated in the style of the client''s existing masters — not in any standard or assumed format. If the client uses HSN@Rate% naming: suggest "12345681@5%", not "Pentonic Pen". If the client uses product name style: suggest "Pentonic Pen Blue". If the client does not maintain UOM in existing masters: leave UOM blank in the suggestion. If the client maintains UOM: suggest based on historical patterns (PCS, NOS, KG, LTR, BOX, etc.). The objective is to reduce typing and maintain internal consistency within the client''s Tally company. AI suggests, accountant decides.'),

('logic:item:no_automatic_creation',
 'New stock items must never be created automatically without accountant confirmation',
 'DECISION CONFIRMED BY USER: When an item cannot be confidently mapped to an existing stock master, the system must show a popup — never automatically create a new stock item. The popup presents three choices: (1) Map to Existing Stock Item — show searchable dropdown of existing masters. (2) Create New Stock Item — happens inline without leaving the invoice review screen. (3) Edit and Retry Mapping — if the accountant wants to adjust the extracted data before re-attempting. AI suggestions are shown within the popup to reduce effort, but the accountant must actively confirm before any new stock item is created in the system.'),

('logic:item:inline_item_creation',
 'New stock items must be creatable inline from the invoice review screen',
 'DECISION CONFIRMED BY USER: When an accountant chooses to create a new stock item, it must happen directly from the invoice review screen — from within the item popup or dropdown. The accountant must never be forced to navigate to a separate Stock Item Master screen, create the item there, and return. Workflow: Invoice Review → Item Not Found Popup → Create New Stock Item → system pre-fills suggestion based on client inventory profile → accountant confirms or edits → Save → continue with invoice. Losing context mid-review causes mistakes and slows down the accountant.'),

('logic:item:no_product_codes_as_identifier',
 'Product codes and barcodes are not reliable item identifiers for most clients',
 'DECISION FROM USER: Most clients do not use product codes, barcodes, or internal SKU systems on their invoices. Therefore product codes cannot be treated as a primary item identifier equivalent to GSTIN for suppliers. Exception: automobile dealerships and spare parts businesses may have part codes, but these businesses typically maintain codes inside their own operational systems and Tally contains only summarised accounting entries. Item resolution must be driven by: (1) existing client stock masters, (2) HSN code, (3) GST rate, (4) description similarity, (5) historical mapping behaviour — in that order of priority.'),

('logic:item:full_detail_always_stored',
 'Purchase Register always stores full line item detail regardless of Tally export format',
 'ARCHITECTURE DECISION: TallyAI must always store complete line item detail internally — description, quantity, rate, discount percent, HSN, GST rate, taxable amount — even for accounting-oriented clients whose Tally export collapses everything into a single stock ledger entry. Reasons: (1) Data already extracted by Claude — discarding it is wasteful and irreversible. (2) GSTR-2B reconciliation needs actual invoice-level data, not collapsed accounting entries. (3) Future analytics and audits require item-level granularity. (4) A client may transition from accounting-oriented to inventory-oriented — lost data cannot be reconstructed. The collapse from detailed line items to Tally accounting entries happens ONLY at the export layer when generating XML. It never happens in the database.'),

('logic:item:cold_start_behaviour',
 'Cold start: when no stock masters exist yet, always show popup and learn from accountant',
 'ARCHITECTURE DECISION: When a new client has not yet uploaded any stock masters, the item resolution engine has no profile to mirror. Default behaviour in this state: always show the item mapping popup for every line item. Never auto-create. After the accountant has manually mapped or created 20-30 items, the system has enough data to infer the client inventory philosophy automatically without requiring a formal master upload. The stock master upload (Tally export) is therefore an optional accelerator for onboarding existing clients with large master lists — it is not a mandatory first step. New clients can onboard incrementally.'),

('logic:item:hsn_gst_primary_for_accounting_clients',
 'For accounting-oriented clients, HSN + GST rate is the complete item identity',
 'INSIGHT FROM ARCHITECTURE REVIEW: For clients who use HSN@GST% style stock ledgers, the item identity is fully defined by two fields: HSN code + GST rate. Description is irrelevant to them. This means the item resolution engine for these clients is essentially a simple lookup: does a stock master exist for this HSN + GST% combination? If yes, auto-map. If no, ask. This is dramatically simpler than the supplier resolution engine. The complexity of fuzzy description matching, similarity scoring, and historical behaviour analysis applies only to inventory-oriented clients who are the minority. Design the simple path first, layer complexity on top for inventory-oriented clients only.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
