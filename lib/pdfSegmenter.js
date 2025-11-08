let pdfParseModulePromise = null;

async function getPdfParse() {
  if (!pdfParseModulePromise) {
    pdfParseModulePromise = import('pdf-parse')
      .then(mod => mod.default || mod)
      .catch(error => {
        pdfParseModulePromise = null;
        throw error;
      });
  }
  return pdfParseModulePromise;
}

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

function mergeBoundingBoxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  const minX = Math.min(...valid.map(box => box.x));
  const minY = Math.min(...valid.map(box => box.y));
  const maxX = Math.max(...valid.map(box => box.x + box.width));
  const maxY = Math.max(...valid.map(box => box.y + box.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function flushTextBlock(page, buffer, boxes) {
  if (!buffer.length) return;
  const text = buffer.join(' ').trim();
  if (!text) {
    buffer.length = 0;
    boxes.length = 0;
    return;
  }
  const id = `p${page.pageNumber}-t${page.textBlocks.length + 1}`;
  const bbox = mergeBoundingBoxes(boxes);
  const record = { id, kind: 'text', text, bbox, pageNumber: page.pageNumber };
  page.textBlocks.push(record);
  page.blocks.push(record);
  page.segments.push({ id, type: 'text', text, bbox });
  buffer.length = 0;
  boxes.length = 0;
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
  const bbox = mergeBoundingBoxes(table.boxes || []);
  const tableRecord = {
    id,
    kind: 'table',
    header: normalisedHeader,
    rows,
    sourceRows: table.sourceRows,
    bbox,
    pageNumber: page.pageNumber,
    text: [...normalisedHeader, ...rows.flat()].join(' '),
  };
  page.tables.push(tableRecord);
  page.blocks.push(tableRecord);
  page.segments.push(tableRecord);
}

function flushImage(page, caption) {
  if (!caption) return;
  const id = `p${page.pageNumber}-img${page.images.length + 1}`;
  const entry = { id, kind: 'image', caption: caption.trim(), pageNumber: page.pageNumber };
  page.images.push(entry);
  page.blocks.push(entry);
  page.segments.push(entry);
}

function toLineArray(pageText, lineItems) {
  if (Array.isArray(lineItems) && lineItems.length) {
    return lineItems
      .map(item => ({
        text: normaliseLine(item.text || ''),
        bbox: item.bbox || null,
      }))
      .filter(item => item.text);
  }
  return String(pageText || '')
    .split(/\r?\n/)
    .map(line => normaliseLine(line))
    .filter(Boolean)
    .map(text => ({ text, bbox: null }));
}

export function segmentPageText(pageText, pageNumber, options = {}) {
  const { lineItems = null } = options;
  const lines = toLineArray(pageText, lineItems);

  const page = {
    pageNumber,
    rawText: pageText,
    textBlocks: [],
    tables: [],
    images: [],
    segments: [],
    blocks: [],
  };

  const textBuffer = [];
  const textBoxes = [];
  let activeTable = null;

  for (const line of lines) {
    if (FIGURE_RE.test(line.text)) {
      flushTextBlock(page, textBuffer, textBoxes);
      flushTable(page, activeTable);
      activeTable = null;
      flushImage(page, normaliseLine(line.text));
      continue;
    }

    const looksTabular = TABLE_ROW_RE.test(line.text);
    if (looksTabular) {
      const columns = splitColumns(line.text);
      if (columns.length > 1) {
        flushTextBlock(page, textBuffer, textBoxes);
        if (!activeTable) {
          activeTable = { header: [], rows: [], sourceRows: [], boxes: [] };
        }
        if (!activeTable.header.length && columns.every(col => HEADER_ROW_RE.test(col))) {
          activeTable.header = columns;
        } else {
          activeTable.rows.push(columns);
        }
        activeTable.sourceRows.push(line.text);
        activeTable.boxes.push(line.bbox || null);
        continue;
      }
    }

    if (activeTable) {
      flushTable(page, activeTable);
      activeTable = null;
    }
    textBuffer.push(normaliseLine(line.text));
    textBoxes.push(line.bbox || null);
  }

  flushTable(page, activeTable);
  flushTextBlock(page, textBuffer, textBoxes);

  return page;
}

function normaliseLineItem(item) {
  const text = String(item?.str || item?.text || '').trim();
  if (!text) return null;
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const x = Number.isFinite(transform[4]) ? transform[4] : 0;
  const y = Number.isFinite(transform[5]) ? transform[5] : 0;
  const width = Number.isFinite(item.width)
    ? item.width
    : Number.isFinite(transform[0])
    ? Math.abs(transform[0])
    : text.length * 5;
  const height = Number.isFinite(item.height)
    ? item.height
    : Number.isFinite(transform[3])
    ? Math.abs(transform[3])
    : 10;
  return {
    text,
    bbox: {
      x,
      y,
      width,
      height,
    },
  };
}

function buildLineItemsFromTextContent(textContent) {
  const lineItems = [];
  let current = null;

  for (const rawItem of textContent.items || []) {
    const item = normaliseLineItem(rawItem);
    if (!item) continue;
    const y = Math.round(item.bbox.y);
    if (!current || Math.abs(current.y - y) > 2) {
      if (current) {
        lineItems.push({
          text: current.text.join(' '),
          bbox: mergeBoundingBoxes(current.boxes),
        });
      }
      current = {
        y,
        text: [item.text],
        boxes: [item.bbox],
      };
      continue;
    }

    current.text.push(item.text);
    current.boxes.push(item.bbox);
  }

  if (current) {
    lineItems.push({
      text: current.text.join(' '),
      bbox: mergeBoundingBoxes(current.boxes),
    });
  }

  return lineItems;
}

export async function extractPagesFromArrayBuffer(arrayBuffer) {
  const pdfParse = await getPdfParse();
  const buffer = Buffer.isBuffer(arrayBuffer)
    ? arrayBuffer
    : Buffer.from(arrayBuffer);

  const pages = [];
  const result = await pdfParse(buffer, {
    pagerender: async pageData => {
      const textContent = await pageData.getTextContent();
      const lineItems = buildLineItemsFromTextContent(textContent);
      const pageText = lineItems.map(item => item.text).join('\n');
      pages.push(segmentPageText(pageText, pages.length + 1, { lineItems }));
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
