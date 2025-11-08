const CODE_HEADERS = [
  'code',
  'cat no',
  'cat. no.',
  'catalogue no',
  'catalog no',
  'product code',
  'item code',
  'cat number',
  'catalogue number',
  'article no',
  'catno',
];

const NAME_HEADERS = [
  'product',
  'item',
  'description',
  'details',
  'name',
  'particulars',
];

const PRICE_HEADERS = [
  'price',
  'mrp',
  'rate',
  'list price',
  'unit price',
  'dealer price',
  'net price',
  'price (rs)',
  'price (inr)',
  'price (₹)',
];

const CURRENCY_MAP = {
  '₹': 'INR',
  rs: 'INR',
  inr: 'INR',
  $: 'USD',
  usd: 'USD',
  eur: 'EUR',
  '€': 'EUR',
  gbp: 'GBP',
  '£': 'GBP',
};

function normalizeHeader(header = '') {
  return header.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

function detectColumnIndex(headers, targetList) {
  const normalized = headers.map(normalizeHeader);
  for (let i = 0; i < normalized.length; i += 1) {
    const header = normalized[i];
    for (const target of targetList) {
      if (header === target || header.includes(target)) {
        return i;
      }
    }
  }
  return -1;
}

function parseCurrency(raw) {
  if (!raw) return { currency: null, unit: null };
  const lower = raw.toLowerCase();
  for (const [symbol, code] of Object.entries(CURRENCY_MAP)) {
    if (raw.includes(symbol) || lower.includes(symbol)) {
      return { currency: code, unit: null };
    }
  }
  return { currency: null, unit: null };
}

function parseUnit(raw) {
  if (!raw) return null;
  const match = raw.match(/(?:\/|per\s+)([a-zA-Z ]{2,})/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

function parseNumeric(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, '');
  const normalized = cleaned.replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function parsePrice(raw) {
  if (!raw) {
    return { price: { currency: null, list: null, unit: null }, warnings: [] };
  }
  const trimmed = raw.trim();
  const { currency } = parseCurrency(trimmed);
  const unit = parseUnit(trimmed);
  const list = parseNumeric(trimmed);
  const warnings = [];
  if (list == null) {
    warnings.push({ kind: 'price_parse_failed', value: raw });
  }
  return { price: { currency, list, unit }, warnings };
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function inferCategory(text) {
  if (!text) return null;
  const hay = text.toLowerCase();
  if (/instrument|meter|controller|balance|analyzer/.test(hay)) return 'instrument';
  if (/flask|beaker|bottle|glass|pipette|cuvette|cylinder/.test(hay)) return 'glassware';
  if (/acid|solution|reagent|powder|chemical|solvent/.test(hay)) return 'chemical';
  if (/filter|tips|consumable|tubes|syringe|cartridge/.test(hay)) return 'consumable';
  if (/plastic|poly|bag|container/.test(hay)) return 'packaging';
  return null;
}

export function normalizeGroups(detectedGroups = []) {
  const products = [];
  const warnings = [];
  const duplicateCodeWarnings = [];
  const priceWarnings = [];
  for (const group of detectedGroups) {
    if (!group.header.length || group.rows.length === 0) {
      warnings.push({
        type: 'empty_group',
        page: group.pageNumber,
        heading: group.heading,
      });
      continue;
    }

    let header = [...group.header];
    let rows = group.rows.map(row => [...row]);
    let weak = group.weak;

    if (header.length < 2) {
      const transformedRows = [];
      for (const row of rows) {
        const cell = (row[0] ?? '').trim();
        if (!cell) continue;
        const parts = cell.split(/\s*[:\-–]\s*/);
        if (parts.length >= 2) {
          transformedRows.push([parts[0], parts.slice(1).join(' - ')]);
        }
      }
      if (transformedRows.length) {
        header = ['Attribute', 'Value'];
        rows = transformedRows;
      }
      weak = true;
    }

    const codeIdx = detectColumnIndex(header, CODE_HEADERS);
    const nameIdx = detectColumnIndex(header, NAME_HEADERS);
    const priceIdx = detectColumnIndex(header, PRICE_HEADERS);

    const variants = [];
    const seenCodes = new Map();

    for (const row of rows) {
      const codeRaw = codeIdx >= 0 ? row[codeIdx] ?? null : null;
      const nameRaw = nameIdx >= 0 ? row[nameIdx] ?? null : null;
      const priceRaw = priceIdx >= 0 ? row[priceIdx] ?? null : null;
      const specs = {};
      header.forEach((headerName, idx) => {
        if (idx === codeIdx || idx === nameIdx || idx === priceIdx) {
          return;
        }
        specs[headerName] = normalizeText(row[idx]);
      });
      const { price, warnings: priceWarns } = parsePrice(priceRaw);
      if (priceWarns.length) {
        priceWarnings.push(
          ...priceWarns.map(warn => ({
            ...warn,
            page: group.pageNumber,
            heading: group.heading,
            row,
          }))
        );
      }
      const variant = {
        code: normalizeText(codeRaw),
        name: normalizeText(nameRaw),
        specs,
        price,
        notes: null,
      };
      const codeKey = variant.code?.toLowerCase();
      if (codeKey) {
        if (!seenCodes.has(codeKey)) {
          seenCodes.set(codeKey, 1);
        } else {
          seenCodes.set(codeKey, seenCodes.get(codeKey) + 1);
        }
      }
      variants.push(variant);
    }

    for (const [codeKey, count] of seenCodes.entries()) {
      if (count > 1) {
        duplicateCodeWarnings.push({
          type: 'duplicate_code',
          code: codeKey,
          heading: group.heading,
          page: group.pageNumber,
          count,
        });
      }
    }

    const category = inferCategory(group.heading) || inferCategory(group.description);

    products.push({
      category,
      title: normalizeText(group.heading) || 'Untitled Product',
      description: normalizeText(group.description),
      specs_headers: header,
      variants,
      pageNumber: group.pageNumber,
      weak,
      usedBlockIds: group.usedBlockIds || [],
    });

    if (weak) {
      warnings.push({
        type: 'weak_table',
        page: group.pageNumber,
        heading: group.heading,
        headers: header,
      });
    }
  }

  return {
    products,
    warnings,
    duplicateCodeWarnings,
    priceWarnings,
  };
}

export const __test__ = {
  normalizeHeader,
  detectColumnIndex,
  parsePrice,
  parseNumeric,
  inferCategory,
};
