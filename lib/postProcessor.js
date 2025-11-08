// specNormalizer.js — normalizeGroup() used before final postProcess()
import { maybeEscalateWithLLM } from "./llmAssist.js";

const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const EC_RE  = /\b\d{3}-\d{3}-\d\b/;
const HSN_RE = /\b(\d{4}\.\d{2}|\d{6,8})\b/;
const CURRENCY_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)\s*/i;
const PCT_RE = /\b(\d{2,3}(?:\.\d+)?)\s*%\b/;

const GRADE_MAP = new Map([
  ['AR','AR'], ['Analytical Reagent','AR'],
  ['LR','LR'], ['Laboratory Reagent','LR'],
  ['EP','EP'], ['Extra Pure','EP'], ['Extra-Pure','EP'],
  ['ACS','ACS'], ['HPLC','HPLC'], ['GC','GC'], ['GC-HS','GC-HS'],
  ['Reagent Grade','RG'], ['Pharma Grade','Pharma'], ['Pharmaceutical Grade','Pharma']
]);

const UOM = {
  ml:{k:'volume_ml',m:1}, mL:{k:'volume_ml',m:1},
  l:{k:'volume_ml',m:1000}, L:{k:'volume_ml',m:1000},
  ul:{k:'volume_ml',m:0.001}, "µl":{k:'volume_ml',m:0.001},
  g:{k:'mass_g',m:1}, gm:{k:'mass_g',m:1},
  kg:{k:'mass_g',m:1000}, mg:{k:'mass_g',m:0.001},
};

function normCurrency(s="") {
  if (!s) return { currency:'INR', value:null, raw:s };
  const currency = /€|eur/i.test(s) ? 'EUR' : /\$|usd/i.test(s) ? 'USD' : 'INR';
  const num = Number(String(s).replace(CURRENCY_RE,'').replace(/[, ]/g,''));
  return Number.isFinite(num) ? { currency, value:num, raw:s } : { currency, value:null, raw:s };
}

function parsePack(s="") {
  const m = String(s).match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|mL|l|L|g|gm|kg|mg|µl|ul)\b/);
  if (!m) return null;
  const mult = m[1] ? Number(m[1]) : 1;
  const qty  = Number(m[2]);
  const unit = m[3];
  const map  = UOM[unit] || UOM[unit?.toLowerCase()];
  if (!map || !Number.isFinite(qty)) return null;
  const base = qty * map.m;
  return { multiplier: mult, unit, qty, kind: map.k, base, base_total: base * mult };
}

function normalizeGrade(s) {
  if (!s) return null;
  for (const [k,v] of GRADE_MAP.entries()) if (new RegExp(`^${k}$`, 'i').test(String(s).trim())) return v;
  return String(s).trim().toUpperCase();
}

function pct(s) { const m = String(s||"").match(PCT_RE); return m ? Number(m[1]) : null; }

export async function normalizeGroup(group) {
  group._warnings = group._warnings || [];

  for (const v of group.variants) {
    // code
    if (v.code) { v.code_original = v.code; v.code = String(v.code).trim().replace(/\s+/g,'').toUpperCase(); }
    if (v.code && !/[A-Z0-9]/.test(v.code)) delete v.code;

    // price
    const priceCandidate = v.price_mrp ?? v.price ?? v.mrp ?? v.price_mrp_value;
    if (priceCandidate != null) {
      const np = normCurrency(String(priceCandidate));
      if (np.value != null) { v.price_mrp_value = np.value; v.price_currency = np.currency; }
      else delete v.price_mrp_value;
    }

    // pack
    const packSource = v.pack_size || v.size || v.description || group.description || '';
    const pack = parsePack(packSource);
    if (pack) { v.pack = pack; if (!v.pack_size) v.pack_size = `${pack.multiplier}x ${pack.qty} ${pack.unit}`; }

    // grade/purity
    if (v.grade) v.grade = normalizeGrade(v.grade);
    if (v.purity && v.purity_value == null) v.purity_value = pct(v.purity);

    // CAS/EC/HSN from any strings
    const hay = Object.values(v).filter(x => typeof x === 'string').join(' | ') + ' | ' + (group.description||'');
    const casM = hay.match(CAS_RE); if (casM) v.cas = casM[0];
    const ecM  = hay.match(EC_RE);  if (ecM)  v.ec  = ecM[0];
    const hsnM = hay.match(HSN_RE); if (!v.hsn && hsnM) v.hsn = hsnM[0];
    if (v.cas && !CAS_RE.test(String(v.cas))) delete v.cas;
  }

  // Optional LLM nudge only if group is very sparse
  const needs = group.variants.filter(v => !v.pack_size && !v.grade && !v.purity && !v.price_mrp_value);
  if (needs.length >= Math.ceil(group.variants.length * 0.6)) {
    try {
      const hint = await maybeEscalateWithLLM({ groupTitle: group.title||group.product||'', sample: needs.slice(0,3) }, 'normalize_missing_fields');
      if (hint?.hint) group._warnings.push('llm_hint: ' + hint.hint);
    } catch (e) {
      group._warnings.push('llm_hint_error: ' + (e?.message || String(e)));
    }
  }
  return group;
}
