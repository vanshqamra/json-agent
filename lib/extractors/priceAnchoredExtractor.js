import { preSegmentText } from './preSegment.js';
import { dedupeRows } from '../utils/dedupeRows.js';
import { scrubField } from '../utils/fieldScrubber.js';
import { extractPack } from '../utils/pack.js';

function toLower(text) {
  return String(text || '').toLowerCase();
}

function normaliseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized = cleaned;
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) {
      normalized = cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    }
  } else if (hasComma) {
    const lastIndex = cleaned.lastIndexOf(',');
    const decimalCandidate = cleaned.length - lastIndex - 1;
    if (decimalCandidate === 2) {
      normalized = cleaned.replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  }
  const parsed = Number.parseFloat(normalized.replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function detectCurrency(value) {
  if (!value) {
    return { amount: parseNumber(value), currency: null };
  }
  const lowered = toLower(value);
  if (/₹|\b(rs|inr)\b/i.test(value)) {
    return { amount: parseNumber(value), currency: 'INR' };
  }
  if (/€|\beur\b/i.test(value)) {
    return { amount: parseNumber(value), currency: 'EUR' };
  }
  if (/\$|\busd\b/i.test(value)) {
    return { amount: parseNumber(value), currency: 'USD' };
  }
  return { amount: parseNumber(value), currency: null };
}

const PRICE_TOKEN_REGEX = /(₹|Rs\.?|INR|€|EUR|\$|USD)?\s*(?:\d{1,3}(?:,\d{3})+|\d{2,})(?:\.\d+)?(?!\s*%)/gi;
const STRONG_CODE_REGEX = /([A-Z0-9]{3,}(?:-[A-Z0-9]+)+|\b\d{6,}\b|\b\d{4,}-\d{2,}\b)/;
const GENERIC_CODE_REGEX = /([A-Z]{2,}\d{3,}|\b\d{5,}\b)/;

function findPriceMatches(text) {
  if (!text) return [];
  const matches = [];
  PRICE_TOKEN_REGEX.lastIndex = 0;
  let match;
  while ((match = PRICE_TOKEN_REGEX.exec(text)) != null) {
    const token = match[0];
    const { amount, currency } = detectCurrency(token);
    if (amount == null) continue;
    matches.push({
      token,
      amount,
      currency: currency || null,
      start: match.index,
      end: PRICE_TOKEN_REGEX.lastIndex,
    });
  }
  return matches;
}

function detectCodeCandidate(text) {
  if (!text) return null;
  const strong = text.match(STRONG_CODE_REGEX);
  if (strong) return { value: strong[0], strong: true };
  const generic = text.match(GENERIC_CODE_REGEX);
  if (generic) return { value: generic[0], strong: false };
  return null;
}

function cleanNameFragments(text) {
  if (!text) return '';
  let working = text;
  working = working.replace(/\bHSN\s*:?\s*\d{4,}\b/gi, ' ');
  working = working.replace(/\bGST\s*:?\s*\d{1,2}%/gi, ' ');
  working = working.replace(/\b\d{8}\b/gi, ' ');
  working = working.replace(/\bGST\b/gi, ' ');
  working = working.replace(/\bINR\b/gi, ' ');
  working = working.replace(/₹/g, ' ');
  return normaliseWhitespace(working);
}

function gatherSegmentsFromPage(page) {
  const segments = [];
  const pageNumber = page.pageNumber || page.page || null;
  const hasSegments = Array.isArray(page.segments) && page.segments.length > 0;
  if (hasSegments) {
    for (const segment of page.segments) {
      const text = normaliseWhitespace(segment.text || '');
      if (!text) continue;
      segments.push({
        text,
        pageNumber,
        blockId: segment.id || null,
      });
    }
  }
  if (!hasSegments && Array.isArray(page.textBlocks)) {
    for (const block of page.textBlocks) {
      const textValue = block?.text || '';
      const preSegments = preSegmentText(textValue);
      if (preSegments.length) {
        for (const entry of preSegments) {
          segments.push({
            text: normaliseWhitespace(entry),
            pageNumber,
            blockId: block?.id || null,
          });
        }
        continue;
      }
      const split = String(textValue || '').split(/\n+/);
      for (const entry of split) {
        const trimmed = normaliseWhitespace(entry);
        if (!trimmed) continue;
        segments.push({
          text: trimmed,
          pageNumber,
          blockId: block?.id || null,
        });
      }
    }
  }
  if (Array.isArray(page.tables)) {
    for (const table of page.tables) {
      if (Array.isArray(table.header)) {
        segments.push({
          text: normaliseWhitespace(table.header.join(' ')),
          pageNumber,
          blockId: table.id || null,
        });
      }
      for (const row of table.rows || []) {
        segments.push({
          text: normaliseWhitespace(row.join(' ')),
          pageNumber,
          blockId: table.id || null,
        });
      }
    }
  }
  return segments;
}

function collectLines(pages) {
  const lines = [];
  for (const page of pages || []) {
    lines.push(...gatherSegmentsFromPage(page));
  }
  return lines;
}

function computePageCurrencyHints(pages) {
  const hints = new Map();
  for (const page of pages || []) {
    const pageNumber = page.pageNumber || page.page || null;
    const headerCandidates = [];
    if (Array.isArray(page.textBlocks)) {
      for (const block of page.textBlocks) {
        if (block?.id && /h\d+$/i.test(String(block.id))) {
          headerCandidates.push(String(block.text || ''));
        }
      }
      if (!headerCandidates.length && page.textBlocks.length) {
        headerCandidates.push(String(page.textBlocks[0].text || ''));
      }
    }
    const headerText = normaliseWhitespace(headerCandidates.join(' '));
    if (/₹|\bINR\b/i.test(headerText)) {
      hints.set(pageNumber, 'INR');
    }
  }
  return hints;
}

function buildVariant(line, priceInfo, options) {
  const { currencyHint, priceCount } = options;
  const left = priceInfo.start != null ? line.text.slice(0, priceInfo.start) : line.text;
  const right = priceInfo.end != null ? line.text.slice(priceInfo.end) : '';
  const codeCandidate = detectCodeCandidate(left) || detectCodeCandidate(line.text) || detectCodeCandidate(right);
  const code = codeCandidate ? normaliseWhitespace(codeCandidate.value) : null;

  let working = left;
  if (codeCandidate?.value) {
    working = working.replace(codeCandidate.value, ' ');
  }

  const { pack, pack_raw } = extractPack(working);
  if (pack_raw) {
    working = working.replace(pack_raw, ' ');
  }

  working = cleanNameFragments(working);
  const name = scrubField(working);

  const currency = priceInfo.currency || currencyHint || null;

  const fieldsPresent = ['price_value'];
  if (code) fieldsPresent.push('code');
  if (name) fieldsPresent.push('name');
  if (pack) fieldsPresent.push('pack');
  if (currency) fieldsPresent.push('currency');

  let confidence = 0.3;
  if (name) confidence += 0.3;
  if (code && codeCandidate?.strong) confidence += 0.2;
  if (pack) confidence += 0.1;
  if (currency) confidence += 0.1;
  if (priceCount > 1) confidence -= 0.2;
  if (confidence < 0.1) confidence = 0.1;
  if (confidence > 0.95) confidence = 0.95;

  return {
    code: code || null,
    cas: null,
    name,
    pack: pack || null,
    pack_raw: pack_raw || null,
    price_value: priceInfo.amount,
    currency,
    notes: null,
    confidence,
    fields_present: fieldsPresent,
    source: line,
  };
}

function analyseLine(line, options) {
  const priceMatches = findPriceMatches(line.text);
  if (!priceMatches.length) {
    return { variant: null, priceCount: 0 };
  }
  const priceInfo = priceMatches[priceMatches.length - 1];
  const variant = buildVariant(line, priceInfo, {
    currencyHint: options.currencyHint,
    priceCount: priceMatches.length,
  });
  return { variant, priceCount: priceMatches.length };
}

export function runPriceAnchoredRecovery(pages, options = {}) {
  const lines = collectLines(pages);
  const pageCurrencyHints = computePageCurrencyHints(pages);
  const rows = [];
  const leftovers = [];
  const lowConfidence = [];
  const minimumConfidence = options.minimumConfidence ?? 0.5;

  for (const line of lines) {
    const { variant, priceCount } = analyseLine(line, {
      currencyHint: pageCurrencyHints.get(line.pageNumber) || null,
    });
    if (!variant) {
      leftovers.push(line.text);
      continue;
    }
    if (!variant.name || !variant.code) {
      leftovers.push(line.text);
      continue;
    }
    if (variant.confidence < minimumConfidence) {
      lowConfidence.push({
        index: rows.length,
        reason: 'low_confidence',
        confidence: variant.confidence,
        source: line.text,
      });
      continue;
    }
    rows.push(variant);
  }

  const { rows: dedupedRows, duplicates } = dedupeRows(rows);

  const variants = dedupedRows.map(row => ({
    code: row.code || null,
    cas: row.cas || null,
    name: row.name,
    pack: row.pack || null,
    pack_raw: row.pack_raw || null,
    price_value: row.price_value,
    currency: row.currency || null,
    notes: row.notes,
    confidence: row.confidence,
    fields_present: row.fields_present,
  }));

  const qcReport = {
    docId: options.docId || null,
    engine: 'price_anchored',
    matched_pattern: 'price_anchored',
    matched_rows: variants.length,
    fields: ['code', 'cas', 'name', 'pack', 'pack_raw', 'price_value', 'currency', 'notes'],
    rows: dedupedRows.map((row, index) => ({
      index,
      confidence: row.confidence,
      fields_present: row.fields_present,
      source: row.source,
    })),
    low_confidence: lowConfidence,
    leftovers,
    duplicates_removed: duplicates,
    rows_unmatched_sample: leftovers.slice(0, 5),
  };

  const group = variants.length
    ? [{
        category: 'general',
        title: options.title || 'Price anchored recovery',
        description: '',
        specs_headers: [],
        variants,
        pageStart: dedupedRows.length ? dedupedRows[0].source?.pageNumber || null : null,
        pageEnd: dedupedRows.length
          ? dedupedRows[dedupedRows.length - 1].source?.pageNumber || null
          : null,
        source_docId: options.docId || null,
        qc_report: qcReport,
      }]
    : [];

  return {
    groups: group,
    qcReport,
    diagnostics: {
      priceMatches: variants.length,
      lowConfidence: lowConfidence.length,
      duplicatesRemoved: duplicates,
    },
    warnings: group.length ? [] : ['price_anchored_no_match'],
  };
}
