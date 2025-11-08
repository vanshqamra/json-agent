// tokenize.js — v3 (patched with low-confidence LLM escalation)
import { maybeEscalateWithLLM } from '@/llmAssist.js';

const PIPELINE_TUNING = {
  minPriceHitsForSignal: 2,
  minSpecHitsForSignal: 3,
  minSkuHitsForSignal: 1,
};

// Broad SKU & value patterns
const SKU_RE = /(?:^|\s)([A-Z]{1,5}[\-\/_ ]?\d{2,7}[A-Z]{0,2}|\d{2,7}[\-\/_ ]?[A-Z]{1,4})(?!\w)/;
const PRICE_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)\s*[:=]?\s*[\d,.]{2,}/i;
const PRICE_NUM_RE = /(?:₹|rs\.?|inr|€|eur|\$|usd)?\s*\d{2,3}(?:[.,]\d{3})*(?:[.,]\d+)?/i;
const UNIT_RE = /\b(ml|mL|l|L|litre|µl|ul|gm|g|kg|mg|mm|cm|inch|in|pcs|pack|bottle|jar|pkt|pair|set)\b/;
const PACK_RE = /\b(\d+\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(ml|mL|l|L|g|gm|kg|mg|µl|ul)\b/;
const HEADER_MARKER_RE = /(^[A-Z0-9\-\-_\/\s]{6,}$)|(^[A-Z][A-Z0-9\-\-_\/\s]{4,}$)/;
const SUBHEADER_RE = /(features|applications|description|grade|purity|complies|specification|packing|storage|safety)/i;
const FOOTNOTE_RE = /(terms|notes?|warranty|conditions|disclaimer|\*?gst|tax|mrp|pricing)/i;
const DOT_LEADER_RE = /\.{2,}\s*\d/; // "Product .... 1234"

export async function tokenizeAndClassify(pages) {
  const outPages = [];

  for (let pIndex = 0; pIndex < pages.length; pIndex++) {
    const page = pages[pIndex];
    const lines = page.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const blocks = [];
    let priceHits = 0, specHits = 0, skuHits = 0;

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const tokens = text.split(/\s+/);

      const priceLike = PRICE_RE.test(text) || PRICE_NUM_RE.test(text); // (fixed variable name)
      const skuLike = SKU_RE.test(text);
      const unitLike = UNIT_RE.test(text) || PACK_RE.test(text);
      const looksHeader = HEADER_MARKER_RE.test(text) && text.length <= 90 && /[A-Z]/.test(text);
      const looksSub = SUBHEADER_RE.test(text);
      const looksFoot = FOOTNOTE_RE.test(text);
      const hasDotLeader = DOT_LEADER_RE.test(text);

      // tabular hint
      const numClusters = (text.match(/\d+(?:[.,]\d+)?/g) || []).length;
      const columnHints = (text.match(/\s{2,}/g) || []).length;
      const tabularLike = (numClusters >= 2 && columnHints >= 1) || hasDotLeader;

      let type = 'garbage';
      let score = 0;
      if (looksHeader) { type = 'header'; score += 0.9; }
      else if (looksSub) { type = 'subheader'; score += 0.6; }
      else if (skuLike && unitLike && priceLike) { type = 'table_row'; score += 0.8; }
      else if (tabularLike && (unitLike || priceLike)) { type = 'table_row'; score += 0.7; }
      else if (skuLike) { type = 'sku'; score += 0.55; }
      else if (priceLike) { type = 'price'; score += 0.5; }
      else if (unitLike) { type = 'spec_row'; score += 0.45; }

      if (looksFoot) { type = 'footnote'; score = Math.max(score, 0.4); }

      if (priceLike) priceHits++;
      if (unitLike) specHits++;
      if (skuLike) skuHits++;

      let block = {
        type,
        text,
        tokens,
        lineNo: i + 1,
        metrics: {
          priceLike, skuLike, unitLike, looksHeader, looksSub, looksFoot, tabularLike,
          numClusters, columnHints, hasDotLeader
        },
        score
      };

      // ---- OPTIONAL LLM ESCALATION ON LOW CONFIDENCE ----
      // Only triggers if USE_LLM=true in env. Deterministic by default.
      const lowConfidence =
        block.type === 'garbage' ||
        (block.type === 'spec_row' && !/\d/.test(block.text));

      if (lowConfidence) {
        try {
          const llmHint = await maybeEscalateWithLLM(
            { text: block.text, metrics: block.metrics },
            'Uncertain classification'
          );
          if (llmHint?.suggestedType) block.type = llmHint.suggestedType;
          if (llmHint?.normalized) block.normalized = llmHint.normalized;
        } catch {
          // ignore hint errors silently
        }
      }
      // ---------------------------------------------------

      blocks.push(block);
    }

    outPages.push({
      index: pIndex + 1,
      blocks,
      signals: { priceHits, specHits, skuHits }
    });
  }

  return outPages;
}

export const TOKEN_TUNING = PIPELINE_TUNING;
