/**
 * UOM Registry — canonical units, alias resolution, and normalization.
 *
 * The registry mirrors the uom_canonical / uom_alias DB tables seeded in
 * migration 035.  Runtime normalization uses this in-memory map so that
 * every call is synchronous and zero-latency.  The DB tables are the
 * governance layer (audit trail, future approval workflow); this file is
 * the execution layer.
 *
 * Adding a new canonical or alias:
 *   1. Add to CANONICAL_UOMS and/or ALIAS_MAP below.
 *   2. Add a matching INSERT to 035_uom_registry.sql (or a new migration).
 */

export interface CanonicalUom {
  name: string;       // e.g. "Pcs"   — stored in DB and sent to Tally
  fullName: string;   // e.g. "Pieces" — Tally ORIGINALNAME
  gstCode: string;    // e.g. "PCS"   — GST reporting code
}

export const CANONICAL_UOMS: CanonicalUom[] = [
  { name: 'Pcs',   fullName: 'Pieces',       gstCode: 'PCS' },
  { name: 'Nos',   fullName: 'Numbers',      gstCode: 'NOS' },
  { name: 'Set',   fullName: 'Sets',         gstCode: 'SET' },
  { name: 'Pair',  fullName: 'Pairs',        gstCode: 'PAR' },
  { name: 'Doz',   fullName: 'Dozens',       gstCode: 'DOZ' },
  { name: 'Kg',    fullName: 'Kilograms',    gstCode: 'KGS' },
  { name: 'Gm',    fullName: 'Grams',        gstCode: 'GMS' },
  { name: 'Mtr',   fullName: 'Metres',       gstCode: 'MTR' },
  { name: 'Ft',    fullName: 'Feet',         gstCode: 'FT'  },
  { name: 'Sq Ft', fullName: 'Square Feet',  gstCode: 'SQF' },
  { name: 'Ltr',   fullName: 'Litres',       gstCode: 'LTR' },
  { name: 'Ml',    fullName: 'Millilitres',  gstCode: 'MLT' },
  { name: 'Box',   fullName: 'Boxes',        gstCode: 'BOX' },
  { name: 'Bag',   fullName: 'Bags',         gstCode: 'BAG' },
  { name: 'Roll',  fullName: 'Rolls',        gstCode: 'ROL' },
  { name: 'Bdl',   fullName: 'Bundles',      gstCode: 'BDL' },
  { name: 'Bal',   fullName: 'Bales',        gstCode: 'BAL' },
  { name: 'Tray',  fullName: 'Trays',        gstCode: 'TRY' },
  { name: 'Pkt',   fullName: 'Packets',      gstCode: 'PKT' },
  { name: 'Sht',   fullName: 'Sheets',       gstCode: 'SHT' },
  { name: 'Strp',  fullName: 'Strips',       gstCode: 'STP' },
  { name: 'Tube',   fullName: 'Tubes',          gstCode: 'TBE' },
  { name: 'Tin',   fullName: 'Tins',           gstCode: 'TIN' },
  { name: 'Can',   fullName: 'Cans',           gstCode: 'CAN' },
  // New canonicals approved 2026-06-15
  { name: 'Coil',   fullName: 'Coils',         gstCode: 'COL' },
  { name: 'Drum',   fullName: 'Drums',         gstCode: 'DRM' },
  { name: 'Sq Mtr', fullName: 'Square Metres', gstCode: 'SQM' },
];

// Canonical names indexed for O(1) lookup
const CANONICAL_INDEX = new Map<string, CanonicalUom>(
  CANONICAL_UOMS.map((c) => [c.name, c]),
);

// Alias → canonical name mapping (must mirror uom_alias seed in migration 035)
const ALIAS_MAP: Record<string, string> = {
  // Pcs
  'PCS': 'Pcs', 'pcs': 'Pcs', 'Pc': 'Pcs', 'pc': 'Pcs', 'PC': 'Pcs',
  'Pcs.': 'Pcs', 'pcs.': 'Pcs', 'Pc.': 'Pcs', 'PC.': 'Pcs',
  'Piece': 'Pcs', 'Pieces': 'Pcs', 'Each': 'Pcs', 'EACH': 'Pcs', 'each': 'Pcs',
  'PANEL': 'Pcs', 'PANELS': 'Pcs', 'Unit': 'Pcs', 'Units': 'Pcs', 'UNIT': 'Pcs',
  // Nos
  'NOS': 'Nos', 'nos': 'Nos', 'Number': 'Nos', 'Numbers': 'Nos',
  'Num': 'Nos', 'NUM': 'Nos',
  'N': 'Nos', 'NO': 'Nos', 'No': 'Nos', 'No.': 'Nos', 'NO.': 'Nos',
  'NOS.': 'Nos', 'Nos.': 'Nos', 'nos.': 'Nos',
  // Set
  'SET': 'Set', 'set': 'Set', 'Sets': 'Set', 'SETS': 'Set',
  // Pair
  'PAIR': 'Pair', 'pair': 'Pair', 'Pairs': 'Pair', 'pairs': 'Pair',
  'Pr': 'Pair', 'PR': 'Pair',
  // Doz
  'DOZ': 'Doz', 'doz': 'Doz', 'Dozen': 'Doz', 'dozen': 'Doz',
  'Dozens': 'Doz', 'DZN': 'Doz',
  // Kg
  'KG': 'Kg', 'kg': 'Kg', 'Kgs': 'Kg', 'KGS': 'Kg',
  'KG.': 'Kg', 'Kgs.': 'Kg', 'KGS.': 'Kg',
  'Kilogram': 'Kg', 'Kilograms': 'Kg',
  // Gm
  'GM': 'Gm', 'gm': 'Gm', 'g': 'Gm', 'Gram': 'Gm', 'Grams': 'Gm', 'GMS': 'Gm',
  // Mtr
  'MTR': 'Mtr', 'mtr': 'Mtr', 'Meter': 'Mtr', 'Meters': 'Mtr',
  'Metre': 'Mtr', 'Metres': 'Mtr',
  // Ft
  'FT': 'Ft', 'ft': 'Ft', 'FEET': 'Ft', 'Feet': 'Ft', 'foot': 'Ft', 'Foot': 'Ft',
  // Sq Ft
  'SQ FT': 'Sq Ft', 'sq ft': 'Sq Ft', 'Sqft': 'Sq Ft', 'Sqft.': 'Sq Ft',
  'SQFT': 'Sq Ft', 'SQFT.': 'Sq Ft', 'Sq. Ft.': 'Sq Ft',
  // Sq Mtr
  'Sq.Mtr': 'Sq Mtr', 'SQ MTR': 'Sq Mtr', 'sq mtr': 'Sq Mtr',
  'SqMtr': 'Sq Mtr', 'Sq. Mtr.': 'Sq Mtr', 'SQM': 'Sq Mtr',
  // Ltr
  'LTR': 'Ltr', 'ltr': 'Ltr', 'L': 'Ltr', 'Litre': 'Ltr', 'Litres': 'Ltr',
  'Liter': 'Ltr', 'Liters': 'Ltr', 'LTR.': 'Ltr', 'LTRS': 'Ltr', 'LTRS.': 'Ltr',
  // Ml
  'ML': 'Ml', 'ml': 'Ml', 'Millilitre': 'Ml', 'Milliliter': 'Ml',
  // Box
  'BOX': 'Box', 'box': 'Box', 'Boxes': 'Box', 'BOXES': 'Box',
  'Carton': 'Box', 'CARTON': 'Box', 'Cartons': 'Box', 'CTN': 'Box', 'ctn': 'Box',
  // Bag
  'BAG': 'Bag', 'bag': 'Bag', 'Bags': 'Bag', 'BAGS': 'Bag',
  // Roll
  'ROLL': 'Roll', 'roll': 'Roll', 'Rolls': 'Roll', 'ROLLS': 'Roll',
  // Bdl
  'BUNDLE': 'Bdl', 'Bundle': 'Bdl', 'Bundles': 'Bdl', 'BDL': 'Bdl', 'bdl': 'Bdl',
  // Bal
  'BALE': 'Bal', 'Bale': 'Bal', 'Bales': 'Bal', 'BAL': 'Bal',
  // Tray
  'TRAY': 'Tray', 'Trays': 'Tray', 'TRAYS': 'Tray',
  // Pkt
  'PACKET': 'Pkt', 'Packet': 'Pkt', 'Packets': 'Pkt', 'PKT': 'Pkt',
  'Pkt.': 'Pkt', 'PKT.': 'Pkt', 'pkt': 'Pkt', 'Pack': 'Pkt', 'PACK': 'Pkt',
  'Pkgs': 'Pkt', 'PKGS': 'Pkt', 'Pkg': 'Pkt', 'PKG': 'Pkt',
  // Sht
  'SHEET': 'Sht', 'Sheet': 'Sht', 'Sheets': 'Sht', 'SHT': 'Sht',
  // Strp
  'STRIP': 'Strp', 'Strip': 'Strp', 'Strips': 'Strp',
  // Tube
  'TUBE': 'Tube', 'Tubes': 'Tube',
  // Tin
  'TIN': 'Tin', 'Tins': 'Tin',
  // Can
  'CAN': 'Can', 'Cans': 'Can', 'CANS': 'Can',
  // Drum (new canonical)
  'DRM': 'Drum', 'drm': 'Drum', 'DRUM': 'Drum', 'Drum': 'Drum', 'Drums': 'Drum',
  // Coil (new canonical — no aliases needed beyond case variants)
  'COIL': 'Coil', 'coil': 'Coil', 'Coils': 'Coil', 'COILS': 'Coil',
};

export interface NormalizeResult {
  /** The canonical UOM name to store/display/export. */
  canonical: string;
  /** True if the raw value was in the registry (alias or canonical). */
  isKnown: boolean;
  /** Numeric prefix stripped from the raw value, e.g. "5" from "5 Pcs". */
  numericPrefix: number | null;
}

/**
 * Normalise a raw UOM string to its canonical form.
 *
 * Resolution order:
 *   1. Strip numeric prefix ("5 Pcs" → work with "Pcs", capture 5)
 *   2. Exact canonical match ("Pcs" → "Pcs")
 *   3. Alias map lookup ("PCS" → "Pcs")
 *   4. Unknown — return raw value as-is, isKnown = false
 *
 * Never returns null/undefined; the caller decides what to do with isKnown=false.
 */
export function normalizeUom(raw: string | null | undefined): NormalizeResult {
  if (!raw || !raw.trim()) {
    return { canonical: 'Nos', isKnown: true, numericPrefix: null };
  }

  const trimmed = raw.trim();

  // Strip numeric prefix: "5 Pcs" → prefix=5, remainder="Pcs"
  const numMatch = trimmed.match(/^(\d+)\s+(.+)$/);
  let numericPrefix: number | null = null;
  let uomStr = trimmed;
  if (numMatch) {
    numericPrefix = Number(numMatch[1]);
    uomStr = numMatch[2].trim();
  }

  // Exact canonical match
  if (CANONICAL_INDEX.has(uomStr)) {
    return { canonical: uomStr, isKnown: true, numericPrefix };
  }

  // Alias lookup
  const fromAlias = ALIAS_MAP[uomStr];
  if (fromAlias) {
    return { canonical: fromAlias, isKnown: true, numericPrefix };
  }

  // Unknown — return raw (stripped of numeric prefix) unchanged
  return { canonical: uomStr, isKnown: false, numericPrefix };
}

/** Return the CanonicalUom definition for a canonical name, or null. */
export function getCanonical(name: string): CanonicalUom | null {
  return CANONICAL_INDEX.get(name) ?? null;
}

/**
 * Resolve the final UOM for XML/display using master-first precedence:
 *   1. Stock Item Master UOM (if set)
 *   2. Invoice line item UOM (normalised)
 *   3. Default "Nos"
 */
export function resolveUom(
  masterUnit: string | null | undefined,
  invoiceUom: string | null | undefined,
): string {
  if (masterUnit && masterUnit.trim()) {
    // Master is set — normalise it (handles any legacy non-canonical values in master)
    const { canonical } = normalizeUom(masterUnit);
    return canonical;
  }
  // Fall through to invoice UOM
  if (invoiceUom && invoiceUom.trim()) {
    const { canonical } = normalizeUom(invoiceUom);
    return canonical;
  }
  return 'Nos';
}
