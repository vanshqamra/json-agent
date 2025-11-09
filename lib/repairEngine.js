import { segmentPageText } from './pdfSegmenter.js';
import { runCatalogPipeline } from './pipeline/catalogPipeline.js';

function clonePages(pages = []) {
  if (typeof structuredClone === 'function') {
    return structuredClone(pages);
  }
  return JSON.parse(JSON.stringify(pages));
}

function stitchWrappedRows(pages = []) {
  for (const page of pages) {
    if (!Array.isArray(page?.tables)) continue;
    for (const table of page.tables) {
      if (!Array.isArray(table?.rows)) continue;
      const headerLength = Array.isArray(table.header) ? table.header.length : 0;
      const stitched = [];
      for (const row of table.rows) {
        if (!stitched.length) {
          stitched.push([...row]);
          continue;
        }
        const candidate = row.filter(cell => cell != null && cell !== '');
        const shouldMerge = headerLength && row.length < headerLength;
        if (shouldMerge) {
          const last = stitched[stitched.length - 1];
          const merged = last.map((cell, idx) => {
            const addon = row[idx] ?? '';
            if (!addon) return cell;
            if (!cell) return addon;
            return `${cell} ${addon}`.trim();
          });
          stitched[stitched.length - 1] = merged;
          continue;
        }
        if (candidate.length === 1 && /₹|rs\.?|\d/.test(candidate[0])) {
          const last = stitched[stitched.length - 1];
          last[last.length - 1] = `${last[last.length - 1] || ''} ${candidate[0]}`.trim();
          continue;
        }
        stitched.push([...row]);
      }
      table.rows = stitched;
    }
  }
}

function applyColumnHints(pages = [], columnHints = new Map()) {
  if (!columnHints.size) return;
  for (const page of pages) {
    if (!Array.isArray(page?.tables)) continue;
    for (const table of page.tables) {
      if (!Array.isArray(table?.header)) continue;
      const header = [...table.header];
      for (const [index, role] of columnHints.entries()) {
        if (index < 0 || index >= header.length) continue;
        header[index] = role;
      }
      table.header = header;
    }
  }
}

function parseRepairs(repairs = []) {
  const adjustments = {
    preferredPatterns: [],
    stitchRows: false,
    resegment: false,
    forcePriceAnchored: false,
    columnHints: new Map(),
    notes: [],
  };

  const COLUMN_RE = /column\s+(\d+)\s*(?:→|->|to)\s*([a-z_]+)/i;
  const PATTERN_RE = /pattern\s+([a-z0-9_\-]+)/i;

  for (const entry of repairs) {
    if (!entry) continue;
    const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
    const lower = text.toLowerCase();
    adjustments.notes.push(text);
    if (/stitch|wrapped/.test(lower)) {
      adjustments.stitchRows = true;
    }
    if (/token|split/.test(lower)) {
      adjustments.resegment = true;
    }
    if (/price/.test(lower)) {
      adjustments.forcePriceAnchored = true;
    }
    const columnMatch = text.match(COLUMN_RE);
    if (columnMatch) {
      const index = Number.parseInt(columnMatch[1], 10) - 1;
      const role = columnMatch[2]?.toLowerCase();
      if (Number.isFinite(index) && role) {
        adjustments.columnHints.set(index, role);
      }
    }
    const patternMatch = text.match(PATTERN_RE);
    if (patternMatch) {
      const patternId = patternMatch[1]?.trim();
      if (patternId) {
        adjustments.preferredPatterns.push(patternId);
      }
    }
  }

  return adjustments;
}

function resegmentPages(pages = []) {
  return pages.map(page => {
    const raw = typeof page?.rawText === 'string' ? page.rawText : '';
    if (!raw) return page;
    const rebuilt = segmentPageText(raw, page.pageNumber);
    return { ...page, ...rebuilt };
  });
}

export async function applyRepairs({ repairs = [], windowContext = {}, pipelineOptions = {} }) {
  const adjustments = parseRepairs(repairs);
  const clonedPages = clonePages(windowContext.pages || []);

  if (adjustments.resegment) {
    const resegmented = resegmentPages(clonedPages);
    clonedPages.length = 0;
    clonedPages.push(...resegmented);
  }

  if (adjustments.columnHints.size) {
    applyColumnHints(clonedPages, adjustments.columnHints);
  }

  if (adjustments.stitchRows) {
    stitchWrappedRows(clonedPages);
  }

  const effectiveOptions = {
    ...pipelineOptions,
    persistArtifacts: false,
    forcePriceAnchored: Boolean(pipelineOptions.forcePriceAnchored || adjustments.forcePriceAnchored),
    patternOptions: {
      ...(pipelineOptions.patternOptions || {}),
      preferredPatterns: adjustments.preferredPatterns.length
        ? adjustments.preferredPatterns
        : pipelineOptions.patternOptions?.preferredPatterns,
    },
  };

  const result = await runCatalogPipeline({
    docId: windowContext.docId,
    pages: clonedPages,
    source: windowContext.source || { filename: 'window', pages: clonedPages.length },
    dataDir: null,
    options: effectiveOptions,
  });

  return {
    result,
    adjustments,
  };
}
