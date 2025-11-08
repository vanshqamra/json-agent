import { maybeEscalateWithLLM } from './llmAssist.js';

const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const EC_RE = /\b\d{3}-\d{3}-\d\b/;
const HSN_RE = /\b(\d{4}\.\d{2}|\d{6,8})\b/;
const UNIT_RE = /(ml|l|µl|ul|gm|g|kg|mg|mm|cm|inch|in)\b/i;
const CURRENCY_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)\s*/i;

function normCurrency(s = '') {
  if (!s) return { currency: 'INR', value: null, raw: s };
  const currency = /€|eur/i.test(s) ? 'EUR' : /\$|usd/i.test(s) ? 'USD' : 'INR';
  const num = Number(String(s).replace(CURRENCY_RE, '').replace(/[, ]/g, ''));
  return Number.isFinite(num) ? { currency, value: num, raw: s } : { currency, value: null, raw: s };
}

function parsePack(s = '') {
  const m = String(s).toLowerCase().match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|l|litre|g|gm|kg|mg|µl|ul)\b/);
  if (!m) return null;
  const mult = m[1] ? Number(m[1]) : 1;
  const qty = Number(m[2]);
  const unit = m[3].replace('µ', 'u');
  const map = {
    ml: { kind: 'volume_ml', mul: 1 },
    l: { kind: 'volume_ml', mul: 1000 },
    litre: { kind: 'volume_ml', mul: 1000 },
    ul: { kind: 'volume_ml', mul: 0.001 },
    gm: { kind: 'mass_g', mul: 1 },
    g: { kind: 'mass_g', mul: 1 },
    kg: { kind: 'mass_g', mul: 1000 },
    mg: { kind: 'mass_g', mul: 0.001 }
  }[unit];
  if (!map || !Number.isFinite(qty)) return null;
  const base = qty * map.mul;
  return { multiplier: mult, unit, qty, kind: map.kind, base, base_total: base * mult };
}

function median(arr) {
  const sorted = arr.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function similarityStr(a = '', b = '') {
  const normA = a.toLowerCase();
  const normB = b.toLowerCase();
  if (normA === normB) return 1;
  const tokensA = new Set(normA.split(/[^a-z0-9]+/i).filter(Boolean));
  const tokensB = new Set(normB.split(/[^a-z0-9]+/i).filter(Boolean));
  const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size || 1;
  return intersection / union;
}

function softEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return similarityStr(String(a), String(b)) >= 0.85;
}

function addAudit(v, rule, action, notes) {
  v._audit = v._audit || [];
  v._audit.push({ rule, action, notes });
}

export async function postProcess(groups, opts = {}) {
  const PRICE_OUTLIER_SIGMA = opts.priceSigma || 2.5;
  const DEDUPE_SIM_THRESHOLD = opts.dedupeSim || 0.9;
  const CONF_LOW_THRESHOLD = opts.confLow || 0.55;

  let lastHeader = null;

  for (const g of groups) {
    g._warnings = g._warnings || [];

    if (!g.specs_headers && lastHeader) {
      g.specs_headers = lastHeader;
      g._warnings.push('specs_headers filled from previous group');
    }
    if (g.specs_headers) lastHeader = g.specs_headers;

    if (g.notes && g.notes.length) {
      g.description = (g.description || '') + (g.description ? '\n' : '') + g.notes.join('\n');
    }

    const pricesPerUnit = [];
    for (const v of g.variants) {
      if (v.code) {
        v.code_original = v.code;
        v.code = String(v.code).trim().replace(/\s+/g, '').toUpperCase();
        if (!/[A-Z0-9]/.test(v.code)) {
          addAudit(v, 'code', 'drop', 'non-alphanumeric');
          delete v.code;
        }
      }

      const priceCandidate =
        v.price_mrp ??
        v.price ??
        v.mrp ??
        (v.price_mrp_value != null ? String(v.price_mrp_value) : null);
      if (priceCandidate != null) {
        const np = normCurrency(String(priceCandidate));
        if (np.value != null) {
          v.price_mrp_value = np.value;
          v.price_currency = np.currency;
          addAudit(v, 'price', 'normalize', `= ${np.value} ${np.currency}`);
        } else {
          addAudit(v, 'price', 'drop', 'unparsable');
          delete v.price_mrp_value;
        }
      }

      const packSource = v.pack_size || v.size || v.description || g.description || '';
      const pack = parsePack(packSource);
      if (pack) {
        v.pack = pack;
        if (!v.pack_size) {
          v.pack_size = `${pack.multiplier}x ${pack.qty} ${pack.unit}`;
        }
        if (Number.isFinite(v.price_mrp_value)) {
          const denom = pack.base_total || pack.base;
          if (denom > 0) {
            v.price_per_unit = v.price_mrp_value / denom;
            pricesPerUnit.push(v.price_per_unit);
          }
        }
      } else if (UNIT_RE.test(String(v.pack_size || '') + ' ' + String(v.size || ''))) {
        addAudit(v, 'pack', 'hint', 'unit-like text present but not parsed');
      }

      const fieldTexts = [];
      for (const [key, val] of Object.entries(v)) {
        if (typeof val === 'string') fieldTexts.push(val);
      }
      if (g.description) fieldTexts.push(g.description);

      const hay = fieldTexts.join(' | ');
      const casM = hay.match(CAS_RE);
      if (casM) v.cas = casM[0];
      const ecM = hay.match(EC_RE);
      if (ecM) v.ec = ecM[0];
      const hsnM = hay.match(HSN_RE);
      if (!v.hsn && hsnM) v.hsn = hsnM[0];
      if (v.cas && !CAS_RE.test(String(v.cas))) {
        addAudit(v, 'cas', 'drop', 'invalid');
        delete v.cas;
      }

      const packSizeText = v.pack_size != null ? String(v.pack_size) : '';
      const sizeText = v.size != null ? String(v.size) : '';
      if (!UNIT_RE.test(packSizeText) && UNIT_RE.test(sizeText)) {
        v.pack_size = v.pack_size || v.size;
        addAudit(v, 'pack_size', 'fill', 'copied from size');
      }
    }

    const med = median(pricesPerUnit);
    if (med != null && pricesPerUnit.length >= 5) {
      for (const v of g.variants) {
        if (!Number.isFinite(v.price_per_unit)) continue;
        const ratio = v.price_per_unit / med;
        if (ratio > PRICE_OUTLIER_SIGMA || ratio < 1 / PRICE_OUTLIER_SIGMA) {
          v._anomaly = v._anomaly || [];
          v._anomaly.push({ type: 'price_outlier', median: med, value: v.price_per_unit });
          addAudit(v, 'anomaly', 'flag', `price_per_unit ratio ${ratio.toFixed(2)} vs median`);
        }
      }
    }

    const fieldsToPropagate = ['grade', 'purity', 'hsn'];
    for (const key of fieldsToPropagate) {
      const vals = new Map();
      for (const v of g.variants) {
        if (v[key]) {
          const normalized = String(v[key]).toLowerCase();
          vals.set(normalized, (vals.get(normalized) || 0) + 1);
        }
      }
      const agreed = [...vals.entries()].sort((a, b) => b[1] - a[1])[0];
      if (agreed && agreed[1] >= Math.max(2, Math.ceil(g.variants.length * 0.6))) {
        for (const v of g.variants) {
          if (!v[key]) {
            v[key] = agreed[0];
            addAudit(v, 'propagate', 'fill', `${key}="${agreed[0]}"`);
          }
        }
      }
    }

    const kept = [];
    const dropped = [];
    for (const v of g.variants) {
      const sig = [
        v.code || '',
        v.cas || '',
        v.hsn || '',
        v.pack ? `${v.pack.multiplier}x${v.pack.qty}${v.pack.unit}` : v.pack_size || '',
        v.grade || '',
        v.purity || ''
      ].join('|').toLowerCase();

      const dup = kept.find(existing => {
        if (existing.code && v.code && existing.code === v.code) return true;
        const existingSig = [
          existing.code || '',
          existing.cas || '',
          existing.hsn || '',
          existing.pack ? `${existing.pack.multiplier}x${existing.pack.qty}${existing.pack.unit}` : existing.pack_size || '',
          existing.grade || '',
          existing.purity || ''
        ].join('|').toLowerCase();
        const sim = similarityStr(sig, existingSig);
        return sim >= DEDUPE_SIM_THRESHOLD && softEqual(v.cas, existing.cas) && softEqual(v.pack_size, existing.pack_size);
      });

      if (dup) {
        (dup._merged_from = dup._merged_from || []).push(v);
        addAudit(dup, 'dedupe', 'merge', 'fuzzy-similar variant merged');
        dropped.push(v);
      } else {
        kept.push(v);
      }
    }
    if (dropped.length) g._warnings.push(`deduped ${dropped.length} variants by fuzzy signature`);
    g.variants = kept;

    for (const v of g.variants) {
      let score = 0;
      const feats = {
        hasCode: !!v.code,
        hasPrice: Number.isFinite(v.price_mrp_value),
        hasPack: !!v.pack || UNIT_RE.test(String(v.pack_size || '')),
        validCAS: !!v.cas && CAS_RE.test(String(v.cas)),
        hasHSN: !!v.hsn
      };
      if (feats.hasCode) score += 0.25;
      if (feats.hasPrice) score += 0.2;
      if (feats.hasPack) score += 0.2;
      if (feats.validCAS) score += 0.2;
      if (feats.hasHSN) score += 0.15;
      v._confidence = Math.min(1, Math.max(0, score));
    }

    try {
      const avgConf = g.variants.length
        ? g.variants.reduce((sum, v) => sum + (v._confidence || 0), 0) / g.variants.length
        : 1;
      if (avgConf < CONF_LOW_THRESHOLD) {
        const hint = await maybeEscalateWithLLM(
          { groupTitle: g.title || g.product || g.category || '', variants: g.variants.slice(0, 5) },
          'low_avg_confidence'
        );
        if (hint && hint.hint) g._warnings.push(`llm_hint: ${hint.hint}`);
      }
    } catch (err) {
      g._warnings.push('llm_hint_error: ' + (err && err.message ? err.message : String(err)));
    }
  }

  const filtered = [];
  for (const g of groups) {
    const seen = new Set();
    g.variants = g.variants.filter(v => {
      const sig = JSON.stringify(v, Object.keys(v).sort()).replace(/\s+/g, '');
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    if ((g.variants?.length || 0) > 0) {
      filtered.push(g);
    } else {
      g._warnings = g._warnings || [];
      g._warnings.push('dropped_empty_group');
    }
  }

  return filtered;
}
