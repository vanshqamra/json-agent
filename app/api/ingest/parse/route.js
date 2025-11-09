import path from 'node:path';
import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { extractPdfText, segmentTextPages } from '@/lib/pdfSegmenter.js';
import { isOpenAIConfigured } from '@/lib/openaiClient.js';
import { ensureDir, getDataDir, writeJson } from '@/lib/io.js';
import { runCatalogPipeline } from '@/lib/pipeline/catalogPipeline.js';
import { runLLMChunkerPipeline } from '@/lib/llmChunker/pipeline.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const EXTRACTION_VERSION = 'v2.1.0';

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
    const { pages } = await extractPdfText(arrayBuffer);
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

export async function POST(req) {
  try {
    const { pages, source } = await loadPages(req);

    const pageWindow = parsePageWindow(req, source.pages);
    const filteredPages = applyPageWindow(pages, pageWindow);
    if (!filteredPages.length) {
      throw new ParseError('Requested page range does not contain any pages.', 400);
    }

    const requestUrl = new URL(req.url);
    let docId = requestUrl.searchParams.get('docId');
    if (!docId) {
      if (typeof nodeRandomUUID === 'function') {
        docId = nodeRandomUUID();
      } else if (typeof globalThis.crypto?.randomUUID === 'function') {
        docId = globalThis.crypto.randomUUID();
      } else {
        const randomPart = Math.random().toString(36).slice(2, 10);
        const timestampPart = Date.now().toString(36);
        docId = `doc-${timestampPart}-${randomPart}`;
      }
    }

    const dataDir = getDataDir(docId);

    const dryRun = (requestUrl.searchParams.get('dryRun') || '').toLowerCase() === 'true';

    if (!dryRun) {
      await ensureDir(dataDir);
    }
    const llmEnvSetting = (process.env.INGEST_LLM_ENABLED || 'true').toLowerCase();
    const useLLM = llmEnvSetting !== 'false' && isOpenAIConfigured();

    const forcePriceAnchored = ['1', 'true', 'yes'].includes(
      (requestUrl.searchParams.get('forcePriceAnchored') || '').toLowerCase(),
    );

    const chunkerToggle = (requestUrl.searchParams.get('useLLMChunker') || '').toLowerCase();
    const envLLMChunker = (process.env.USE_LLM_CHUNKER || '').toLowerCase();
    const useLLMChunker =
      ['1', 'true', 'yes'].includes(chunkerToggle) ||
      (!['0', 'false', 'no'].includes(chunkerToggle) && ['1', 'true', 'yes'].includes(envLLMChunker));

    const pipelineRunner = useLLMChunker
      ? runLLMChunkerPipeline({
          docId,
          pages: filteredPages,
          dataDir: dryRun ? null : dataDir,
          options: {
            pagesPerChunk: Number.parseInt(requestUrl.searchParams.get('pagesPerChunk') || '', 10) || undefined,
            concurrency: Number.parseInt(requestUrl.searchParams.get('concurrency') || '', 10) || undefined,
            maxUsd: requestUrl.searchParams.get('maxUsd')
              ? Number.parseFloat(requestUrl.searchParams.get('maxUsd'))
              : undefined,
            forcePriceAnchored,
            useCache: !(['1', 'true'].includes((requestUrl.searchParams.get('nocache') || '').toLowerCase())),
          },
        })
      : runCatalogPipeline({
          docId,
          pages: filteredPages,
          source,
          dataDir: dryRun ? null : dataDir,
          options: {
            useLLM,
            persistArtifacts: !dryRun,
            forcePriceAnchored,
          },
        });

    const pipelineResult = await pipelineRunner.catch(error => {
      console.error('Catalog pipeline crashed:', error);
      return {
        version: EXTRACTION_VERSION,
        status: 'error',
        groups: [],
        notes: [],
        diagnostics: {
          pipeline_error: {
            message: error?.message || 'unknown pipeline failure',
          },
        },
        warnings: [`pipeline_failed:${error?.message || 'unknown'}`],
        validation: { errors: [], warnings: [] },
        artifacts: {},
        pagesPreview: filteredPages.slice(0, 5).map(page => ({
          pageNumber: page.pageNumber,
          rawText: page.rawText?.slice(0, 240) || '',
        })),
      };
    });

    const filteredSource = {
      ...source,
      pages: filteredPages.length,
    };

    const responseBody = {
      docId,
      source: filteredSource,
      extraction_version: pipelineResult.version || EXTRACTION_VERSION,
      status: pipelineResult.status || 'partial',
      llm: {
        enabled: llmEnvSetting !== 'false',
        configured: isOpenAIConfigured(),
        used: Boolean(pipelineResult?.diagnostics?.labeling?.llmUsed),
      },
      diagnostics: pipelineResult.diagnostics || {},
      warnings: pipelineResult.warnings || [],
      validation: pipelineResult.validation || { errors: [], warnings: [] },
      groups: pipelineResult.groups || [],
      notes: pipelineResult.notes || [],
      artifacts: pipelineResult.artifacts || {},
      pages_preview: pipelineResult.pagesPreview || [],
      dry_run: dryRun,
      page_window: pageWindow,
      price_anchored_forced: forcePriceAnchored,
    };

    if (!dryRun) {
      const manifest = {
        docId,
        generated_at: new Date().toISOString(),
        source: filteredSource,
        extraction_version: responseBody.extraction_version,
        status: responseBody.status,
        warnings: responseBody.warnings,
        artifacts: responseBody.artifacts,
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
