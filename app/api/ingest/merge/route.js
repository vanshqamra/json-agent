import { NextResponse } from 'next/server';

import { mergeDocParts } from '@/lib/mergeParts.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

class MergeError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.name = 'MergeError';
    this.status = status;
    this.details = details;
  }
}

function buildErrorResponse(error) {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
  const payload = {
    error: {
      code: status >= 500 ? 'MERGE_FAILED' : 'INVALID_REQUEST',
      message: error?.message || 'Unknown error',
      status,
      details: error?.details,
    },
  };
  if (process.env.NODE_ENV !== 'production' && error?.stack) {
    payload.error.stack = error.stack;
  }
  return NextResponse.json(payload, { status });
}

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const docId = url.searchParams.get('docId');
    if (!docId) {
      throw new MergeError('Missing required docId query parameter.', 400);
    }
    const { mergedPath, merged } = await mergeDocParts(docId);
    console.log(`[ingest] streaming merged catalog for ${docId} from ${mergedPath}`);
    return new NextResponse(JSON.stringify(merged), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Merge route failed:', error);
    return buildErrorResponse(error);
  }
}

export async function POST() {
  return NextResponse.json({ ok: false, message: 'Use GET with docId to merge documents.' }, { status: 405 });
}
