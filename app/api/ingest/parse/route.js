import path from 'node:path';

import { NextResponse } from 'next/server';

import { extractPagesFromArrayBuffer, segmentTextPages } from '@/lib/pdfSegmenter.js';
import { isOpenAIConfigured } from '@/lib/openaiClient.js';
import { filterPagesByWindow, processPagesToFiles } from '@/lib/blockProcessing.js';
import { ensureDir, getDataDir, writeJson } from '@/lib/io.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const EXTRACTION_VERSION = 'v2.0.0';
const DEFAULT_WINDOW_SIZE = Number(process.env.INGEST_DEFAULT_WINDOW_SIZE || 20);
const WINDOW_SIZE_SEQUENCE = Array.from(
  new Set([DEFAULT_WINDOW_SIZE, 10, 5, 2, 1].filter(size => Number.isFinite(size) && size > 0)),
).sort((a, b) => b - a);

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
    throw new ParseError(
      'Provide a PDF via multipart/form-data (field: file) or JSON with a non-empty pages array.',
      400,
    );
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
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return loadPagesFromJson(req);
  }
  if (contentType.includes('multipart/form-data')) {
    return loadPagesFromFormData(req);
  }
  throw new ParseError(
    'Provide a PDF via multipart/form-data (field: file) or JSON with a non-empty pages array.',
    400,
  );
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

function sanitiseBodyPreview(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    return value.slice(0, 500);
  }
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch (error) {
    return String(error?.message || value).slice(0, 500);
  }
}

function shouldShrinkWindowError(error) {
  const status = error?.status || error?.details?.status;
  if (status === 413) return true;
  const code = String(error?.code || error?.details?.code || '').toUpperCase();
  if (code.includes('PAYLOAD_TOO_LARGE') || code.includes('REQUEST_ENTITY_TOO_LARGE')) {
    return true;
  }
  const message = `${error?.message || ''} ${error?.details?.message || ''}`.toLowerCase();
  if (
    message.includes('token limit') ||
    message.includes('maximum context length') ||
    message.includes('context length') ||
    (message.includes('token') && message.includes('length')) ||
    message.includes('too large')
  ) {
    return true;
  }
  const preview = String(error?.details?.bodyPreview || error?.details?.preview || '').toLowerCase();
  if (preview.includes('request entity too large') || preview.includes('payload too large')) {
    return true;
  }
  return false;
}

function toWindowKey(window) {
  const start = Number.isFinite(window?.start) ? window.start : 0;
  const end = Number.isFinite(window?.end) ? window.end : start;
  return `${start}:${end}`;
}

function buildWindowsFromPages(pages, windowSize) {
  if (!Array.isArray(pages) || !pages.length) return [];
  const size = Math.max(1, Math.floor(windowSize) || 1);
  const sorted = [...pages].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
  const windows = [];
  for (let index = 0; index < sorted.length; index += size) {
    const slice = sorted.slice(index, index + size);
    const start = slice[0]?.pageNumber ?? 0;
    const end = slice[slice.length - 1]?.pageNumber ?? start;
    const window = { start, end };
    const windowPages = filterPagesByWindow(sorted, window).sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
    windows.push({ window, pages: windowPages });
  }
  return windows;
}

async function recordWindowError({ docId, baseDir, window, error, dryRun }) {
  const start = Number.isFinite(window?.start) ? window.start : 0;
  const end = Number.isFinite(window?.end) ? window.end : start;
  const startLabel = String(start).padStart(4, '0');
  const endLabel = String(end).padStart(4, '0');
  const errorId = `error-${startLabel}-${endLabel}-${Date.now().toString(36)}`;
  const status = error?.status || error?.details?.status || 502;
  const errorPayload = {
    message: error?.message || 'Failed to process document window.',
    status,
    code: error?.code || error?.details?.code || undefined,
    bodyPreview: sanitiseBodyPreview(error?.details?.bodyPreview || error?.details?.preview),
    window: { start, end },
    retryable: shouldShrinkWindowError(error),
    occurredAt: new Date().toISOString(),
  };
  if (!errorPayload.code) {
    delete errorPayload.code;
  }
  if (!errorPayload.bodyPreview) {
    delete errorPayload.bodyPreview;
  }

  let localPath;
  let relativePath;
  let writeInfo;
  if (!dryRun) {
    const windowDir = path.join(baseDir, 'parts', `win-${startLabel}-${endLabel}`);
    try {
      await ensureDir(windowDir);
      const filename = `${errorId}.json`;
      const filePath = path.join(windowDir, filename);
      writeInfo = await writeJson(filePath, errorPayload, { pretty: true });
      localPath = filePath;
      relativePath = path.join('parts', `win-${startLabel}-${endLabel}`, filename);
    } catch (writeError) {
      console.warn('Failed to persist window error manifest:', writeError);
    }
  }

  return {
    part_id: errorId,
    start_page: start,
    end_page: end,
    error: errorPayload,
    local_path: localPath,
    relative_path: relativePath,
    bytes: writeInfo?.bytes,
    sha256: writeInfo?.sha256,
  };
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

    const requestUrl = new URL(req.url);
    const docId = requestUrl.searchParams.get('docId');
    if (!docId) {
      throw new ParseError('Missing required docId query parameter.', 400);
    }

    const dataDir = getDataDir(docId);

    const dryRun = (requestUrl.searchParams.get('dryRun') || '').toLowerCase() === 'true';

    if (!dryRun) {
      await ensureDir(dataDir);
    }

    const sequence = WINDOW_SIZE_SEQUENCE.length ? WINDOW_SIZE_SEQUENCE : [DEFAULT_WINDOW_SIZE];
    const baseWindowSize = sequence[0] || DEFAULT_WINDOW_SIZE;
    let segments = buildWindowsFromPages(filteredPages, baseWindowSize);
    if (!segments.length) {
      const first = filteredPages[0]?.pageNumber ?? 1;
      const last = filteredPages[filteredPages.length - 1]?.pageNumber ?? first;
      segments = [{ window: { start: first, end: last }, pages: [...filteredPages] }];
    }

    const parts = [];
    const processedWindows = new Map();
    let successfulParts = 0;

    async function processSegment(segment, sizeIndex = 0) {
      const segmentPages = Array.isArray(segment?.pages)
        ? segment.pages
        : filterPagesByWindow(filteredPages, segment.window);
      if (!segmentPages.length) return;
      const sortedPages = [...segmentPages].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
      const start = sortedPages[0]?.pageNumber ?? segment.window?.start ?? 0;
      const end = sortedPages[sortedPages.length - 1]?.pageNumber ?? segment.window?.end ?? start;
      const windowRange = { start, end };
      if (windowRange.end < windowRange.start) {
        windowRange.end = windowRange.start;
      }

      try {
        const results = await processPagesToFiles({
          docId,
          pages: sortedPages,
          baseDir: dataDir,
          extractionVersion: EXTRACTION_VERSION,
          dryRun,
          pageWindow: windowRange,
        });
        for (const result of results) {
          if (!result) continue;
          if (!result.error || result.status === 'dry-run') {
            successfulParts += 1;
          }
          parts.push(result);
        }
        processedWindows.set(toWindowKey(windowRange), windowRange);
      } catch (error) {
        if (shouldShrinkWindowError(error) && sortedPages.length > 1 && sizeIndex + 1 < sequence.length) {
          const nextSize = sequence[sizeIndex + 1];
          const childSegments = buildWindowsFromPages(sortedPages, nextSize);
          if (childSegments.length) {
            if (childSegments.length === 1 && childSegments[0].pages.length === sortedPages.length) {
              await processSegment(childSegments[0], sizeIndex + 1);
            } else {
              for (const child of childSegments) {
                await processSegment(child, sizeIndex + 1);
              }
            }
            return;
          }
        }
        console.warn(`Window ${windowRange.start}-${windowRange.end} failed:`, error?.message || error);
        const errorPart = await recordWindowError({
          docId,
          baseDir: dataDir,
          window: windowRange,
          error,
          dryRun,
        }).catch(recordError => {
          console.warn('Failed to persist window error:', recordError);
          return {
            part_id: `error-${windowRange.start}-${windowRange.end}-${Date.now().toString(36)}`,
            start_page: windowRange.start,
            end_page: windowRange.end,
            error: {
              message: error?.message || 'Failed to process document window.',
              status: error?.status || error?.details?.status || 500,
            },
          };
        });
        parts.push(errorPart);
        processedWindows.set(toWindowKey(windowRange), windowRange);
      }
    }

    for (const segment of segments) {
      await processSegment(segment, 0);
    }

    if (!parts.length) {
      throw new ParseError('Document did not produce any output parts.', 502);
    }

    if (!successfulParts) {
      throw new ParseError('Failed to extract any document parts.', 502, { parts });
    }

    const pageWindows = Array.from(processedWindows.values()).sort((a, b) => {
      if (a.start === b.start) return a.end - b.end;
      return a.start - b.start;
    });

    const responseBody = {
      docId,
      source,
      extraction_version: EXTRACTION_VERSION,
      page_windows: pageWindows,
      parts,
      storage_path: dryRun ? null : dataDir,
      dry_run: dryRun,
    };

    if (!dryRun) {
      const manifest = {
        ...responseBody,
        generated_at: new Date().toISOString(),
      };
      try {
        const manifestPath = path.join(dataDir, 'manifest.json');
        await writeJson(manifestPath, manifest, { pretty: true });
      } catch (error) {
        console.warn('Failed to write manifest file:', error);
      }
    }

    return NextResponse.json(responseBody, { status: 200 });
  } catch (error) {
    console.error('Ingestion parse failed:', error);
    return buildErrorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
