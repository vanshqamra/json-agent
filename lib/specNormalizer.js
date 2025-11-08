import { maybeEscalateWithLLM } from './llmAssist.js';

const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const EC_RE = /\b\d{3}-\d{3}-\d\b/;
const HSN_RE = /\b(\d{4}\.\d{2}|\d{6,8})\b/;
const CURRENCY_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)\s*/i;
const PCT_RE = /\b(\d{2,3}(?:\.\d+)?)\s*%\b/;

const GRADE_MAP = new Map([
  ['AR', 'AR'],
  ['Analytical Reagent', 'AR'],
  ['LR', 'LR'],
  ['Laboratory Reagent', 'LR'],
  ['EP', 'EP'],
  ['Extra Pure', 'EP'],
  ['Extra-Pure', 'EP'],
  ['ACS', 'ACS'],
  ['HPLC', 'HPLC'],
  ['GC', 'GC'],
  ['GC-HS', 'GC-HS'],
  ['Reagent Grade', 'RG'],
  ['Pharma Grade', 'Pharma'],
  ['Pharmaceutical Grade', 'Pharma']
]);

const UOM = {
  ml: { k: 'volume_ml', m: 1 },
  mL: { k: 'volume_ml', m: 1 },
  l: { k: 'volume_ml', m: 1000 },
  L: { k: 'volume_ml', m: 1000 },
  ul: { k: 'volume_ml', m: 0.001 },
  'µl': { k: 'volume_ml', m: 0.001 },
  g: { k: 'mass_g', m: 1 },
  gm: { k: 'mass_g', m: 1 },
  kg: { k: 'mass_g', m: 1000 },
  mg: { k: 'mass_g', m: 0.001 }
};

function normCurrency(raw = '') {
  if (!raw) return { currency: 'INR', value: null, raw };
  const currency = /€|eur/i.test(raw)
    ? 'EUR'
    : /\$|usd/i.test(raw)
    ? 'USD'
    : 'INR';
  const num = Number(String(raw).replace(CURRENCY_RE, '').replace(/[, ]/g, ''));
  return Number.isFinite(num)
    ? { currency, value: num, raw }
    : { currency, value: null, raw };
}

function parsePack(src = '') {
  const m = String(src).match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|mL|l|L|g|gm|kg|mg|µl|ul)\b/);
  if (!m) return null;
  const multiplier = m[1] ? Number(m[1]) : 1;
  const qty = Number(m[2]);
  const unit = m[3];
  const map = UOM[unit] || UOM[unit?.toLowerCase()];
  if (!map || !Number.isFinite(qty)) return null;
  const base = qty * map.m;
  return { multiplier, unit, qty, kind: map.k, base, base_total: base * multiplier };
}

function normalizeGrade(value) {
  if (!value) return null;
  for (const [key, mapped] of GRADE_MAP.entries()) {
    if (new RegExp(`^${key}$`, 'i').test(String(value).trim())) return mapped;
  }
  return String(value).trim().toUpperCase();
}

function pct(src) {
  const match = String(src || '').match(PCT_RE);
  return match ? Number(match[1]) : null;
}

export async function normalizeGroup(group, opts = {}) {
  const warn = message => {
    group._warnings = group._warnings || [];
    if (!group._warnings.includes(message)) group._warnings.push(message);
  };

  for (const variant of group.variants) {
    if (variant.code) {
      variant.code_original = variant.code;
      variant.code = String(variant.code).trim().replace(/\s+/g, '').toUpperCase();
      if (!/[A-Z0-9]/.test(variant.code)) delete variant.code;
    }

    const priceCandidate =
      variant.price_mrp ??
      variant.price ??
      variant.mrp ??
      variant.price_mrp_value ??
      null;
    if (priceCandidate != null) {
      const normalizedPrice = normCurrency(String(priceCandidate));
      if (normalizedPrice.value != null) {
        variant.price_mrp_value = normalizedPrice.value;
        variant.price_currency = normalizedPrice.currency;
      } else {
        delete variant.price_mrp_value;
      }
    }

    const packSource =
      variant.pack_size || variant.size || variant.description || group.description || '';
    const pack = parsePack(packSource);
    if (pack) {
      variant.pack = pack;
      if (!variant.pack_size) {
        const qty = Number.isFinite(pack.qty) ? pack.qty : '';
        variant.pack_size = `${pack.multiplier}x ${qty} ${pack.unit}`.trim();
      }
    }

    if (variant.grade) variant.grade = normalizeGrade(variant.grade);
    if (variant.purity && variant.purity_value == null) {
      const parsed = pct(variant.purity);
      if (parsed != null) variant.purity_value = parsed;
    }

    const haystack =
      Object.values(variant)
        .filter(v => typeof v === 'string')
        .join(' | ') +
      ' | ' +
      (group.description || '');

    const casMatch = haystack.match(CAS_RE);
    if (casMatch) variant.cas = casMatch[0];
    const ecMatch = haystack.match(EC_RE);
    if (ecMatch) variant.ec = ecMatch[0];
    const hsnMatch = haystack.match(HSN_RE);
    if (!variant.hsn && hsnMatch) variant.hsn = hsnMatch[0];
    if (variant.cas && !CAS_RE.test(String(variant.cas))) delete variant.cas;
  }

  const sparse = group.variants.filter(v => !v.pack_size && !v.grade && !v.purity && !v.price_mrp_value);
  if (sparse.length && sparse.length >= Math.ceil(group.variants.length * 0.6)) {
    try {
      const hint = await maybeEscalateWithLLM(
        { groupTitle: group.title || group.product || '', sample: sparse.slice(0, 3) },
        'normalize_missing_fields'
      );
      if (hint?.hint) warn(`llm_hint: ${hint.hint}`);
    } catch (err) {
      warn('llm_hint_error: ' + (err?.message || String(err)));
    }
  }

  if (!group.description && group.notes?.length) {
    group.description = group.notes.join('\n');
  }

  return group;
}

export async function normalizeGroupSpecs(input, opts = {}) {
  if (Array.isArray(input)) {
    const results = [];
    for (const group of input) {
      results.push(await normalizeGroup(group, opts));
    }
    return results;
  }
  return normalizeGroup(input, opts);
}
