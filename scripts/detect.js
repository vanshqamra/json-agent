const INTRO_KEYWORDS = [
  'about',
  'vision',
  'quality policy',
  'table of contents',
  'contents',
  'introduction',
  'mission',
  'certification',
  'disclaimer',
  'notes',
  'welcome',
  'company profile',
  'legal',
];

function computeDigitDensity(textBlocks = []) {
  const joined = textBlocks.map(block => block.text).join(' ');
  if (!joined) return 0;
  const digits = (joined.match(/\d/g) || []).length;
  return digits / joined.length;
}

function isIntroPage(page) {
  const textBlocks = page.textBlocks || [];
  const tables = page.tables || [];
  const hasTable = tables.some(tbl => tbl.header.length && tbl.rows.length);
  if (!hasTable) {
    const text = textBlocks.map(block => block.text.toLowerCase()).join(' ');
    if (!text) return { intro: true, reason: 'empty_page' };
    for (const keyword of INTRO_KEYWORDS) {
      if (text.includes(keyword)) {
        return { intro: true, reason: `keyword:${keyword}` };
      }
    }
    if (computeDigitDensity(textBlocks) < 0.04) {
      return { intro: true, reason: 'low_numeric_density' };
    }
    return { intro: true, reason: 'no_tables_detected' };
  }
  const headerAvg = tables.reduce((sum, tbl) => sum + tbl.header.length, 0) / tables.length;
  if (headerAvg <= 1) {
    return { intro: true, reason: 'weak_tables' };
  }
  return { intro: false, reason: 'has_valid_table' };
}

function nearestHeading(page, table) {
  const bbox = table?.bbox;
  if (!bbox) {
    const fallback = page.textBlocks?.[0];
    return fallback
      ? { heading: fallback.text, description: null, usedBlockIds: fallback.id ? [fallback.id] : [] }
      : { heading: null, description: null, usedBlockIds: [] };
  }
  const candidates = (page.textBlocks || []).filter(block => block.bbox && block.bbox.y <= bbox.y);
  if (!candidates.length) {
    const fallback = page.textBlocks?.[0];
    return fallback
      ? { heading: fallback.text, description: null, usedBlockIds: fallback.id ? [fallback.id] : [] }
      : { heading: null, description: null, usedBlockIds: [] };
  }
  candidates.sort((a, b) => b.bbox.y - a.bbox.y);
  const headingBlock = candidates[0];
  const descriptionBlocks = candidates.filter(block => block !== headingBlock && block.bbox.y >= headingBlock.bbox.y - headingBlock.bbox.height * 4);
  const description = descriptionBlocks
    .slice(0, 3)
    .map(block => block.text)
    .filter(Boolean)
    .join(' ');
  return {
    heading: headingBlock.text,
    description: description || null,
    usedBlockIds: [headingBlock.id, ...descriptionBlocks.map(block => block.id)].filter(Boolean),
  };
}

function canonicalHeaders(headers = []) {
  return headers.map(header => header.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function analysePages(pages = []) {
  const pageSummaries = [];
  const introPages = [];
  const groups = [];

  for (const page of pages) {
    const { intro, reason } = isIntroPage(page);
    const summary = {
      page: page.pageNumber,
      intro,
      reason,
      tables: [],
      textBlocks: page.textBlocks?.length || 0,
      tableCount: page.tables?.length || 0,
    };
    if (intro) {
      introPages.push(page.pageNumber);
    }
    for (const table of page.tables || []) {
      const normalizedHeaders = canonicalHeaders(table.header);
      const headerCount = normalizedHeaders.length;
      const rowCount = table.rows.length;
      const { heading, description, usedBlockIds } = nearestHeading(page, table);
      const group = {
        pageNumber: page.pageNumber,
        header: normalizedHeaders,
        rows: table.rows,
        sourceRows: table.sourceRows,
        heading,
        description,
        usedBlockIds,
        bbox: table.bbox,
        weak: headerCount <= 1,
        rowCount,
      };
      summary.tables.push({ headers: normalizedHeaders, rows: rowCount, weak: group.weak });
      groups.push(group);
    }
    pageSummaries.push(summary);
  }

  return {
    pageSummaries,
    introPages,
    groups,
  };
}
