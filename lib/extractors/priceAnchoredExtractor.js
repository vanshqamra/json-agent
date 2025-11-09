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

function extractLines(pages) {
  const lines = [];
  for (const page of pages || []) {
    const pageNumber = page.pageNumber || page.page || null;
    if (Array.isArray(page.textBlocks)) {
      for (const block of page.textBlocks) {
        const blockId = block.id || block.blockId || null;
        const text = String(block.text || '').split(/\n+/);
        for (const entry of text) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          lines.push({ text: trimmed, pageNumber, blockId });
        }
      }
    }
    if (Array.isArray(page.segments)) {
      for (const segment of page.segments) {
        const text = String(segment.text || '').trim();
        if (!text) continue;
        lines.push({ text, pageNumber, blockId: segment.id || null });
      }
    }
    if (Array.isArray(page.tables)) {
      for (const table of page.tables) {
        if (Array.isArray(table.header)) {
          lines.push({ text: table.header.join('    '), pageNumber, blockId: table.id || null });
        }
        for (const row of table.rows || []) {
          lines.push({ text: row.join('    '), pageNumber, blockId: table.id || null });
        }
      }
    }
  }
  return lines;
}

function detectPriceToken(text) {
  if (!text) return null;
  const priceRegex = /(₹|Rs\.?|INR|€|EUR|\$|USD)?\s*([0-9][0-9.,]*)\s*(?:each)?\s*$/i;
  const match = text.match(priceRegex);
  if (!match) return null;
  const token = match[0];
  const { amount, currency } = detectCurrency(token);
  if (amount == null) return null;
  return {
    amount,
    currency: currency || null,
    start: match.index,
    token,
  };
}

function extractFieldsFromLeft(leftText) {
  let remaining = normaliseWhitespace(leftText);
  const row = { code: null, cas: null, name: '', pack: null };

  const casMatch = remaining.match(/\b\d{2,}-\d{2}-\d\b/);
  if (casMatch) {
    row.cas = casMatch[0];
    remaining = normaliseWhitespace(remaining.replace(casMatch[0], ' '));
  }

  const codeMatch = remaining.match(/^[A-Z0-9]{2,}(?:[-/][A-Z0-9]+)?/i);
  if (codeMatch) {
    row.code = codeMatch[0].trim();
    remaining = normaliseWhitespace(remaining.slice(codeMatch[0].length));
  }

  const packMatch = remaining.match(/(\d+(?:\.\d+)?\s*(?:ml|l|g|kg|mg|pcs?|pack|set|ltr|litre))/i);
  if (packMatch) {
    row.pack = packMatch[0].trim();
    remaining = normaliseWhitespace(remaining.replace(packMatch[0], ' '));
  }

  row.name = remaining.trim();
  return row;
}

function buildVariant(line, priceInfo) {
  const left = priceInfo.start != null ? line.text.slice(0, priceInfo.start) : line.text;
  const fields = extractFieldsFromLeft(left);
  const fieldsPresent = [];
  if (fields.code) fieldsPresent.push('code');
  if (fields.cas) fieldsPresent.push('cas');
  if (fields.name) fieldsPresent.push('name');
  if (fields.pack) fieldsPresent.push('pack');
  const variant = {
    code: fields.code || null,
    cas: fields.cas || null,
    name: fields.name || '',
    pack: fields.pack || null,
    price_value: priceInfo.amount,
    currency: priceInfo.currency || null,
    notes: null,
    confidence: 0,
    fields_present: [],
    source: line,
  };
  const priceFields = ['price_value'];
  const baseConfidence = 0.4;
  let confidence = baseConfidence;
  if (fields.name) confidence += 0.3;
  if (fields.code) confidence += 0.05;
  if (fields.pack) confidence += 0.05;
  if (fields.cas) confidence += 0.05;
  if (priceInfo.currency) confidence += 0.05;
  variant.confidence = Math.min(0.95, confidence);
  variant.fields_present = [...fieldsPresent, ...priceFields, ...(priceInfo.currency ? ['currency'] : [])];
  return variant;
}

export function runPriceAnchoredRecovery(pages, options = {}) {
  const lines = extractLines(pages);
  const rows = [];
  const leftovers = [];
  const lowConfidence = [];
  let lastVariant = null;

  for (const line of lines) {
    const priceInfo = detectPriceToken(line.text);
    if (!priceInfo) {
      if (lastVariant) {
        lastVariant.name = `${lastVariant.name} ${line.text}`.trim();
        if (!lastVariant.fields_present.includes('name')) {
          lastVariant.fields_present.push('name');
        }
        lastVariant.confidence = Math.min(0.95, lastVariant.confidence + 0.05);
        continue;
      }
      leftovers.push(line.text);
      continue;
    }
    const variant = buildVariant(line, priceInfo);
    if (!variant.name) {
      variant.name = line.text.slice(0, priceInfo.start).trim();
    }
    if (!variant.name) {
      leftovers.push(line.text);
      continue;
    }
    if (variant.confidence < (options.minimumConfidence ?? 0.5)) {
      lowConfidence.push({
        index: rows.length,
        reason: 'low_confidence',
        confidence: variant.confidence,
        source: line.text,
      });
    }
    rows.push(variant);
    lastVariant = variant;
  }

  const variants = rows.map(row => ({
    code: row.code || null,
    cas: row.cas || null,
    name: row.name,
    pack: row.pack || null,
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
    fields: ['code', 'cas', 'name', 'pack', 'price_value', 'currency', 'notes'],
    rows: rows.map((row, index) => ({
      index,
      confidence: row.confidence,
      fields_present: row.fields_present,
      source: row.source,
    })),
    low_confidence: lowConfidence,
    leftovers,
  };

  const group = variants.length
    ? [{
        category: 'general',
        title: options.title || 'Price anchored recovery',
        description: '',
        specs_headers: [],
        variants,
        pageStart: rows.length ? rows[0].source?.pageNumber || null : null,
        pageEnd: rows.length ? rows[rows.length - 1].source?.pageNumber || null : null,
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
    },
    warnings: group.length ? [] : ['price_anchored_no_match'],
  };
}

