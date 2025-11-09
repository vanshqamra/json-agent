import { preSegmentText } from './preSegment.js';
import { dedupeRows } from '../utils/dedupeRows.js';
import { scrubField } from '../utils/fieldScrubber.js';
import { extractPack } from '../utils/pack.js';

function toLower(value) {
  return String(value || '').toLowerCase();
}

function normaliseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/\s+/g, '');
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

function detectCurrency(value, context = '') {
  const combined = `${value || ''} ${context || ''}`;
  if (/₹|\bINR\b/i.test(combined)) {
    return 'INR';
  }
  if (/€|\bEUR\b/i.test(combined)) {
    return 'EUR';
  }
  if (/\$|\bUSD\b/i.test(combined)) {
    return 'USD';
  }
  if (/£|\bGBP\b/i.test(combined)) {
    return 'GBP';
  }
  if (/\b(MRP|LP|RATE)\b/i.test(context || '')) {
    return 'INR';
  }
  return null;
}

const HEADER_KEYWORDS = ['cat no', 'description', 'hsn', 'gst', 'price', 'inr', 'lp'];
const HYHEN_SKU_RE = /\b[A-Z0-9]{2,}-[A-Z0-9]{2,}\b/;
const NUMERIC_SKU_RE = /\b\d{5,}\b/;
const HSN_LABEL_RE = /\bHSN\s*[:\-]?\s*(\d{8})\b/i;
const HSN_RE = /\b\d{8}\b/;
const GST_LABEL_RE = /\bGST\s*[:\-]?\s*(\d{1,2}(?:\.\d+)?)%/i;
const GST_VALUE_RE = /\b\d{1,2}(?:\.\d+)?%/;
const PERCENT_RE = /%/;

const PACK_PATTERNS = [
  /\b\d+\s*\/\s*(?:PK|PCS|PC|BTL|RL|ROL|BOX)\b/i,
  /\b\d+(?:\.\d+)?\s?(?:ml|l|g|kg|mm|cm)\b/i,
  /\b\d+(?:\.\d+)?M\b/i,
  /\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?:mm|cm)\b/i,
];

function isHeaderLine(text) {
  const lower = toLower(text);
  return HEADER_KEYWORDS.some(keyword => lower.includes(keyword));
}

function gatherSegmentsFromPage(page) {
  const segments = [];
  const seen = new Set();
  const pageNumber = page.pageNumber || page.page || null;

  const pushSegment = (text, raw, tokens = [], blockId = null) => {
    const normalised = normaliseWhitespace(text);
    if (!normalised) return;
    const key = `${pageNumber || 'n'}::${blockId || ''}::${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({
      text: normalised,
      raw: normaliseWhitespace(raw || text),
      tokens: Array.isArray(tokens) ? tokens : [],
      pageNumber,
      blockId,
    });
  };

  if (Array.isArray(page.lineItems) && page.lineItems.length) {
    for (const item of page.lineItems) {
      pushSegment(item.text || item.raw || '', item.raw || item.text || '', item.tokens || [], item.id || null);
    }
  }

  if (!segments.length && Array.isArray(page.textBlocks)) {
    for (const block of page.textBlocks) {
      const textValue = block?.text || '';
      const preSegments = preSegmentText(textValue);
      if (preSegments.length) {
        for (const entry of preSegments) {
          pushSegment(entry, entry, [], block?.id || null);
        }
        continue;
      }
      const split = String(textValue || '').split(/\n+/);
      for (const entry of split) {
        const trimmed = normaliseWhitespace(entry);
        if (!trimmed) continue;
        pushSegment(trimmed, trimmed, [], block?.id || null);
      }
    }
  }

  if (Array.isArray(page.tables)) {
    for (const table of page.tables) {
      if (Array.isArray(table.header) && table.header.length) {
        pushSegment(table.header.join(' '), table.header.join(' '), [], table.id || null);
      }
      for (const row of table.rows || []) {
        const joined = Array.isArray(row) ? row.join(' ') : String(row || '');
        pushSegment(joined, joined, [], table.id || null);
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

function clusterTokens(tokens = []) {
  const sorted = tokens
    .filter(token => token && token.text)
    .map(token => ({
      text: String(token.text || ''),
      bbox: token.bbox || null,
      centerX: Number.isFinite(token.centerX) ? token.centerX : token.bbox?.x || 0,
      width: token.bbox?.width || 0,
    }))
    .sort((a, b) => a.centerX - b.centerX);

  if (!sorted.length) return [];

  const clusters = [];
  let current = null;

  for (const token of sorted) {
    if (!current) {
      current = {
        tokens: [token],
        startX: token.centerX - token.width / 2,
        endX: token.centerX + token.width / 2,
      };
      continue;
    }
    const gap = token.centerX - token.width / 2 - current.endX;
    if (gap <= Math.max(3, token.width * 0.6)) {
      current.tokens.push(token);
      current.endX = Math.max(current.endX, token.centerX + token.width / 2);
    } else {
      clusters.push(current);
      current = {
        tokens: [token],
        startX: token.centerX - token.width / 2,
        endX: token.centerX + token.width / 2,
      };
    }
  }

  if (current) {
    clusters.push(current);
  }

  return clusters.map(cluster => {
    const raw = cluster.tokens.map(t => String(t.text || '')).join('');
    const text = raw.replace(/\s+/g, ' ').trim();
    const clean = raw.replace(/\s+/g, '');
    const center = (cluster.startX + cluster.endX) / 2;
    return {
      tokens: cluster.tokens,
      text,
      raw,
      clean,
      startX: cluster.startX,
      endX: cluster.endX,
      center,
    };
  });
}

function isValidPriceCluster(cluster) {
  if (!cluster || !cluster.clean) return false;
  if (PERCENT_RE.test(cluster.clean)) return false;
  const digits = cluster.clean.replace(/[^0-9]/g, '');
  if (digits.length < 2 || digits.length > 7) return false;
  if (!/\d/.test(cluster.clean)) return false;
  return true;
}

function parseClusterPrice(cluster, contextText) {
  if (!isValidPriceCluster(cluster)) return null;
  const amount = parseNumber(cluster.clean);
  if (amount == null) return null;
  const currency = detectCurrency(cluster.text, contextText);
  return { amount, currency, raw: cluster.text };
}

function buildTokenRows(line) {
  const clusters = clusterTokens(line.tokens || []);
  const priceClusters = clusters
    .map(cluster => ({ cluster, price: parseClusterPrice(cluster, line.text) }))
    .filter(entry => entry.price && entry.cluster);
  if (!priceClusters.length) return [];
  priceClusters.sort((a, b) => a.cluster.center - b.cluster.center);

  const tokensSorted = (line.tokens || [])
    .filter(token => token && token.text)
    .map(token => ({
      text: String(token.text || ''),
      centerX: Number.isFinite(token.centerX) ? token.centerX : token.bbox?.x || 0,
      token,
    }))
    .sort((a, b) => a.centerX - b.centerX);

  const rows = [];
  let leftBoundary = Number.NEGATIVE_INFINITY;

  for (const entry of priceClusters) {
    const priceCenter = entry.cluster.center;
    const priceTokenSet = new Set(entry.cluster.tokens);
    const rowTokens = tokensSorted
      .filter(t => t.centerX > leftBoundary && t.centerX < priceCenter && !priceTokenSet.has(t.token))
      .map(t => t.token);
    const rowText = rowTokens.map(token => String(token.text || '')).join(' ');
    rows.push({
      text: rowText,
      tokens: rowTokens,
      price: entry.price,
      priceRaw: entry.cluster.raw,
      priceCount: priceClusters.length,
      line,
    });
    leftBoundary = priceCenter;
  }

  return rows;
}

const PRICE_TOKEN_REGEX = /(₹|Rs\.?|INR|MRP|LP|Rate|USD|\$|EUR|€)?\s*(?:\d{1,3}(?:[\s,]\d{3})+|\d{2,})(?:[.,]\d+)?/gi;

function buildTextRows(line) {
  const text = line.raw || line.text || '';
  PRICE_TOKEN_REGEX.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = PRICE_TOKEN_REGEX.exec(text)) !== null) {
    const token = match[0];
    if (PERCENT_RE.test(token)) continue;
    const digits = token.replace(/[^0-9]/g, '');
    if (digits.length < 2 || digits.length > 7) continue;
    const amount = parseNumber(token);
    if (amount == null) continue;
    matches.push({
      start: match.index,
      end: PRICE_TOKEN_REGEX.lastIndex,
      token,
      amount,
      currency: detectCurrency(token, line.text),
    });
  }
  if (!matches.length) return [];

  const matchEntry = matches[matches.length - 1];
  const leftSlice = text.slice(0, matchEntry.start);
  return [
    {
      text: leftSlice,
      tokens: [],
      price: { amount: matchEntry.amount, currency: matchEntry.currency, raw: matchEntry.token },
      priceRaw: matchEntry.token,
      priceCount: matches.length,
      line,
    },
  ];
}

function findPackRange(text) {
  const matches = [];
  for (const pattern of PACK_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({ value: match[0], index: match.index, length: match[0].length });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.index - b.index);
  return matches[matches.length - 1];
}

function buildLayout(parts) {
  const layout = [];
  let offset = 0;
  parts.forEach((part, index) => {
    const start = offset;
    const end = start + part.length;
    layout.push({ index, text: part, start, end });
    offset = end + 1;
  });
  return { layout, normalized: parts.join(' ') };
}

function rangeToTokenIndexes(range, layout) {
  if (!range || !layout?.length) return [];
  return layout
    .filter(entry => entry.start < range.index + range.length && entry.end > range.index)
    .map(entry => entry.index);
}

function pickCode(normalized, layout, hsnRange) {
  if (!normalized) return { code: null, range: null };

  const hyphenMatch = HYHEN_SKU_RE.exec(normalized);
  if (hyphenMatch) {
    return { code: hyphenMatch[0], range: { index: hyphenMatch.index, length: hyphenMatch[0].length } };
  }

  let match;
  while ((match = NUMERIC_SKU_RE.exec(normalized)) !== null) {
    if (match[0].length === 8) {
      // likely HSN; skip
      continue;
    }
    if (hsnRange && match.index >= hsnRange.index && match.index < hsnRange.index + hsnRange.length) {
      continue;
    }
    return { code: match[0], range: { index: match.index, length: match[0].length } };
  }

  return { code: null, range: null };
}

function findHsnRange(normalized) {
  if (!normalized) return { hsn: null, range: null };
  const labelled = HSN_LABEL_RE.exec(normalized);
  if (labelled) {
    const value = labelled[1];
    const offset = labelled.index + labelled[0].toLowerCase().indexOf(value.toLowerCase());
    return { hsn: value, range: { index: offset, length: value.length } };
  }
  const match = HSN_RE.exec(normalized);
  if (match) {
    return { hsn: match[0], range: { index: match.index, length: match[0].length } };
  }
  return { hsn: null, range: null };
}

function findGstRange(normalized) {
  if (!normalized) return { gst: null, range: null };
  const labelled = GST_LABEL_RE.exec(normalized);
  if (labelled) {
    const value = labelled[1];
    const start = labelled.index + labelled[0].indexOf(labelled[1]);
    return { gst: Number.parseFloat(value), range: { index: start, length: labelled[1].length + 1 } };
  }
  const match = GST_VALUE_RE.exec(normalized);
  if (match) {
    const value = Number.parseFloat(match[0].replace('%', ''));
    if (Number.isFinite(value)) {
      return { gst: value, range: { index: match.index, length: match[0].length } };
    }
  }
  return { gst: null, range: null };
}

function buildVariant(rowContext, options) {
  const rawText = normaliseWhitespace(rowContext.text || '');
  const tokens = Array.isArray(rowContext.tokens) && rowContext.tokens.length
    ? rowContext.tokens.map(token => normaliseWhitespace(token.text || '')).filter(Boolean)
    : rawText.split(/\s+/).filter(Boolean);

  const { layout, normalized } = buildLayout(tokens);

  const hsnInfo = findHsnRange(normalized);
  const gstInfo = findGstRange(normalized);
  const packRange = findPackRange(normalized);
  const packCandidate = packRange
    ? normalized.slice(packRange.index, packRange.index + packRange.length)
    : normalized;
  const { pack, pack_raw: packRaw } = extractPack(packCandidate);

  const codeInfo = pickCode(normalized, layout, hsnInfo.range);
  let code = codeInfo.code ? normaliseWhitespace(codeInfo.code) : null;
  if (code && /^\d{8}$/.test(code)) {
    code = null;
  }

  const packIndices = rangeToTokenIndexes(packRange, layout);
  const hsnIndices = rangeToTokenIndexes(hsnInfo.range, layout);
  const gstIndices = rangeToTokenIndexes(gstInfo.range, layout);
  const codeIndices = rangeToTokenIndexes(codeInfo.range, layout);

  let startIndex = 0;
  if (codeIndices.length) {
    startIndex = Math.max(...codeIndices) + 1;
  } else {
    while (startIndex < tokens.length && (hsnIndices.includes(startIndex) || gstIndices.includes(startIndex))) {
      startIndex += 1;
    }
  }

  let endIndex = tokens.length;
  if (packIndices.length) {
    endIndex = Math.min(...packIndices);
  }

  const excluded = new Set([...hsnIndices, ...gstIndices]);
  const nameParts = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    if (excluded.has(i)) continue;
    const part = tokens[i];
    if (!part) continue;
    nameParts.push(part);
  }

  const name = scrubField(nameParts.join(' '));
  const currency =
    rowContext.price.currency || options.currencyHint || detectCurrency(rowContext.priceRaw, rowContext.line.text);

  const fieldsPresent = ['price_value'];
  if (code) fieldsPresent.push('code');
  if (name) fieldsPresent.push('name');
  if (pack) fieldsPresent.push('pack');
  if (packRaw && !fieldsPresent.includes('pack_raw')) fieldsPresent.push('pack_raw');
  if (currency) fieldsPresent.push('currency');
  if (hsnInfo.hsn) fieldsPresent.push('hsn');
  if (gstInfo.gst != null) fieldsPresent.push('gst_percent');

  let confidence = 0.25;
  if (name) confidence += 0.35;
  if (code) confidence += 0.15;
  if (pack) confidence += 0.1;
  if (hsnInfo.hsn) confidence += 0.05;
  if (gstInfo.gst != null) confidence += 0.05;
  if (currency) confidence += 0.05;
  if (rowContext.priceCount > 1) confidence -= 0.15;
  if (!options.headerSeen) confidence -= 0.15;
  if (!code && !name) confidence -= 0.2;

  if (confidence < 0.05) confidence = 0.05;
  if (confidence > 0.99) confidence = 0.99;

  if (!name) {
    return null;
  }

  return {
    code: code || null,
    cas: null,
    name,
    pack: pack || null,
    pack_raw: packRaw || null,
    hsn: hsnInfo.hsn || null,
    gst_percent: gstInfo.gst != null ? Number(gstInfo.gst) : null,
    price_value: rowContext.price.amount,
    currency: currency || null,
    notes: null,
    confidence,
    fields_present: fieldsPresent,
    source: rowContext.line,
  };
}

function analyseLine(line, options) {
  const tokenRows = buildTokenRows(line);
  const rows = tokenRows.length ? tokenRows : buildTextRows(line);
  if (!rows.length) {
    return [];
  }
  const variants = [];
  for (const row of rows) {
    if (row.price?.amount == null) continue;
    const variant = buildVariant(row, {
      currencyHint: options.currencyHint,
      headerSeen: options.headerSeen,
    });
    if (variant) {
      variants.push(variant);
    }
  }
  return variants;
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
    if (/€|\bEUR\b/i.test(headerText)) {
      hints.set(pageNumber, 'EUR');
    }
    if (/\$|\bUSD\b/i.test(headerText)) {
      hints.set(pageNumber, 'USD');
    }
  }
  return hints;
}

export function runPriceAnchoredRecovery(pages, options = {}) {
  const lines = collectLines(pages);
  const headerIndex = lines.findIndex(line => isHeaderLine(line.text));
  const initialLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;
  const processLines = [];
  let seenData = false;
  for (const line of initialLines) {
    if (!seenData && isHeaderLine(line.text)) {
      continue;
    }
    seenData = true;
    processLines.push(line);
  }
  const headerSeen = headerIndex >= 0;
  const pageCurrencyHints = computePageCurrencyHints(pages);

  const rows = [];
  const leftovers = [];
  const lowConfidence = [];
  const minimumConfidence = options.minimumConfidence ?? 0.5;
  let carryoverText = '';

  for (const line of processLines) {
    const variants = analyseLine(line, {
      currencyHint: pageCurrencyHints.get(line.pageNumber) || null,
      headerSeen,
    });

    if (!variants.length) {
      carryoverText = carryoverText ? `${carryoverText} ${line.text}` : line.text;
      leftovers.push(line.text);
      continue;
    }

    if (carryoverText) {
      const target = variants[0];
      if (target) {
        const combinedName = scrubField(`${carryoverText} ${target.name || ''}`.trim());
        if (combinedName) {
          target.name = combinedName;
          if (!target.fields_present.includes('name')) {
            target.fields_present.push('name');
          }
          target.confidence = Math.min(0.99, target.confidence + 0.05);
        }
      }
      carryoverText = '';
    }

    for (const variant of variants) {
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
  }

  const { rows: dedupedRows, duplicates } = dedupeRows(rows);

  const variants = dedupedRows.map(row => ({
    code: row.code || null,
    cas: null,
    name: row.name,
    pack: row.pack || null,
    pack_raw: row.pack_raw || null,
    hsn: row.hsn || null,
    gst_percent: row.gst_percent != null ? row.gst_percent : null,
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
    fields: ['code', 'cas', 'name', 'pack', 'pack_raw', 'hsn', 'gst_percent', 'price_value', 'currency', 'notes'],
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

