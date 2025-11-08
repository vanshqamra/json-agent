import fs from 'fs/promises';
import path from 'path';

let pdfParsePromise = null;
async function getPdfParse() {
  if (!pdfParsePromise) {
    pdfParsePromise = import('pdf-parse')
      .then(mod => mod.default || mod)
      .catch(err => {
        pdfParsePromise = null;
        throw err;
      });
  }
  return pdfParsePromise;
}

function normaliseLineItem(item) {
  const text = String(item?.str ?? item?.text ?? '').trim();
  if (!text) return null;
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(transform[4]) ? transform[4] : 0;
  const y = Number.isFinite(transform[5]) ? transform[5] : 0;
  const width = Number.isFinite(item?.width)
    ? item.width
    : Number.isFinite(transform[0])
    ? Math.abs(transform[0])
    : text.length * 5;
  const height = Number.isFinite(item?.height)
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
    fontName: item?.fontName ?? null,
    transform,
  };
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

function buildLineItems(textContent) {
  const lineItems = [];
  let current = null;
  for (const rawItem of textContent.items || []) {
    const item = normaliseLineItem(rawItem);
    if (!item) continue;
    const yKey = Math.round(item.bbox.y);
    if (!current || Math.abs(current.yKey - yKey) > 2) {
      if (current) {
        lineItems.push({
          text: current.text.join(' '),
          bbox: mergeBoundingBoxes(current.boxes),
          items: current.items,
        });
      }
      current = {
        yKey,
        text: [item.text],
        boxes: [item.bbox],
        items: [item],
      };
      continue;
    }
    current.text.push(item.text);
    current.boxes.push(item.bbox);
    current.items.push(item);
  }
  if (current) {
    lineItems.push({
      text: current.text.join(' '),
      bbox: mergeBoundingBoxes(current.boxes),
      items: current.items,
    });
  }
  return lineItems;
}

function splitIntoLines(text, lineItems) {
  if (Array.isArray(lineItems) && lineItems.length) {
    return lineItems.map(item => ({
      text: item.text.trim(),
      bbox: item.bbox,
      items: item.items,
    }));
  }
  return String(text || '')
    .split(/\r?\n/)
    .map(line => ({ text: line.trim(), bbox: null, items: [] }))
    .filter(line => line.text);
}

function splitColumnsFromItems(items, tolerance = 6) {
  if (!Array.isArray(items) || !items.length) return [];
  const sorted = [...items].sort((a, b) => a.bbox.x - b.bbox.x);
  const clusters = [];
  let current = [];
  let lastX = null;
  for (const item of sorted) {
    if (lastX == null || Math.abs(item.bbox.x - lastX) <= tolerance) {
      current.push(item);
    } else {
      clusters.push(current);
      current = [item];
    }
    lastX = item.bbox.x + item.bbox.width;
  }
  if (current.length) clusters.push(current);
  return clusters.map(cluster => ({
    text: cluster.map(it => it.text).join(' ').trim(),
    bbox: mergeBoundingBoxes(cluster.map(it => it.bbox)),
  }));
}

function detectTableColumns(line) {
  if (!line) return [];
  const text = line.text || '';
  if (!text) return [];
  if (text.includes('|')) {
    return text.split('|').map(s => s.trim()).filter(Boolean);
  }
  if (/\t/.test(text)) {
    return text.split(/\t+/).map(s => s.trim()).filter(Boolean);
  }
  if (/\s{2,}/.test(text)) {
    return text.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  }
  const cells = splitColumnsFromItems(line.items || []);
  if (cells.length > 1) return cells.map(cell => cell.text);
  return [text.trim()];
}

function segmentPage(lines, pageNumber) {
  const segments = [];
  const tables = [];
  const textBlocks = [];
  const images = [];

  const buffer = [];
  const bufferBoxes = [];
  let activeTable = null;

  const flushText = () => {
    if (!buffer.length) return;
    const text = buffer.join(' ').trim();
    if (!text) {
      buffer.length = 0;
      bufferBoxes.length = 0;
      return;
    }
    const id = `p${pageNumber}-t${textBlocks.length + 1}`;
    const bbox = mergeBoundingBoxes(bufferBoxes);
    const block = { id, kind: 'text', text, bbox, pageNumber };
    textBlocks.push(block);
    segments.push(block);
    buffer.length = 0;
    bufferBoxes.length = 0;
  };

  const flushTable = () => {
    if (!activeTable || !activeTable.rows.length) return;
    const id = `p${pageNumber}-tbl${tables.length + 1}`;
    const header = activeTable.header.length ? activeTable.header : activeTable.rows[0] || [];
    const rows = activeTable.header.length ? activeTable.rows : activeTable.rows.slice(1);
    const table = {
      id,
      kind: 'table',
      header: header.map(h => h.trim()).filter(Boolean),
      rows: rows.map(row => row.map(cell => (cell ?? '').trim())),
      sourceRows: activeTable.sourceRows.slice(),
      bbox: mergeBoundingBoxes(activeTable.boxes),
      pageNumber,
    };
    tables.push(table);
    segments.push(table);
    activeTable = null;
  };

  for (const line of lines) {
    const text = line.text || '';
    if (!text) continue;

    if (/^(fig(?:ure)?|image|illustration)/i.test(text)) {
      flushText();
      flushTable();
      images.push({
        id: `p${pageNumber}-img${images.length + 1}`,
        kind: 'image',
        caption: text.trim(),
        bbox: line.bbox,
        pageNumber,
      });
      continue;
    }

    const cells = detectTableColumns(line);
    const looksTable = cells.length > 1 && cells.some(cell => /\d/.test(cell))
      ? true
      : cells.length > 1 && cells.every(cell => cell.length <= 40);
    const headerLike = cells.length > 1 && cells.every(cell => /[A-Za-z]/.test(cell));

    if (looksTable) {
      flushText();
      if (!activeTable) {
        activeTable = { header: [], rows: [], sourceRows: [], boxes: [] };
      }
      if (!activeTable.header.length && headerLike) {
        activeTable.header = cells;
      } else {
        activeTable.rows.push(cells);
      }
      activeTable.sourceRows.push(text);
      activeTable.boxes.push(line.bbox);
      continue;
    }

    flushTable();
    buffer.push(text.trim());
    bufferBoxes.push(line.bbox);
  }

  flushTable();
  flushText();

  return {
    pageNumber,
    segments,
    tables,
    textBlocks,
    images,
    rawLines: lines,
  };
}

export async function extractPdf(filePath, { startPage = 1, endPage = 10 } = {}) {
  const resolved = path.resolve(filePath);
  const data = await fs.readFile(resolved);
  const pdfParse = await getPdfParse();
  const pages = [];
  const seenPages = new Set();
  await pdfParse(data, {
    max: endPage,
    pagerender: async pageData => {
      const pageIndex = pageData.pageIndex ?? pageData.pageNumber - 1;
      const pageNumber = pageIndex + 1;
      if (pageNumber < startPage || pageNumber > endPage) {
        return '';
      }
      const textContent = await pageData.getTextContent();
      const lineItems = buildLineItems(textContent);
      const lines = splitIntoLines(
        lineItems.map(item => item.text).join('\n'),
        lineItems
      );
      const page = segmentPage(lines, pageNumber);
      pages.push(page);
      seenPages.add(pageNumber);
      return lines.map(line => line.text).join('\n');
    },
  });

  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  return {
    filePath: resolved,
    pages,
    pagesProcessed: pages.length,
  };
}

export const __test__ = {
  splitColumnsFromItems,
  detectTableColumns,
  segmentPage,
};
