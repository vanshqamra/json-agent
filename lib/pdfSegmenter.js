import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let createCanvasFn = null;
let canvasAvailable = true;
let canvasLoadError = null;
try {
  ({ createCanvas: createCanvasFn } = require('canvas'));
} catch (error) {
  canvasAvailable = false;
  canvasLoadError = error;
}

let createWorkerFactory = null;
let tesseractUnavailable = false;
let tesseractLoadError = null;

async function getCreateWorker() {
  if (tesseractUnavailable) {
    const error = new Error('tesseract_module_unavailable');
    error.code = 'TESSERACT_UNAVAILABLE';
    error.cause = tesseractLoadError;
    throw error;
  }
  if (typeof createWorkerFactory === 'function') {
    return createWorkerFactory;
  }
  try {
    const mod = await import('tesseract.js');
    if (!mod?.createWorker) {
      throw new Error('createWorker export missing');
    }
    createWorkerFactory = mod.createWorker;
    return createWorkerFactory;
  } catch (error) {
    tesseractUnavailable = true;
    tesseractLoadError = error;
    const wrapped = new Error('tesseract_module_unavailable');
    wrapped.code = 'TESSERACT_UNAVAILABLE';
    wrapped.cause = error;
    throw wrapped;
  }
}

function ensureCanvasAvailable() {
  if (!canvasAvailable || typeof createCanvasFn !== 'function') {
    const error = new Error('canvas_module_unavailable');
    error.code = 'CANVAS_UNAVAILABLE';
    error.cause = canvasLoadError;
    throw error;
  }
}

const FIGURE_RE = /^(fig(?:ure)?\.?|image|illustration)\b/i;
const TABLE_ROW_RE = /(\s{2,}|\t|\|)|\d+\s*[x×]\s*\d+/i;
const HEADER_ROW_RE = /[A-Za-z][A-Za-z\s\/()%-]{2,}/;

const PRICE_STRIP_RE = /\s+/g;

let _pdfjs = null;
let _pdfjsPromise = null;
export async function getPdfjs() {
  if (_pdfjs) {
    return _pdfjs;
  }

  if (_pdfjsPromise) {
    return _pdfjsPromise;
  }

  if (typeof window !== 'undefined') {
    throw new Error('pdfjs should not be loaded on the client');
  }

  _pdfjsPromise = (async () => {
    try {
      const pdfjsModule = await import('pdfjs-dist/build/pdf.mjs');
      const pdfjsLib = pdfjsModule?.default ?? pdfjsModule;

      if (pdfjsLib?.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
      }

      _pdfjs = pdfjsLib;
      return _pdfjs;
    } catch (error) {
      console.error('[pdfjs import failed]', error);
      const wrapped = new Error('pdfjs_module_unavailable');
      wrapped.code = 'PDFJS_UNAVAILABLE';
      wrapped.cause = error;
      throw wrapped;
    } finally {
      _pdfjsPromise = null;
    }
  })();

  return _pdfjsPromise;
}

class NodeCanvasFactory {
  create(width, height) {
    ensureCanvasAvailable();
    const canvas = createCanvasFn(Math.max(width, 1), Math.max(height, 1));
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    if (!canvasAndContext?.canvas) return;
    canvasAndContext.canvas.width = Math.max(width, 1);
    canvasAndContext.canvas.height = Math.max(height, 1);
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext?.canvas) return;
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const createWorker = await getCreateWorker();
      const worker = await createWorker({ logger: () => {} });
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      await worker.setParameters({
        preserve_interword_spaces: '1',
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/%₹€$£-.,() ',
        tessedit_pageseg_mode: '6',
        user_defined_dpi: '200',
      });
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

function normaliseLine(line = '') {
  return line.replace(PRICE_STRIP_RE, ' ').trim();
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

function computeCidRatioFromItems(items = []) {
  let total = 0;
  let cid = 0;
  for (const item of items) {
    const text = typeof item?.str === 'string' ? item.str : '';
    for (const char of text) {
      const code = char.codePointAt(0);
      if (!Number.isFinite(code)) continue;
      if (code < 32 || code === 65533 || (code > 126 && code < 160) || code > 255) {
        cid += 1;
      }
      total += 1;
    }
  }
  return total ? cid / total : 0;
}

function computeCidRatioFromText(text = '') {
  let total = 0;
  let cid = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (!Number.isFinite(code)) continue;
    if (code < 32 || code === 65533 || (code > 126 && code < 160) || code > 255) {
      cid += 1;
    }
    total += 1;
  }
  return total ? cid / total : 0;
}

function computeAverageWordLength(lineItems = []) {
  let totalChars = 0;
  let totalWords = 0;
  for (const item of lineItems) {
    const words = String(item.text || '')
      .split(/\s+/)
      .map(word => word.replace(/[^0-9A-Za-z]+/g, ''))
      .filter(Boolean);
    for (const word of words) {
      totalChars += word.length;
      totalWords += 1;
    }
  }
  return totalWords ? totalChars / totalWords : 0;
}

function logTextQuality(pageNumber, metrics) {
  const payload = {
    page: pageNumber,
    cid_ratio: Number(metrics.cid_ratio.toFixed(3)),
    avg_word_len: Number(metrics.avg_word_len.toFixed(2)),
    source: metrics.source,
  };
  console.info('[text_quality]', JSON.stringify(payload));
}

function normaliseTextContentItem(item) {
  const text = String(item?.str || item?.text || '').trim();
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
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

function pushCurrentLine(lineItems, current) {
  if (!current) return;
  const text = current.textParts.join(' ').replace(PRICE_STRIP_RE, ' ').trim();
  if (!text) return;
  lineItems.push({
    text,
    raw: current.textParts.join(' ').trim(),
    bbox: mergeBoundingBoxes(current.boxes),
    tokens: current.tokens.map(token => ({
      text: token.text,
      bbox: token.bbox,
      centerX: token.centerX,
      centerY: token.centerY,
    })),
  });
}

function buildLineItemsFromTextContent(textContent) {
  const lineItems = [];
  let current = null;

  for (const rawItem of textContent.items || []) {
    const token = normaliseTextContentItem(rawItem);
    if (!token) continue;
    const y = Math.round(token.bbox.y);
    if (!current || Math.abs(current.y - y) > 2) {
      if (current) {
        pushCurrentLine(lineItems, current);
      }
      current = {
        y,
        textParts: [token.text],
        boxes: [token.bbox],
        tokens: [token],
      };
      continue;
    }

    current.textParts.push(token.text);
    current.boxes.push(token.bbox);
    current.tokens.push(token);
  }

  pushCurrentLine(lineItems, current);
  return lineItems;
}

function toLineArray(pageText, lineItems) {
  if (Array.isArray(lineItems) && lineItems.length) {
    return lineItems
      .map(item => {
        const rawText = String(item.raw ?? item.text ?? '');
        const text = normaliseLine(rawText);
        if (!text) return null;
        return {
          text,
          raw: rawText,
          bbox: item.bbox || null,
          tokens: Array.isArray(item.tokens) ? item.tokens : [],
        };
      })
      .filter(Boolean);
  }
  return String(pageText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(text => ({ text, raw: text, bbox: null, tokens: [] }));
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
    lineItems: lines,
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

async function renderPageToImage(page, scale = 2) {
  ensureCanvasAvailable();
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  const renderContext = {
    canvasContext: context,
    viewport,
    canvasFactory,
  };
  await page.render(renderContext).promise;
  const buffer = canvas.toBuffer('image/png');
  canvasFactory.destroy({ canvas, context });
  return buffer;
}

async function extractPdfTextFromPage(page) {
  const textContent = await page.getTextContent({ normalizeWhitespace: true });
  const cidRatio = computeCidRatioFromItems(textContent.items || []);
  const lineItems = buildLineItemsFromTextContent(textContent);
  const pageText = lineItems.map(item => item.text).join('\n');
  return { lineItems, pageText, cidRatio };
}

async function extractOcrText(page) {
  ensureCanvasAvailable();
  const worker = await getOcrWorker();
  const imageBuffer = await renderPageToImage(page, 2);
  const { data } = await worker.recognize(imageBuffer, { lang: 'eng' });
  const rawText = String(data?.text || '');
  const lines = rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const lineItems = lines.map(text => ({ text, raw: text, bbox: null, tokens: [] }));
  return {
    lineItems,
    pageText: lines.join('\n'),
    cidRatio: computeCidRatioFromText(rawText),
  };
}

export async function extractPdfText(bufferOrArrayBuffer) {
  const pdfjs = await getPdfjs();
  const data = bufferOrArrayBuffer instanceof Uint8Array
    ? new Uint8Array(
        bufferOrArrayBuffer.buffer,
        bufferOrArrayBuffer.byteOffset,
        bufferOrArrayBuffer.byteLength,
      )
    : new Uint8Array(bufferOrArrayBuffer);

  const loadingTask = pdfjs.getDocument({
    data,
    useWorker: false,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
    disableRange: true,
    cMapUrl: undefined,
    cMapPacked: true,
    enableXfa: false,
  });

  const pdfDocument = await loadingTask.promise;
  const pages = [];
  let warnedAboutCanvas = false;
  let warnedAboutTesseract = false;

  try {
    for (let index = 0; index < pdfDocument.numPages; index += 1) {
      const pageNumber = index + 1;
      const page = await pdfDocument.getPage(pageNumber);
      let pdfText;
      try {
        pdfText = await extractPdfTextFromPage(page);
      } catch (error) {
        pdfText = { lineItems: [], pageText: '', cidRatio: 1 };
        console.warn(`Failed to extract text from page ${pageNumber}:`, error);
      }

      let lineItems = pdfText.lineItems;
      let pageText = pdfText.pageText;
      let cidRatio = pdfText.cidRatio;
      let source = 'pdfjs';

      if (cidRatio > 0.3) {
        try {
          const ocrText = await extractOcrText(page);
          if (ocrText.pageText) {
            lineItems = ocrText.lineItems;
            pageText = ocrText.pageText;
            cidRatio = ocrText.cidRatio;
            source = 'ocr';
          }
        } catch (error) {
          if (error?.code === 'CANVAS_UNAVAILABLE') {
            if (!warnedAboutCanvas) {
              console.warn('OCR fallback skipped because the optional "canvas" dependency is not available.');
              warnedAboutCanvas = true;
            }
          } else if (error?.code === 'TESSERACT_UNAVAILABLE') {
            if (!warnedAboutTesseract) {
              console.warn('OCR fallback skipped because the optional "tesseract.js" dependency is not available.');
              warnedAboutTesseract = true;
            }
          } else {
            console.warn(`OCR fallback failed on page ${pageNumber}:`, error);
          }
        }
      }

      const avgWordLen = computeAverageWordLength(lineItems);
      logTextQuality(pageNumber, { cid_ratio: cidRatio, avg_word_len: avgWordLen, source });

      const pageRecord = segmentPageText(pageText, pageNumber, { lineItems });
      pageRecord.textQuality = { cid_ratio: cidRatio, avg_word_len: avgWordLen, source };
      pages.push(pageRecord);
      page.cleanup?.();
    }
  } finally {
    await pdfDocument.cleanup();
    loadingTask.destroy();
  }

  return {
    pages,
    meta: {
      pages: pages.length,
    },
  };
}

export const extractPagesFromArrayBuffer = extractPdfText;

export function segmentTextPages(pagesText = []) {
  return pagesText.map((page, idx) => segmentPageText(page, idx + 1));
}
