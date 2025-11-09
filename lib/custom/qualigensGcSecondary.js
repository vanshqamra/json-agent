const HEADER_RE = /gc\s+secondary\s+reference\s+standard/i;
const PRODUCT_CODE_RE = /^Q[0-9A-Z-]{4,}/i;
const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;
const PRICE_RE = /(?:₹|rs\.?|inr)?\s*(\d{3,})(?:\.\d+)?\s*$/i;
const PACK_RE = /(\d+(?:\.\d+)?)\s*(ml|l|litre|g|gm|kg|mg|µl|ul)\b/i;

function normaliseWhitespace(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractLinesFromPage(page) {
  const raw = page?.rawText || '';
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map(line => ({ text: line.trim(), pageNumber: page.pageNumber }))
    .filter(entry => entry.text.length > 0);
}

function parseLines(lines) {
  const variants = [];
  const skipped = [];
  let current = null;

  for (const entry of lines) {
    const { text, pageNumber } = entry;
    if (!text) continue;

    if (HEADER_RE.test(text)) {
      if (current) {
        variants.push({ ...current, name: current.name.trim().replace(/\s+/g, ' ') });
        current = null;
      }
      continue;
    }
    if (/^product\s+code/i.test(text) || /^notes?/i.test(text)) {
      if (current) {
        variants.push({ ...current, name: current.name.trim().replace(/\s+/g, ' ') });
        current = null;
      }
      continue;
    }

    const codeMatch = text.match(PRODUCT_CODE_RE);
    const casMatch = text.match(CAS_RE);

    if (codeMatch && casMatch && text.indexOf(codeMatch[0]) < text.indexOf(casMatch[0])) {
      if (current) {
        variants.push({ ...current, name: current.name.trim().replace(/\s+/g, ' ') });
        current = null;
      }
      const remainder = text.slice(text.indexOf(casMatch[0]) + casMatch[0].length).trim();
      const priceMatch = remainder.match(PRICE_RE);
      const packCandidate = remainder.replace(priceMatch?.[0] || '', '').trim();
      const packMatch = packCandidate.match(PACK_RE);
      const namePart = packCandidate.replace(packMatch?.[0] || '', '').trim();

      const priceValue = priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null;
      const packValue = packMatch ? normaliseWhitespace(packMatch[0].replace(/\s*(ml|l|litre|g|gm|kg|mg|µl|ul)\b/i, ' $1')) : null;
      const nameValue = namePart ? namePart : remainder.replace(priceMatch?.[0] || '', '').trim();

      if (!priceMatch || !packMatch || !nameValue) {
        skipped.push({
          pageNumber,
          line: text,
          reason: 'missing_field',
        });
        continue;
      }

      current = {
        product_code: codeMatch[0].trim().toUpperCase(),
        cas: casMatch[0],
        name: nameValue,
        pack_size: packValue,
        price_inr: priceValue,
        _pageNumber: pageNumber,
      };
      continue;
    }

    if (current) {
      current.name = `${current.name} ${text}`;
      continue;
    }

    skipped.push({ pageNumber, line: text, reason: 'unmatched' });
  }

  if (current) {
    variants.push({ ...current, name: current.name.trim().replace(/\s+/g, ' ') });
  }

  return { variants, skipped };
}

export function applyQualigensGcSecondaryParser({ pages = [], groups = [], docId = '' } = {}) {
  if (!pages.length) return null;

  const alreadyParsed = groups.some(group =>
    /gc\s+secondary\s+reference\s+standard/i.test(group.title || '') && group.variants?.length,
  );
  if (alreadyParsed) {
    return { groups, diagnostics: { skipped: 'existing_group_present' } };
  }

  const candidatePages = pages.filter(page => HEADER_RE.test(page?.rawText || ''));
  if (!candidatePages.length) return null;

  const lines = candidatePages.flatMap(extractLinesFromPage);
  const { variants, skipped } = parseLines(lines);

  const cleanVariants = variants.map(variant => ({
    product_code: variant.product_code,
    cas: variant.cas,
    name: normaliseWhitespace(variant.name),
    pack_size: normaliseWhitespace(variant.pack_size),
    price_inr: variant.price_inr,
  }));

  const unique = [];
  const seenCodes = new Set();
  for (const variant of cleanVariants) {
    const key = `${variant.product_code}|${variant.cas}|${variant.pack_size}`;
    if (seenCodes.has(key)) continue;
    seenCodes.add(key);
    unique.push(variant);
  }

  if (unique.length < 5) {
    return {
      groups,
      diagnostics: {
        qualigens_gc: {
          skipped_reason: 'insufficient_rows',
          detected_rows: unique.length,
        },
      },
    };
  }

  const pageNumbers = candidatePages.map(page => page.pageNumber);
  pageNumbers.sort((a, b) => a - b);

  const description =
    'Qualigens / Thermo Fisher GC secondary reference standards. HSN may vary. For latest prices see Thermo Fisher India Chemicals site.';

  const group = {
    category: 'Reference Standards',
    title: 'GC Secondary Reference Standard',
    description,
    specs_headers: ['product_code', 'cas', 'name', 'pack_size', 'price_inr'],
    variants: unique,
    pageStart: pageNumbers[0],
    pageEnd: pageNumbers[pageNumbers.length - 1],
  };

  const mergedGroups = [...groups.filter(g => g.pageEnd < group.pageStart || g.pageStart > group.pageEnd), group];
  mergedGroups.sort((a, b) => (a.pageStart || 0) - (b.pageStart || 0));

  const qcReport = {
    docId: docId || null,
    parser: 'qualigens_gc_secondary_reference_standard',
    pageNumbers,
    total_lines: lines.length,
    variants_parsed: unique.length,
    skipped_rows: skipped,
  };

  return {
    groups: mergedGroups,
    diagnostics: {
      qualigens_gc: {
        qcReport,
        variants_parsed: unique.length,
        skipped_rows: skipped.length,
      },
    },
    qcReport,
  };
}
