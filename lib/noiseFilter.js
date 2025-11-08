/**
 * Smarter noise/section detector.
 * - Multi-signal scoring (price/spec/SKU/units/index/promotional language/numeric shape)
 * - Context smoothing (±2 pages) to avoid flapping
 * - Sections: 'intro' | 'catalog' | 'index' | 'appendix'
 * - Debug reasons + final noiseScore (0–100)
 */
const NOISE_TUNING = {
  // raw signal weights (sum ≈ 1.0 for intuition; we’ll rescale)
  weights: {
    price: 0.20,      // ₹, $, €, unit-prices, “Price/Unit”, “MRP”
    spec:  0.20,      // “mm, µm, mL, L, g, %”, dimensions, ISO specs, tables
    sku:   0.18,      // catalog codes like “BOR-1234”, “Q123-45”, alnum-with-dash
    units: 0.10,      // unit tokens even if not in table (mL, L, g, kg, pack)
    index: 0.12,      // dotted leaders / page numbers / alphabetical runs
    promo: -0.10,     // marketing words: “About”, “Quality”, “Vision”, etc.
    numericShape: 0.10 // many small 2–4 digit numbers bias towards catalog/index
  },

  // thresholds for sectioning
  sections: {
    introMaxScore: 28,     // <= this → intro/promo
    indexMinIndexScore: 18,// strong index signal → index
    appendixMinPage: 0.85, // last 15% with low signals → appendix
  },

  // context smoothing
  smooth: {
    window: 2,          // look ±2 pages
    neighborBias: 0.15, // blend ratio applied per neighbor
  },

  // regexes & heuristics
  patterns: {
    price: /(?:₹|\$|€)\s?\d[\d,]*(?:\.\d+)?|(?:price|rate|per\s*(?:unit|pack|box|bottle))/i,
    specUnits: /\b(?:mm|µm|um|cm|mL|ml|L|g|kg|wt%|v\/v|w\/v|OD\d+|CAS|HSN)\b/,
    skuLike: /\b[A-Z]{1,5}[-\s]?\d{2,5}(?:[-/]\d{1,4})?\b/,
    dottedLeader: /[\.·\s]{3,}\s?\d{1,4}\b/, // "Product ..... 23"
    promoWords: /\b(about|profile|vision|mission|quality|certificate|iso|privacy|terms|contact|global presence|manufacturing|plant|infrastructure|why choose us)\b/i,
    pageNumber: /\bpage\s*\d{1,4}\b/i,
  }
};

// ---- helpers ---------------------------------------------------------------

function count(arr, pred) { let c=0; for (const x of arr) if (pred(x)) c++; return c; }
function any(arr, pred) { for (const x of arr) if (pred(x)) return true; return false; }

// Computes raw signals from a tokenized page
function computeSignals(page) {
  const { patterns } = NOISE_TUNING;
  const text = page.blocks.map(b => b.text).join('\n');

  const priceHits = count(page.blocks, b =>
    b.type === 'price' || patterns.price.test(b.text));

  const specHits = count(page.blocks, b =>
    b.type === 'spec_row' || patterns.specUnits.test(b.text));

  const skuHits = count(page.blocks, b =>
    b.type === 'sku' || patterns.skuLike.test(b.text));

  const unitHits = count(page.blocks, b => patterns.specUnits.test(b.text));

  // Index/TOC-like signals: dotted leaders, many short lines ending numbers, “index/contents”
  const indexTokens =
    count(page.blocks, b => patterns.dottedLeader.test(b.text)) +
    (/\b(index|contents|table of contents)\b/i.test(text) ? 3 : 0) +
    count(page.blocks, b => /\b[A-Z][A-Za-z].{0,40}\s\d{1,4}\b/.test(b.text));

  // Promotional/intro language
  const promoHits =
    count(page.blocks, b => patterns.promoWords.test(b.text)) +
    (/\b(foreword|welcome|dear customers|brochure)\b/i.test(text) ? 2 : 0);

  // Numeric shape: many small integers typically indicates dimension/spec tables or indices
  const smallNums = (text.match(/\b\d{1,4}\b/g) || []).length;
  const numericShape = Math.min(20, Math.floor(smallNums / 10)); // cap influence

  return { priceHits, specHits, skuHits, unitHits, indexTokens, promoHits, numericShape };
}

function scoreSignals(sig) {
  const w = NOISE_TUNING.weights;
  // Base positive score
  let s =
    w.price * clamp(sig.priceHits, 0, 10) * 10 +
    w.spec  * clamp(sig.specHits,  0, 12) * 8  +
    w.sku   * clamp(sig.skuHits,   0, 10) * 10 +
    w.units * clamp(sig.unitHits,  0, 12) * 6  +
    w.index * clamp(sig.indexTokens, 0, 20) * 5 +
    w.numericShape * clamp(sig.numericShape, 0, 20) * 3;

  // Negative influence for promo
  s += w.promo * clamp(sig.promoHits, 0, 10) * 8;

  // Normalize roughly to 0–100
  return clamp(Math.round(s * 1.2), 0, 100);
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

// Smooth scores with neighbor context
function smoothScores(scores) {
  const k = NOISE_TUNING.smooth.window;
  const bias = NOISE_TUNING.smooth.neighborBias;
  const out = scores.slice();
  for (let i=0; i<scores.length; i++) {
    let acc = scores[i], weight = 1;
    for (let d=1; d<=k; d++) {
      const left = i-d, right = i+d;
      if (left >= 0) { acc += scores[left] * bias; weight += bias; }
      if (right < scores.length) { acc += scores[right] * bias; weight += bias; }
    }
    out[i] = Math.round(acc / weight);
  }
  return out;
}

// Classify section for each page
function classifySection(score, idxScore, i, total) {
  const { sections } = NOISE_TUNING;
  const atTail = i >= Math.floor(total * sections.appendixMinPage);

  if (idxScore >= sections.indexMinIndexScore && score < 45) return 'index';
  if (score <= sections.introMaxScore) return 'intro';
  if (atTail && score < 35) return 'appendix';
  return 'catalog';
}

// ---- main API --------------------------------------------------------------

export function markNoise(pages) {
  // 1) raw signals + raw score
  const raw = pages.map(p => {
    const sig = computeSignals(p);
    const score = scoreSignals(sig);
    return { p, sig, rawScore: score };
  });

  // 2) compute a dedicated index-ness channel (pre-smoothing)
  const indexChannel = raw.map(r =>
    clamp(Math.round((r.sig.indexTokens * 5) - (r.sig.specHits * 1.5) - (r.sig.priceHits)), 0, 100)
  );

  // 3) smooth main score
  const smoothed = smoothScores(raw.map(r => r.rawScore));

  // 4) finalize classification
  const total = pages.length;
  const out = [];
  for (let i=0; i<pages.length; i++) {
    const score = smoothed[i];
    const idxScore = clamp(Math.round(indexChannel[i] * 0.9), 0, 100);
    const section = classifySection(score, idxScore, i, total);

    const isNoise = (section === 'intro' || section === 'index' || section === 'appendix');

    const reasons = [];
    if (section === 'intro') reasons.push('low composite signal');
    if (section === 'index') reasons.push('dotted leaders/page-number patterns dominate, low spec/price');
    if (section === 'appendix') reasons.push('tail pages with low technical density');
    if (section === 'catalog') reasons.push('balanced spec/sku/price density');

    out.push({
      ...pages[i],
      isNoise,
      section,
      noiseScore: 100 - score, // lower score ⇒ noisier; invert for intuition
      _debug: {
        rawScore: raw[i].rawScore,
        smoothedScore: score,
        indexScore: idxScore,
        signals: raw[i].sig,
        reasons
      }
    });
  }

  return out;
}

export const NOISE_TUNING_CONST = NOISE_TUNING;
