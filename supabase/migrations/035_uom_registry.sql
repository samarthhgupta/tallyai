-- UOM Registry
-- Canonical units, aliases, and a pending-review queue for unknown UOMs.
-- This is the permanent source of truth for all UOM governance in TallyAI.

CREATE TABLE IF NOT EXISTS uom_canonical (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  name         text NOT NULL UNIQUE,   -- display/storage form e.g. "Pcs"
  full_name    text NOT NULL,          -- e.g. "Pieces"
  gst_uom_code text NOT NULL,          -- GST reporting code e.g. "PCS"
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uom_alias (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  alias          text NOT NULL,
  canonical_id   uuid NOT NULL REFERENCES uom_canonical(id) ON DELETE CASCADE,
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  -- company_id NULL = global alias; non-null = company-specific override
  UNIQUE (alias, company_id)
);
CREATE INDEX IF NOT EXISTS idx_uom_alias_lookup ON uom_alias (alias, company_id);

CREATE TABLE IF NOT EXISTS uom_pending_review (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_value               text NOT NULL,
  invoice_id              uuid REFERENCES invoices(id) ON DELETE SET NULL,
  suggested_canonical_id  uuid REFERENCES uom_canonical(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at             timestamptz
);

-- ── Seed canonical UOMs ────────────────────────────────────────────
INSERT INTO uom_canonical (name, full_name, gst_uom_code, sort_order) VALUES
  ('Pcs',   'Pieces',       'PCS', 1),
  ('Nos',   'Numbers',      'NOS', 2),
  ('Set',   'Sets',         'SET', 3),
  ('Pair',  'Pairs',        'PAR', 4),
  ('Doz',   'Dozens',       'DOZ', 5),
  ('Kg',    'Kilograms',    'KGS', 6),
  ('Gm',    'Grams',        'GMS', 7),
  ('Mtr',   'Metres',       'MTR', 8),
  ('Ft',    'Feet',         'FT',  9),
  ('Sq Ft', 'Square Feet',  'SQF', 10),
  ('Ltr',   'Litres',       'LTR', 11),
  ('Ml',    'Millilitres',  'MLT', 12),
  ('Box',   'Boxes',        'BOX', 13),
  ('Bag',   'Bags',         'BAG', 14),
  ('Roll',  'Rolls',        'ROL', 15),
  ('Bdl',   'Bundles',      'BDL', 16),
  ('Bal',   'Bales',        'BAL', 17),
  ('Tray',  'Trays',        'TRY', 18),
  ('Pkt',   'Packets',      'PKT', 19),
  ('Sht',   'Sheets',       'SHT', 20),
  ('Strp',  'Strips',       'STP', 21),
  ('Tube',  'Tubes',        'TBE', 22),
  ('Tin',   'Tins',         'TIN', 23),
  ('Can',   'Cans',         'CAN', 24),
  ('Coil',   'Coils',         'COL', 25),
  ('Drum',   'Drums',         'DRM', 26),
  ('Sq Mtr', 'Square Metres', 'SQM', 27)
ON CONFLICT (name) DO NOTHING;

-- ── Seed global aliases (company_id = NULL) ──────────────────────────────────────────
INSERT INTO uom_alias (alias, canonical_id, company_id)
SELECT a.alias, c.id, NULL
FROM (VALUES
  -- Pcs
  ('PCS','Pcs'),('pcs','Pcs'),('Pc','Pcs'),('pc','Pcs'),('PC','Pcs'),
  ('Pcs.','Pcs'),('pcs.','Pcs'),('Pc.','Pcs'),('PC.','Pcs'),
  ('Piece','Pcs'),('Pieces','Pcs'),('Each','Pcs'),('EACH','Pcs'),('each','Pcs'),
  ('PANEL','Pcs'),('PANELS','Pcs'),('Unit','Pcs'),('Units','Pcs'),('UNIT','Pcs'),
  -- Nos
  ('NOS','Nos'),('nos','Nos'),('Number','Nos'),('Numbers','Nos'),('Num','Nos'),('NUM','Nos'),
  ('N','Nos'),('NO','Nos'),('No','Nos'),('No.','Nos'),('NO.','Nos'),
  ('NOS.','Nos'),('Nos.','Nos'),('nos.','Nos'),
  -- Set
  ('SET','Set'),('set','Set'),('Sets','Set'),('SETS','Set'),
  -- Pair
  ('PAIR','Pair'),('pair','Pair'),('Pairs','Pair'),('Pr','Pair'),('PR','Pair'),
  -- Doz
  ('DOZ','Doz'),('doz','Doz'),('Dozen','Doz'),('Dozens','Doz'),('DZN','Doz'),
  -- Kg
  ('KG','Kg'),('kg','Kg'),('Kgs','Kg'),('KGS','Kg'),
  ('KG.','Kg'),('Kgs.','Kg'),('KGS.','Kg'),
  ('Kilogram','Kg'),('Kilograms','Kg'),
  -- Gm
  ('GM','Gm'),('gm','Gm'),('g','Gm'),('Gram','Gm'),('Grams','Gm'),('GMS','Gm'),
  -- Mtr
  ('MTR','Mtr'),('mtr','Mtr'),('Meter','Mtr'),('Meters','Mtr'),('Metre','Mtr'),('Metres','Mtr'),
  -- Ft
  ('FT','Ft'),('ft','Ft'),('FEET','Ft'),('Feet','Ft'),('foot','Ft'),('Foot','Ft'),
  -- Sq Ft
  ('SQ FT','Sq Ft'),('sq ft','Sq Ft'),('Sqft','Sq Ft'),('Sqft.','Sq Ft'),
  ('SQFT','Sq Ft'),('SQFT.','Sq Ft'),('Sq. Ft.','Sq Ft'),
  -- Sq Mtr
  ('Sq.Mtr','Sq Mtr'),('SQ MTR','Sq Mtr'),('sq mtr','Sq Mtr'),
  ('SqMtr','Sq Mtr'),('Sq. Mtr.','Sq Mtr'),('SQM','Sq Mtr'),
  -- Ltr
  ('LTR','Ltr'),('ltr','Ltr'),('L','Ltr'),('Litre','Ltr'),('Litres','Ltr'),
  ('Liter','Ltr'),('Liters','Ltr'),('LTR.','Ltr'),('LTRS','Ltr'),('LTRS.','Ltr'),
  -- Ml
  ('ML','Ml'),('ml','Ml'),('Millilitre','Ml'),('Milliliter','Ml'),
  -- Box
  ('BOX','Box'),('box','Box'),('Boxes','Box'),('BOXES','Box'),
  ('Carton','Box'),('CARTON','Box'),('Cartons','Box'),('CTN','Box'),('ctn','Box'),
  -- Bag
  ('BAG','Bag'),('bag','Bag'),('Bags','Bag'),('BAGS','Bag'),
  -- Roll
  ('ROLL','Roll'),('roll','Roll'),('Rolls','Roll'),('ROLLS','Roll'),
  -- Bdl
  ('BUNDLE','Bdl'),('Bundle','Bdl'),('Bundles','Bdl'),('BDL','Bdl'),('bdl','Bdl'),
  -- Bal
  ('BALE','Bal'),('Bale','Bal'),('Bales','Bal'),('BAL','Bal'),
  -- Tray
  ('TRAY','Tray'),('Trays','Tray'),('TRAYS','Tray'),
  -- Pkt
  ('PACKET','Pkt'),('Packet','Pkt'),('Packets','Pkt'),('PKT','Pkt'),
  ('Pkt.','Pkt'),('PKT.','Pkt'),('pkt','Pkt'),('Pack','Pkt'),('PACK','Pkt'),
  ('Pkgs','Pkt'),('PKGS','Pkt'),('Pkg','Pkt'),('PKG','Pkt'),
  -- Sht
  ('SHEET','Sht'),('Sheet','Sht'),('Sheets','Sht'),('SHT','Sht'),
  -- Strp
  ('STRIP','Strp'),('Strip','Strp'),('Strips','Strp'),
  -- Tube
  ('TUBE','Tube'),('Tubes','Tube'),
  -- Tin
  ('TIN','Tin'),('Tins','Tin'),
  -- Can
  ('CAN','Can'),('Cans','Can'),('CANS','Can'),
  -- Pair/Doz
  ('pairs','Pair'),('dozen','Doz'),
  -- Drum (new)
  ('DRM','Drum'),('drm','Drum'),('DRUM','Drum'),('Drums','Drum'),
  -- Coil (new)
  ('COIL','Coil'),('coil','Coil'),('Coils','Coil'),('COILS','Coil'),
  -- Sq Mtr aliases already above
  ('Sq Mtr','Sq Mtr')  -- canonical self-alias for lookup consistency
) AS a(alias, canonical_name)
JOIN uom_canonical c ON c.name = a.canonical_name
ON CONFLICT (alias, company_id) DO NOTHING;

-- RLS: all authenticated users can read; only service role can write
ALTER TABLE uom_canonical ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_pending_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uom_canonical_read" ON uom_canonical
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "uom_alias_read" ON uom_alias
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "uom_pending_review_company" ON uom_pending_review
  FOR ALL TO authenticated
  USING (company_id IN (
    SELECT id FROM companies WHERE created_by = auth.uid()
  ));
