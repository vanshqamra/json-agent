import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { tokenizeAndClassify } from '@/lib/tokenize.js';
import { markNoise } from '@/lib/noiseFilter.js';
import { detectGroups } from '@/lib/groupDetector.js';
import { assembleVariants } from '@/lib/variantAssembler.js';
import { normalizeGroup } from '@/lib/specNormalizer.js';
import { postProcess } from '@/lib/postProcessor.js';
import { maybeEscalateWithLLM } from '@/lib/llmAssist.js';

async function readPagesFromRequest(req) {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body = await req.json();
    const pages = Array.isArray(body?.pages) ? body.pages : [];
    if (!pages.length) throw new Error('JSON payload must include non-empty "pages" array');
    return pages.map(p => String(p || ''));
  }

  const formData = await req.formData();
  const file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('No file uploaded');
  }

  const arrayBuf = await file.arrayBuffer();
  const pdfData = await pdfParse(Buffer.from(arrayBuf));
  const text = pdfData?.text || '';
  if (!text.trim()) throw new Error('Uploaded PDF appears to be empty');

  return text.includes('\f')
    ? text.split('\f')
    : text.split(/\n\s*\n(?=[A-Z0-9].+)/).filter(Boolean);
}

async function enhanceLowConfidenceBlocks(pages) {
  for (const page of pages) {
    const patchedBlocks = [];
    for (const block of page.blocks) {
      const candidate = { ...block };
      const lowConfidence =
        candidate.type === 'garbage' ||
        candidate.type === 'text' ||
        (candidate.type === 'spec_row' && !/\d/.test(candidate.text));

      if (lowConfidence) {
        const llmHint = await maybeEscalateWithLLM(
          { text: candidate.text, metrics: candidate.metrics, type: candidate.type },
          'uncertain_classification'
        );
        if (llmHint?.suggestedType) candidate.type = llmHint.suggestedType;
        if (llmHint?.normalized) candidate.normalized = llmHint.normalized;
      }

      patchedBlocks.push(candidate);
    }
    page.blocks = patchedBlocks;
  }

  return pages;
}

export async function POST(req) {
  try {
    const rawPages = await readPagesFromRequest(req);
    if (!rawPages.length) {
      return NextResponse.json(
        { error: { code: 'NO_PAGES', message: 'No page content found in request' } },
        { status: 400 }
      );
    }

    const tokenized = await tokenizeAndClassify(rawPages);
    const refined = await enhanceLowConfidenceBlocks([...tokenized]);
    const withNoise = markNoise(refined);
    const rawGroups = detectGroups(withNoise);

    const groups = [];
    for (const rawGroup of rawGroups) {
      const assembledGroup = assembleVariants(rawGroup, { windowSize: 3 });
      const blockSummary = (rawGroup.blocks || [])
        .slice(0, 6)
        .map(b => b.text)
        .join(' ');
      const normalizedGroup = await normalizeGroup({
        ...assembledGroup,
        title: rawGroup.title,
        pageStart: rawGroup.pageStart,
        description:
          rawGroup.lines?.map(l => l.text).join(' ') ||
          rawGroup.description ||
          blockSummary
      });
      groups.push(normalizedGroup);
    }

    const processedGroups = await postProcess(groups);
    const finalGroups = processedGroups.filter(group => (group.variants?.length || 0) > 0);

    const body = {
      meta: {
        pages: rawPages.length,
        variants_total: finalGroups.reduce((sum, group) => sum + (group.variants?.length || 0), 0),
        groups_total: finalGroups.length
      },
      pages_preview: withNoise.slice(0, 2),
      groups: finalGroups
    };

    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    const message = error?.message || 'Unknown error';
    const status = /no file uploaded|empty/i.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        error: {
          code: status === 400 ? 'INVALID_REQUEST' : 'INGEST_FAILED',
          message,
          details: isDevelopment() ? { stack: error?.stack } : undefined
        }
      },
      { status }
    );
  }
}

function isDevelopment() {
  return process.env.NODE_ENV !== 'production';
}

export async function GET() {
  return NextResponse.json({ ok: true });
}

