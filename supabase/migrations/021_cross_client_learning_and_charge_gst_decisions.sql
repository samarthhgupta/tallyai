-- Migration 021: Cross-client learning privacy architecture + charge GST rate separation decisions

INSERT INTO prompt_rules (key, description, content) VALUES

('logic:charge:two_outputs_ledger_vs_gst',
 'Charge resolution two outputs: ledger is remembered, GST rate is read fresh each time',
 'ARCHITECTURE DECISION (simplified): Charge resolution always produces two separate outputs. OUTPUT 1 — Which ledger: the accounting classification (e.g. "Freight Expenses"). This is stored in historical memory and reused on future invoices. This never changes for a given charge description for a given client. OUTPUT 2 — What GST rate: the tax treatment (e.g. 5% or 18%). This must be determined fresh from each invoice using the mismatch resolution engine. It must never be locked into historical memory. Reason: the same charge description (e.g. "Freight Charges") always maps to the same ledger, but the GST rate can vary invoice by invoice depending on the carrier or transport mode (local truck = 5%, air courier = 18%). If GST rate is frozen in history, the system will apply the wrong tax on invoices where the rate differs. Rule: remember the ledger permanently, read the GST rate fresh every time.'),

('logic:platform:cross_client_learning_inhouse_vs_saas',
 'Cross-client learning: safe for inhouse use, requires strict isolation for SaaS product',
 'ARCHITECTURE DECISION: Cross-client learning means different things depending on deployment model. INHOUSE USE (current): The platform owner manages all clients themselves. All client data belongs to the same firm. Cross-client learning across all these clients is safe and beneficial — one client''s mapping decisions improve suggestions for all other clients of the same firm. This is the current deployment model and full cross-client learning is appropriate. SAAS PRODUCT (future): Multiple independent accounting firms purchase and use the software. Each firm manages their own clients. In this model, cross-client learning that shares raw mapping data across firms is a serious privacy violation — one firm''s client data must never be used to improve suggestions seen by another firm, as clients never consented to this and it likely violates data privacy laws.'),

('logic:platform:firm_level_data_isolation',
 'Firm-level data isolation must be built into the data model from day one',
 'ARCHITECTURE DECISION: Even though the platform is currently used inhouse by a single firm, firm-level data isolation must be built into the data model now, before any SaaS deployment. Adding isolation later is extremely expensive and often requires rebuilding core tables. The cost of adding it now is minimal. Implementation: every table that contains client-specific data (invoices, supplier masters, item masters, ledger masters, charge mappings, reconciliation records) must have a firm_id column from the start. Queries must always filter by firm_id. No cross-firm data access is permitted at the query level, even for the platform owner.'),

('logic:platform:safe_cross_firm_learning',
 'Safe cross-firm learning: share anonymous patterns only, never raw data',
 'ARCHITECTURE DECISION: Cross-firm learning in a SaaS product is achievable without privacy violations if only anonymous statistical patterns are shared — never raw client data. Safe pattern example: "The charge description ''Hamali'' maps to a ledger in the Indirect Expenses parent group containing the word Loading or Labour in 89% of cases across all firms." This pattern contains: no client name, no firm name, no ledger name, no invoice amounts, no identifiable information. It is a pure statistical signal. This anonymous knowledge base improves cold-start suggestions for new firms without exposing any firm''s client data to another firm. Analogy: Google Maps shares traffic patterns from all drivers but never shares any individual driver''s home address or destination.'),

('logic:platform:data_isolation_architecture',
 'Data isolation architecture: each firm is a completely isolated silo with shared anonymous layer',
 'ARCHITECTURE DECISION: The correct architecture for a multi-firm SaaS product is two distinct layers. LAYER 1 — Firm-specific data silo: each firm''s clients, invoices, supplier masters, item masters, ledger masters, charge mappings, and reconciliation records are completely isolated. Visible only to that firm. Zero cross-firm access. LAYER 2 — Shared anonymous knowledge base: patterns extracted from all firms with all identifiable information removed. Contains charge description → expense category patterns, item description → HSN patterns, supplier name similarity patterns. Updated by all firms collectively. Improves cold-start suggestions for everyone. Contains zero client or firm data. New firms benefit immediately from the global pattern knowledge without any privacy risk to existing firms.')

ON CONFLICT (key) DO UPDATE
  SET content     = EXCLUDED.content,
      description = EXCLUDED.description,
      updated_at  = NOW();
