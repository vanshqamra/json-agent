/**
 * Variant Table Assembler — v2
 * - Smarter header detection (fuzzy + alias map + fallbacks)
 * - Multi-line row assembly with a tiny state machine
 * - Flexible delimiters and KV fallback
 * - Aggressive column normalization (code/CAS/HSN/grade/brand/pack/price/etc.)
 * - Packs canonicalization: {qty, unit} + string
 * - Price pipeline: mrp, list, unit_price, discount, net
 * - Stronger dedupe keys and soft-merge logic
 */

const ALIASES = {
  // codes
  'cat no': 'code', 'cat. no': 'code', 'catalog no': 'code', 'cat#': 'code',
  'catalogue no': 'code', 'article no': 'code', 'art no': 'code', 'item code': 'code',
  'product code': 'code', 'code': 'code', 'sku': 'code', 'part no': 'code',

  // packaging / size
  'pack': 'pack_size', 'pack size': 'pack_size', 'packaging': 'pack_size',
  'packing': 'pack_size', 'size': 'size', 'quantity': 'qty', 'qty': 'qty',
  'uom': 'uom', 'unit': 'uom', 'capacity': 'capacity', 'volume': 'capacity',

  // money
  'mrp': 'price_mrp', 'price': 'price_mrp', 'rate': 'price_mrp',
  'list price': 'price_list', 'unit price': 'price_unit', 'unit cost': 'price_unit',
  'discount': 'discount', 'disc%': 'discount', 'net': 'price_net', 'amount': 'price_net',

  // identity/meta
  'cas': 'cas', 'cas no': 'cas', 'cas no.': 'cas', 'hsn': 'hsn', 'hs code': 'hsn',
  'hs code': 'hsn', 'ean': 'ean', 'isbn': 'ean', 'brand': 'brand', 'make': 'brand',
  'manufacturer': 'brand', 'grade': 'grade', 'purity': 'purity',
  'description': 'desc', 'desc': 'desc',

  // glassware & lab specifics
  'joint': 'joint', 'joint size': 'joint', 'neck': 'joint',
  'diameter': 'diameter', 'length': 'length', 'width': 'width', 'height': 'height',
  'od': 'diameter', 'id': 'inner_diameter', 'thread': 'thread', 'standard': 'standard',
  'complies': 'compliance', 'compliance': 'compliance'
};

const HEADER_ROW_RE =
  /(cat\.?\s*no|catalog|cat#|article|item code|sku|code|pack(?:ing| size)?|mrp|price|rate|hsn|cas|grade|brand|unit price|discount|net)/i;

const KV_RE = /([A-Za-z][A-Za-z\s\.\/%-]{1,40})[:=]\s*([^|,;]+)/g;
const SPLIT_RE = /\s{2,}|\s\|\s|\t|,(?!\s*\d{3}\b)|;|\|/;

const NUM_RE = /[\d]+(?:,\d{3})*(?:\.\d+)?/;
const PRICE_HINT_RE = /(?:₹|rs\.?|inr|usd|eur|mrp|price|rate|net|amount)/i;
const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const HSN_RE = /\b\d{4,8}\b/;
const PACK_RE = /\b(\d+(?:\.\d+)?)\s*(ml|l|litre|g|gm|kg|mm|cm|inch|pcs|pc|nos|bottle|jar|pkt|pack)\b/i;
const JOINT_RE = /\b(\d{1,2}\/\d{2})\b/; // e.g., 24/29

function normKey(k) {
  const key = String(k).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.:]$/, '');
  return ALIASES[key] || key;
}

function canonicalPack(str) {
  const s = String(str || '').trim();
  const m = s.match(PACK_RE);
  if (!m) return { pack_size: s || null, pack_qty: null, pack_unit: null };
  const qty = Number(m[1]);
  const unit = m[2].toLowerCase();
  return { pack_size: s, pack_qty: isFinite(qty) ? qty : null, pack_unit: unit };
}

function toNumberish(x) {
  if (x == null) return null;
  const n = String(x).match(NUM_RE);
  if (!n) return null;
  const val = Number(n[0].replace(/,/g, ''));
  return isFinite(val) ? val : null;
}

function extractHeader(line) {
  const cols = line.split(SPLIT_RE).map(s => s.trim()).filter(Boolean);
  const normalized = cols.map(normKey);
  // Deduplicate consecutive dupes (e.g., "Price | Price")
  const out = [];
  for (const c of normalized) {
    if (out.length === 0 || out[out.length - 1] !== c) out.push(c);
  }
  return out;
}

function rowToVariant(line, header, carry) {
  const variant = {};
  let cols = line.split(SPLIT_RE).map(s => s.trim()).filter(Boolean);

  if (header && cols.length >= 2) {
    const width = Math.min(header.length, cols.length);
    for (let i = 0; i < width; i++) {
      const k = header[i];
      if (!k) continue;
      const v = cols[i];
      if (!v) continue;
      variant[k] = v;
    }
  } else {
    let m;
    while ((m = KV_RE.exec(line)) !== null) {
      const k = normKey(m[1]);
      const v = (m[2] || '').trim();
      if (k) variant[k] = v;
    }
    // opportunistic single-line hints
    if (!variant.code) {
      const codeGuess = line.split(/\s+/).find(tok => /^[A-Z]{1,4}[\-\s]?\d{2,8}[A-Z]?$/.test(tok));
      if (codeGuess) variant.code = codeGuess;
    }
  }

  // enrich / canonicalize
  if (variant.price_mrp && !variant.price_mrp_value) {
    variant.price_mrp_value = toNumberish(variant.price_mrp);
  }
  if (variant.price_list && !variant.price_list_value) {
    variant.price_list_value = toNumberish(variant.price_list);
  }
  if (variant.price_unit && !variant.price_unit_value) {
    variant.price_unit_value = toNumberish(variant.price_unit);
  }
  if (variant.price_net && !variant.price_net_value) {
    variant.price_net_value = toNumberish(variant.price_net);
  }
  if (variant.discount && !variant.discount_value) {
    const v = toNumberish(variant.discount);
    variant.discount_value = v;
  }

  if (variant.cas) {
    const m = String(variant.cas).match(CAS_RE);
    if (m) variant.cas = m[0]; else delete variant.cas;
  }
  if (variant.hsn) {
    const m = String(variant.hsn).match(HSN_RE);
    if (m) variant.hsn = m[0];
  }

  // pack canonicalization
  const packSrc = variant.pack_size || variant.size || variant.qty;
  const { pack_size, pack_qty, pack_unit } = canonicalPack(packSrc);
  if (pack_size) variant.pack_size = pack_size;
  if (pack_qty != null) variant.pack_qty = pack_qty;
  if (pack_unit) variant.pack_unit = pack_unit;

  // glassware specifics
  const joint = variant.joint || (line.match(JOINT_RE) || [])[0];
  if (joint) variant.joint = joint;

  // carry-over for multi-line rows (e.g., code on line 1, price on line 2)
  if (carry && carry.code && !variant.code) variant.code = carry.code;
  if (carry && carry.pack_size && !variant.pack_size) Object.assign(variant, {
    pack_size: carry.pack_size, pack_qty: carry.pack_qty, pack_unit: carry.pack_unit
  });
  if (carry && carry.brand && !variant.brand) variant.brand = carry.brand;
  if (carry && carry.grade && !variant.grade) variant.grade = carry.grade;

  // price inference if only one price-like token exists
  if (!variant.price_mrp && PRICE_HINT_RE.test(line)) {
    const n = toNumberish(line);
    if (n != null) { variant.price_mrp = String(n); variant.price_mrp_value = n; }
  }

  // cleanup empty strings
  for (const k of Object.keys(variant)) {
    if (variant[k] === '') delete variant[k];
  }
  return variant;
}

function bestHeaderCandidate(blocks) {
  // scan a window for header-like rows with alias coverage
  const candidates = [];
  for (const bl of blocks) {
    if (HEADER_ROW_RE.test(bl.text)) {
      const cols = extractHeader(bl.text);
      const score = cols.reduce((s, c) => s + (c ? 1 : 0), 0);
      candidates.push({ cols, score });
    }
  }
  // fallback: return the widest
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.cols || null;
}

export function assembleVariants(group, options = {}) {
  const collection = Array.isArray(group) ? group : [group];

  for (const g of collection) {
    const header = bestHeaderCandidate(g.blocks) || g.specs_headers || null;
    const variants = [];
    const state = { carry: null }; // carry partial row across lines

    for (const bl of g.blocks) {
      if (HEADER_ROW_RE.test(bl.text)) {
        // refresh header in-stream
        const h = extractHeader(bl.text);
        if (h && h.length) g.specs_headers = header || h;
        continue;
      }

      if (bl.type === 'table_row' || bl.type === 'spec_row' || bl.type === 'sku' || bl.type === 'price') {
        const v = rowToVariant(bl.text, header, state.carry);

        // If too sparse, treat as partial and carry forward
        const density = Object.keys(v).length;
        const hasAnySignal = v.code || v.pack_size || v.price_mrp || v.price_unit || v.cas;
        if (density <= 1 && hasAnySignal) {
          // Update carry with whatever we found
          state.carry = { ...(state.carry || {}), ...v };
          continue;
        }

        // Merge with carry if it looks like a continuation (e.g., price-only line)
        if (state.carry && (v.price_mrp || v.price_unit || v.price_net) && !v.code) {
          const merged = { ...state.carry, ...v };
          variants.push(merged);
          state.carry = null;
        } else if (density > 0) {
          variants.push(v);
          state.carry = null;
        }
      }
    }

    // If something remained carried, push it as a final best-effort variant
    if (state.carry && Object.keys(state.carry).length) {
      variants.push(state.carry);
      state.carry = null;
    }

    // Deduping: robust key including normalized code + pack + grade/brand + numeric price
    const seen = new Set();
    g.variants = variants.filter(v => {
      const code = String(v.code || '').replace(/[\s\-]/g, '').toUpperCase();
      const pack = String(v.pack_size || '').toLowerCase();
      const grade = String(v.grade || '').toLowerCase();
      const brand = String(v.brand || '').toLowerCase();
      const price = v.price_mrp_value ?? v.price_unit_value ?? v.price_net_value ?? '';
      const key = [code, pack, grade, brand, price].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ensure group headers retained
    g.specs_headers = header || g.specs_headers || null;
  }
  return Array.isArray(group) ? collection : collection[0];
}
