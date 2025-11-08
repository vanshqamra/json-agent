const HEADER_MAP = new Map([
  ['capacity (ml)', 'capacity_ml'],
  ['capacity ml', 'capacity_ml'],
  ['capacity', 'capacity'],
  ['cat. no', 'code'],
  ['cat. no.', 'code'],
  ['cat no', 'code'],
  ['code', 'code'],
  ['catalogue no', 'code'],
  ['catalogue no.', 'code'],
  ['cat number', 'code'],
  ['article no', 'code'],
  ['price', 'price_inr'],
  ['price/piece', 'price_inr'],
  ['price /piece', 'price_inr'],
  ['price per piece', 'price_inr'],
  ['mrp', 'price_inr'],
  ['hsn', 'hsn'],
  ['hsn code', 'hsn'],
  ['size', 'size'],
  ['pack size', 'pack_size'],
  ['pack', 'pack_size'],
  ['description', 'description'],
  ['joint', 'joint'],
  ['neck diameter (mm)', 'neck_diameter_mm'],
  ['neck diameter mm', 'neck_diameter_mm'],
  ['height (mm)', 'height_mm'],
  ['height mm', 'height_mm'],
  ['tolerance (ml)', 'tolerance_ml'],
  ['tolerance ml', 'tolerance_ml'],
  ['volume (ml)', 'capacity_ml'],
  ['capacity (l)', 'capacity_l'],
  ['dia (mm)', 'diameter_mm'],
  ['diameter (mm)', 'diameter_mm'],
]);

export function canonicalizeHeaderName(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  if (HEADER_MAP.has(lower)) {
    return HEADER_MAP.get(lower);
  }
  const alnum = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!alnum) return '';
  return alnum;
}

export function canonicalizeHeaderList(headers = []) {
  const seen = new Set();
  const out = [];
  for (const header of headers) {
    const canonical = canonicalizeHeaderName(header);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
