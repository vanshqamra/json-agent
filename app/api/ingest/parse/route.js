import { NextResponse } from 'next/server';

import { extractPagesFromArrayBuffer, segmentTextPages } from '@/lib/pdfSegmenter.js';
import { isOpenAIConfigured } from '@/lib/openaiClient.js';
import {
  buildAutomaticPageWindows,
  filterPagesByWindow,
  processPagesToFiles,
} from '@/lib/blockProcessing.js';
import { ensureDir, getDataDir } from '@/lib/io.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const EXTRACTION_VERSION = 'v2.0.0';

class ParseError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.name = 'ParseError';
    this.status = status;
    this.details = details;
  }
}

async function loadPagesFromJson(req) {
  const body = await req.json();
  const pages = Array.isArray(body?.pages) ? body.pages.map(page => String(page || '')) : [];
  if (!pages.length) {
    throw new ParseError('JSON payload must include a non-empty "pages" array.', 400);
  }
  const segmented = segmentTextPages(pages);
  if (!segmented.length) {
    throw new ParseError('Unable to segment provided pages.', 422);
  }
  return {
    pages: segmented,
    source: {
      filename: body?.filename || 'inline.json',
      pages: segmented.length,
    },
  };
}

async function loadPagesFromFormData(req) {
  const formData = await req.formData();
  const file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new ParseError('No file uploaded', 400);
  }
  const filename = file.name || 'uploaded.pdf';
  const arrayBuffer = await file.arrayBuffer();
  if (!arrayBuffer || !arrayBuffer.byteLength) {
    throw new ParseError('Uploaded PDF appears to be empty.', 400);
  }
  if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ParseError('Uploaded PDF is larger than 25MB. Please split the file and retry.', 413);
  }
  try {
    const { pages } = await extractPagesFromArrayBuffer(arrayBuffer);
    if (!pages.length) {
      throw new ParseError('Unable to extract any pages from uploaded PDF.', 422);
    }
    return {
      pages,
      source: {
        filename,
        pages: pages.length,
      },
    };
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(`PDF parsing failed: ${err?.message || 'unknown error'}`, 500);
  }
}

async function loadPages(req) {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return loadPagesFromJson(req);
  }
  return loadPagesFromFormData(req);
}

function buildErrorResponse(error) {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
  const body = {
    error: {
      code: status >= 500 ? 'INGEST_FAILED' : 'INVALID_REQUEST',
      message: error?.message || 'Unknown error',
      status,
      details: error?.details,
    },
  };
  if (process.env.NODE_ENV !== 'production' && error?.stack) {
    body.error.stack = error.stack;
  }
  return NextResponse.json(body, { status });
}

function parsePageWindow(req, totalPages = 0) {
  try {
    const url = new URL(req.url);
    const startParam = url.searchParams.get('startPage') ?? url.searchParams.get('start_page');
    const endParam = url.searchParams.get('endPage') ?? url.searchParams.get('end_page');
    if (!startParam && !endParam) return null;
    const startValue = startParam ? Number.parseInt(startParam, 10) : 1;
    const endValue = endParam ? Number.parseInt(endParam, 10) : totalPages;
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
      throw new ParseError('Invalid page range parameters provided.', 400);
    }
    const start = Math.max(1, Math.min(startValue, totalPages || startValue));
    const end = Math.max(start, Math.min(endValue, totalPages || endValue));
    return { start, end };
  } catch (err) {
    if (err instanceof ParseError) throw err;
    return null;
  }
}

function applyPageWindow(pages, pageWindow) {
  if (!pageWindow) return pages;
  return pages.filter(page => page.pageNumber >= pageWindow.start && page.pageNumber <= pageWindow.end);
}

export async function POST(req) {
  try {
    const { pages, source } = await loadPages(req);

    const pageWindow = parsePageWindow(req, source.pages);
    const filteredPages = applyPageWindow(pages, pageWindow);
    if (!filteredPages.length) {
      throw new ParseError('Requested page range does not contain any pages.', 400);
    }

    if (!isOpenAIConfigured()) {
      throw new ParseError('OpenAI API key is not configured for ingestion.', 503);
    }

    const url = new URL(req.url);
    const docId = url.searchParams.get('docId');
    if (!docId) {
      throw new ParseError('Missing required docId query parameter.', 400);
    }

    const dataDir = getDataDir(docId);
    await ensureDir(dataDir);

    let windows = pageWindow
      ? [pageWindow]
      : buildAutomaticPageWindows(source.pages || pages.length, 20);
    if (!windows.length) {
      const first = filteredPages[0]?.pageNumber ?? 1;
      const last = filteredPages[filteredPages.length - 1]?.pageNumber ?? first;
      windows = [{ start: first, end: last }];
    }
    const summaries = [];

    for (const window of windows) {
      const windowPages = filterPagesByWindow(pages, window);
      if (!windowPages.length) continue;
      const results = await processPagesToFiles({
        docId,
        pages: windowPages,
        baseDir: dataDir,
      });
      summaries.push(...results);
    }

    const responseBody = {
      docId,
      source,
      extraction_version: EXTRACTION_VERSION,
      page_windows: windows,
      parts: summaries,
      storage_path: dataDir,
    };

    return NextResponse.json(responseBody, { status: 200 });
  } catch (error) {
    console.error('Ingestion parse failed:', error);
    return buildErrorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
