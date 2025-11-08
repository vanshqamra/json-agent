import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const FIGURE_RE = /^(fig(?:ure)?\.?|image|illustration)\b/i;
const TABLE_ROW_RE = /(\s{2,}|\t|\|)|\d+\s*[x×]\s*\d+/i;
const HEADER_ROW_RE = /[A-Za-z][A-Za-z\s\/()%-]{2,}/;

function normaliseLine(line = '') {
  return line.replace(/\s+/g, ' ').trim();
}

function splitColumns(line) {
  if (!line) return [];
  if (line.includes('|')) {
    return line.split('|').map(s => s.trim()).filter(Boolean);
  }
  const tabSplit = line.split(/\t+/).map(s => s.trim()).filter(Boolean);
  if (tabSplit.length > 1) return tabSplit;
  const multiSpace = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (multiSpace.length > 1) return multiSpace;
  return [normaliseLine(line)];
}

function flushTextBlock(page, buffer) {
  if (!buffer.length) return;
  const text = buffer.join(' ').trim();
  if (!text) {
    buffer.length = 0;
    return;
  }
  const id = `p${page.pageNumber}-t${page.textBlocks.length + 1}`;
  page.textBlocks.push({ id, kind: 'text', text });
  page.segments.push({ id, type: 'text', text });
  buffer.length = 0;
}

function flushTable(page, table) {
  if (!table || !table.rows.length) return;
  const id = `p${page.pageNumber}-tbl${page.tables.length + 1}`;
  const header = table.header.length ? table.header : table.rows[0] || [];
  const dataRows = table.header.length ? table.rows : table.rows.slice(1);
  const normalisedHeader = header.map(normaliseLine).filter(Boolean);
  const rows = dataRows
    .map(row => row.map(normaliseLine))
    .filter(row => row.some(cell => cell));
  if (!rows.length) return;
  const tableRecord = {
    id,
    kind: 'table',
    header: normalisedHeader,
    rows,
    sourceRows: table.sourceRows,
  };
  page.tables.push(tableRecord);
  page.segments.push(tableRecord);
}

function flushImage(page, caption) {
  if (!caption) return;
  const id = `p${page.pageNumber}-img${page.images.length + 1}`;
  const entry = { id, kind: 'image', caption: caption.trim() };
  page.images.push(entry);
  page.segments.push(entry);
}

export function segmentPageText(pageText, pageNumber) {
  const lines = String(pageText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const page = {
    pageNumber,
    rawText: pageText,
    textBlocks: [],
    tables: [],
    images: [],
    segments: [],
  };

  const textBuffer = [];
  let activeTable = null;

  for (const line of lines) {
    if (FIGURE_RE.test(line)) {
      flushTextBlock(page, textBuffer);
      flushTable(page, activeTable);
      activeTable = null;
      flushImage(page, normaliseLine(line));
      continue;
    }

    const looksTabular = TABLE_ROW_RE.test(line);
    if (looksTabular) {
      const columns = splitColumns(line);
      if (columns.length > 1) {
        flushTextBlock(page, textBuffer);
        if (!activeTable) {
          activeTable = { header: [], rows: [], sourceRows: [] };
        }
        if (!activeTable.header.length && columns.every(col => HEADER_ROW_RE.test(col))) {
          activeTable.header = columns;
        } else {
          activeTable.rows.push(columns);
        }
        activeTable.sourceRows.push(line);
        continue;
      }
    }

    if (activeTable) {
      flushTable(page, activeTable);
      activeTable = null;
    }
    textBuffer.push(normaliseLine(line));
  }

  flushTable(page, activeTable);
  flushTextBlock(page, textBuffer);

  return page;
}

export async function extractPagesFromArrayBuffer(arrayBuffer) {
  const buffer = Buffer.isBuffer(arrayBuffer)
    ? arrayBuffer
    : Buffer.from(arrayBuffer);

  const pages = [];
  const result = await pdfParse(buffer, {
    pagerender: async pageData => {
      const textContent = await pageData.getTextContent();
      const rows = [];
      let lastY = null;
      for (const item of textContent.items || []) {
        const text = item.str || '';
        if (!text.trim()) continue;
        const y = Math.round(item.transform[5]);
        if (lastY === null || Math.abs(lastY - y) > 2) {
          rows.push(text);
        } else {
          rows[rows.length - 1] = `${rows[rows.length - 1]} ${text}`;
        }
        lastY = y;
      }
      const pageText = rows.join('\n');
      pages.push(segmentPageText(pageText, pages.length + 1));
      return pageText;
    },
  });

  if (!pages.length) {
    const fallbackText = result.text || '';
    const chunks = fallbackText.includes('\f')
      ? fallbackText.split('\f')
      : fallbackText.split(/\n\s*\n(?=[A-Z0-9].+)/);
    chunks
      .map(chunk => chunk.trim())
      .filter(Boolean)
      .forEach((chunk, idx) => {
        pages.push(segmentPageText(chunk, idx + 1));
      });
  }

  return {
    pages,
    meta: {
      pages: pages.length,
    },
  };
}

export function segmentTextPages(pagesText = []) {
  return pagesText.map((page, idx) => segmentPageText(page, idx + 1));
}
