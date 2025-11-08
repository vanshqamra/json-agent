// postProcessor.js — v2 "deep" pass
// Adds normalization, anomaly detection, fuzzy dedupe, cross-variant completion, confidence scoring,
// and optional escalation via LLM hints (USE_LLM + LLM_API_KEY).
import { maybeEscalateWithLLM } from "./llmAssist.js"; // optional; safe no-op if not enabled

// --- Regexes & helpers ---
const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const EC_RE  = /\b\d{3}-\d{3}-\d\b/;            // EC / EINECS format
const HSN_RE = /\b(\d{4}\.\d{2}|\d{6,8})\b/;    // common HSN shapes (4/6/8 digits, sometimes 4.2)
const UNIT_RE = /(ml|l|µl|ul|gm|g|kg|mg|mm|cm|inch|in)\b/i;
const PACK_RE = /(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|l|g|gm|kg|mg|µl|ul)\b/i;
const CURRENCY_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)\s*/i;

const UOM_MAP = {
  ml: { kind: 'volume_ml', mul: 1 },
  l:  { kind: 'volume_ml', mul: 1000 },
  ul: { kind: 'volume_ml', mul: 0.001 },  µl: { kind: 'volume_ml', mul: 0.001 },
  g:  { kind: 'mass_g',    mul: 1 },      gm: { kind: 'mass_g',    mul: 1 },
  kg: { kind: 'mass_g',    mul: 1000 },
  mg: { kind: 'mass_g',    mul: 0.001 },
};

function normCurrency(s = "") {
  if (!s) return { currency: 'INR', value: null, raw: s };
  const currency = /€|eur/i.test(s) ? 'EUR' : /\$|usd/i.test(s) ? 'USD' : 'INR';
  const num = Number(String(s).replace(CURRENCY_RE, '').replace(/[, ]/g, ''));
  return Number.isFinite(num) ? { currency, value: num, raw: s } : { currency, value: null, raw: s };
}

function parsePack(s = "") {
  const m = String(s).toLowerCase().match(PACK_RE);
  if (!m) return null;
  const mult = m[1] ? Number(m[1]) : 1;
  const qty  = Number(m[2]);
  const unit = m[3].replace('µ','u');
  const map  = UOM_MAP[unit] || UOM_MAP[unit.toLowerCase()];
  if (!map || !Number.isFinite(qty)) return null;
  const base = qty * map.mul;
  return { multiplier: mult, unit, qty, kind: map.kind, base, base_total: base * mult };
}

function median(arr) {
  const a = arr.filter(n => Number.isFinite(n)).sort((x,y)=>x-y);
  if (!a.length) return null;
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
}

function similarityStr(a = "", b = "") {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const tokensA = new Set(a.split(/[^a-z0-9]+/i).filter(Boolean));
  const tokensB = new Set(b.split(/[^a-z0-9]+/i).filter(Boolean));
  const inter = [...tokensA].filter(t => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size || 1;
  return inter / union;
}

function softEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const s = similarityStr(String(a), String(b));
  return s >= 0.85;
}

function addAudit(v, rule, action, notes) {
  v._audit = v._audit || [];
  v._audit.push({ rule, action, notes });
}

// --- Main processor ---
export async function postProcess(groups, opts = {}) {
  const PRICE_OUTLIER_SIGMA = opts.priceSigma || 2.5;
  const DEDUPE_SIM_THRESHOLD = opts.dedupeSim || 0.9;
  const CONF_LOW_THRESHOLD = opts.confLow || 0.55;

  let lastHeader = null;

  for (const g of groups) {
    g._warnings = g._warnings || [];

    // 1) Header propagation + cross-variant header completion
    if (!g.specs_headers && lastHeader) {
      g.specs_headers = lastHeader;
      g._warnings.push('specs_headers filled from previous group');
    }
    if (g.specs_headers) lastHeader = g.specs_headers;

    // 2) Merge notes into description
    if (g.notes && g.notes.length) {
      g.description = (g.description || '') + (g.description ? '\n' : '') + g.notes.join('\n');
    }

    // 3) Normalize each variant: code, price, pack, CAS/EC/HSN from any field
    const pricesPerUnit = [];
    for (const v of g.variants) {
      // Normalize code (keep original too)
      if (v.code) {
        v.code_original = v.code;
        v.code = String(v.code).trim().replace(/\s+/g, '').toUpperCase();
        if (!/[A-Z0-9]/.test(v.code)) { addAudit(v,'code','drop','non-alphanumeric'); delete v.code; }
      }

      // Price normalization from multiple sources
      const priceCandidate = v.price_mrp != null ? String(v.price_mrp)
                          : v.price != null      ? String(v.price)
                          : v.mrp != null        ? String(v.mrp)
                          : (v.price_mrp_value != null ? String(v.price_mrp_value) : null);

      if (priceCandidate != null) {
        const np = normCurrency(priceCandidate);
        if (np.value != null) {
          v.price_mrp_value = np.value;
          v.price_currency = np.currency;
          addAudit(v,'price','normalize',`= ${np.value} ${np.currency}`);
        } else {
          addAudit(v,'price','drop','unparsable');
          delete v.price_mrp_value;
        }
      }

      // Pack size parsing: prefer explicit pack_size, else infer from size/description
      const packSource = v.pack_size || v.size || v.description || g.description || '';
      const pack = parsePack(packSource);
      if (pack) {
        v.pack = pack; // structured pack info
        if (!v.pack_size) v.pack_size = `${pack.multiplier}x ${pack.qty} ${pack.unit}`;
        // If we have a valid price, compute price per base unit for anomaly checks
        if (Number.isFinite(v.price_mrp_value)) {
          const denom = pack.base_total || pack.base;
          if (denom > 0) {
            v.price_per_unit = v.price_mrp_value / denom;
            pricesPerUnit.push(v.price_per_unit);
          }
        }
      } else if (UNIT_RE.test(String(v.pack_size||'') + ' ' + String(v.size||''))) {
        // light hint
        addAudit(v,'pack','hint','unit-like text present but not parsed');
      }

      // Extract CAS/EC/HSN from any string fields (incl. aggregated raw_specs)
      const fieldTexts = [];
      for (const [k, val] of Object.entries(v)) {
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

      // Validate CAS if present
      if (v.cas && !CAS_RE.test(String(v.cas))) { addAudit(v,'cas','drop','invalid'); delete v.cas; }

      // Basic unit hint (fallback)
      if (!(v.pack_size||'').match(UNIT_RE) && (v.size||'').match(UNIT_RE)) {
        v.pack_size = v.pack_size || v.size;
        addAudit(v,'pack_size','fill','copied from size');
      }
    }

    // 4) Price outlier detection (price per base unit if we could compute it)
    const med = median(pricesPerUnit);
    if (med != null && pricesPerUnit.length >= 5) {
      for (const v of g.variants) {
        if (!Number.isFinite(v.price_per_unit)) continue;
        const ratio = v.price_per_unit / med;
        if (ratio > PRICE_OUTLIER_SIGMA || ratio < 1/PRICE_OUTLIER_SIGMA) {
          v._anomaly = v._anomaly || [];
          v._anomaly.push({ type: 'price_outlier', median: med, value: v.price_per_unit });
          addAudit(v,'anomaly','flag',`price_per_unit ratio ${ratio.toFixed(2)} vs median`);
        }
      }
    }

    // 5) Cross-variant completion (fill missing small text fields if all others agree)
    const fieldsToPropagate = ['grade','purity','hsn'];
    for (const key of fieldsToPropagate) {
      const vals = new Map();
      for (const v of g.variants) if (v[key]) vals.set(String(v[key]).toLowerCase(), (vals.get(String(v[key]).toLowerCase())||0)+1);
      const agreed = [...vals.entries()].sort((a,b)=>b[1]-a[1])[0];
      if (agreed && agreed[1] >= Math.max(2, Math.ceil(g.variants.length * 0.6))) {
        for (const v of g.variants) if (!v[key]) { v[key] = agreed[0]; addAudit(v,'propagate','fill',`${key}="${agreed[0]}"`); }
      }
    }

    // 6) Fuzzy de-duplication
    const kept = [];
    const dropped = [];
    for (const v of g.variants) {
      const sig = [
        v.code || '',
        v.cas || '',
        v.hsn || '',
        v.pack ? `${v.pack.multiplier}x${v.pack.qty}${v.pack.unit}` : (v.pack_size||''),
        (v.grade||''),
        (v.purity||''),
      ].join('|').toLowerCase();

      const dup = kept.find(k => {
        const sim = similarityStr(sig, [
          k.code || '',
          k.cas || '',
          k.hsn || '',
          k.pack ? `${k.pack.multiplier}x${k.pack.qty}${k.pack.unit}` : (k.pack_size||''),
          (k.grade||''),
          (k.purity||''),
        ].join('|').toLowerCase());
        // same code → much stricter; otherwise allow high similarity
        if (k.code && v.code && k.code === v.code) return true;
        return sim >= DEDUPE_SIM_THRESHOLD && softEqual(v.cas, k.cas) && softEqual(v.pack_size, k.pack_size);
      });

      if (dup) {
        (dup._merged_from = dup._merged_from || []).push(v);
        addAudit(dup,'dedupe','merge','fuzzy-similar variant merged');
        dropped.push(v);
      } else {
        kept.push(v);
      }
    }
    if (dropped.length) g._warnings.push(`deduped ${dropped.length} variants by fuzzy signature`);
    g.variants = kept;

    // 7) Confidence scoring per variant
    for (const v of g.variants) {
      let score = 0;
      const feats = {
        hasCode: !!v.code,
        hasPrice: Number.isFinite(v.price_mrp_value),
        hasPack: !!v.pack || UNIT_RE.test(String(v.pack_size||'')),
        validCAS: !!v.cas && CAS_RE.test(String(v.cas)),
        hasHSN: !!v.hsn,
      };
      if (feats.hasCode) score += 0.25;
      if (feats.hasPrice) score += 0.2;
      if (feats.hasPack) score += 0.2;
      if (feats.validCAS) score += 0.2;
      if (feats.hasHSN) score += 0.15;
      v._confidence = Math.min(1, Math.max(0, score));
    }

    // 8) Optional: escalate low-confidence pages to LLM for hints (non-blocking)
    try {
      const avgConf = g.variants.length
        ? g.variants.reduce((s,v)=>s+(v._confidence||0),0)/g.variants.length
        : 1;
      if (avgConf < CONF_LOW_THRESHOLD) {
        const hint = await maybeEscalateWithLLM(
          { groupTitle: g.title || g.product || g.category || '', variants: g.variants.slice(0,5) },
          'low_avg_confidence'
        );
        if (hint && hint.hint) g._warnings.push(`llm_hint: ${hint.hint}`); // safe: returns a stub unless enabled
      }
    } catch (e) {
      g._warnings.push('llm_hint_error: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // 9) Final pass: exact JSON-signature dedupe as safety net
  for (const g of groups) {
    const seen = new Set();
    g.variants = g.variants.filter(v => {
      const sig = JSON.stringify(v, Object.keys(v).sort()).replace(/\s+/g,'');
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  return groups;
}
