import { createHash } from 'node:crypto';

const DEFAULT_PAGES_PER_CHUNK = Number.parseInt(process.env.PAGES_PER_CHUNK || '10', 10);

function normalisePageNumber(page, index) {
  if (page && Number.isFinite(page.pageNumber)) {
    return page.pageNumber;
  }
  return index + 1;
}

function buildChunkId(docId, ordinal) {
  const suffix = String(ordinal + 1).padStart(3, '0');
  const prefix = docId ? docId.replace(/[^a-z0-9\-]+/gi, '').slice(-8) : 'doc';
  return `${prefix}-chunk-${suffix}`;
}

function hashChunkText(pages) {
  const hash = createHash('sha256');
  for (const page of pages) {
    const raw = page?.rawText || '';
    hash.update(String(raw));
    if (Array.isArray(page?.textBlocks)) {
      for (const block of page.textBlocks) {
        hash.update('\u0000');
        hash.update(String(block?.text || ''));
      }
    }
  }
  return hash.digest('hex');
}

export function chunkPdfPages(pages = [], { pagesPerChunk = DEFAULT_PAGES_PER_CHUNK, docId = '' } = {}) {
  const window = Math.max(1, Number.isFinite(pagesPerChunk) ? pagesPerChunk : DEFAULT_PAGES_PER_CHUNK);
  const results = [];
  for (let i = 0; i < pages.length; i += window) {
    const slice = pages.slice(i, i + window);
    if (!slice.length) continue;
    const pageStart = normalisePageNumber(slice[0], i);
    const pageEnd = normalisePageNumber(slice[slice.length - 1], i + slice.length - 1);
    const chunkId = buildChunkId(docId, results.length);
    results.push({
      chunkId,
      pageStart,
      pageEnd,
      pages: slice,
      textHash: hashChunkText(slice),
    });
  }
  return results;
}

export function reChunkWithStableWindows(previous = [], pages = [], options = {}) {
  const map = new Map();
  for (const entry of previous) {
    if (entry && entry.pageStart != null && entry.pageEnd != null) {
      map.set(`${entry.pageStart}-${entry.pageEnd}`, entry);
    }
  }
  return chunkPdfPages(pages, options).map(candidate => {
    const key = `${candidate.pageStart}-${candidate.pageEnd}`;
    const prior = map.get(key);
    if (prior) {
      return {
        ...candidate,
        chunkId: prior.chunkId,
      };
    }
    return candidate;
  });
}

export function summariseChunkPages(chunk) {
  return {
    chunkId: chunk.chunkId,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    pageCount: chunk.pages?.length || 0,
    textHash: chunk.textHash,
  };
}

