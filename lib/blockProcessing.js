import path from 'path';

import { getOpenAIClient, isOpenAIConfigured } from './openaiClient.js';
import { ensureDir, writeJson } from './io.js';

const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-4.1-mini';
const MAX_CHARS_PER_BATCH = Number(process.env.INGEST_MAX_BATCH_CHARS || 20000);
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateBlockSize(block) {
  const meta = 64;
  const textLength = (block.promptText || block.text || '').length;
  return textLength + meta;
}

function normaliseWhitespace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function makePromptBlock(block, index) {
  const safeText = normaliseWhitespace(block.promptText || block.text || '');
  const bbox = block.bbox
    ? `bbox=${block.bbox.x.toFixed(1)},${block.bbox.y.toFixed(1)},${block.bbox.width.toFixed(
        1,
      )},${block.bbox.height.toFixed(1)}`
    : 'bbox=unknown';
  const base = [`[${index}] id=${block.id} page=${block.pageNumber} type=${block.kind || 'text'} ${bbox}`];
  if (block.kind === 'table') {
    if (Array.isArray(block.header) && block.header.length) {
      base.push(`HEADER: ${block.header.join(' | ')}`);
    }
    for (const row of block.rows || []) {
      base.push(`ROW: ${row.join(' | ')}`);
    }
    if (!safeText && Array.isArray(block.sourceRows)) {
      base.push(`RAW: ${block.sourceRows.join(' || ')}`);
    }
  }
  if (safeText) {
    base.push(`TEXT: ${safeText}`);
  }
  return base.join('\n');
}

function buildUserPrompt(blocks) {
  const intro = [
    'Analyze the following catalog blocks.',
    'Return a JSON object with a single property "blocks" (array).',
    'Each array entry must include "blockId" (string), "label" (one of intro | product_table | image_legend | other), and "rows" (array).',
    'Only include product rows for blocks labeled product_table. When unsure, use an empty array for rows.',
  ];
  const lines = blocks.map((block, idx) => makePromptBlock(block, idx));
  return `${intro.join(' ')}\n\n${lines.join('\n\n')}`;
}

function formatBlockForPrompt(block) {
  const promptText = block.kind === 'table'
    ? [...(block.header || []), ...(block.rows || []).flat()]
        .map(cell => normaliseWhitespace(cell))
        .filter(Boolean)
        .join(' ')
    : block.text;
  return {
    ...block,
    promptText: normaliseWhitespace(promptText || block.text || ''),
  };
}

function isPayloadTooLarge(error) {
  const message = String(error?.message || error);
  return error?.status === 413 || message.includes('413');
}

function isRateLimited(error) {
  const status = error?.status || error?.response?.status;
  return status === 429;
}

function isServerError(error) {
  const status = error?.status || error?.response?.status;
  return status >= 500 && status < 600;
}

async function callModel(blocks) {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI client is not configured');
  }
  const client = getOpenAIClient();
  const messages = [
    { role: 'system', content: 'You are a strict JSON generator. Never output text outside JSON.' },
    { role: 'user', content: buildUserPrompt(blocks) },
  ];
  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages,
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Model returned an empty response');
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Model response was not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed?.blocks)) {
    throw new Error('Model response missing "blocks" array');
  }
  return parsed.blocks.map(entry => ({
    blockId: entry.blockId || entry.id,
    label: entry.label || 'other',
    rows: Array.isArray(entry.rows) ? entry.rows : [],
  }));
}

async function callModelWithRetry(blocks, attempt = 0) {
  try {
    return await callModel(blocks);
  } catch (error) {
    if ((isRateLimited(error) || isServerError(error)) && attempt + 1 < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.warn(`[ingest] retrying batch after error (attempt ${attempt + 1}):`, error.message);
      await sleep(delay);
      return callModelWithRetry(blocks, attempt + 1);
    }
    throw error;
  }
}

async function callModelOrSplit(blocks) {
  if (blocks.length === 0) return [];
  const totalChars = blocks.reduce((sum, block) => sum + estimateBlockSize(block), 0);
  if (totalChars > MAX_CHARS_PER_BATCH && blocks.length > 1) {
    const mid = Math.floor(blocks.length / 2);
    console.log(
      `[ingest] pre-splitting batch of ${blocks.length} blocks (size=${totalChars}) into ${mid} and ${blocks.length - mid}`,
    );
    const left = await callModelOrSplit(blocks.slice(0, mid));
    const right = await callModelOrSplit(blocks.slice(mid));
    return [...left, ...right];
  }
  try {
    return await callModelWithRetry(blocks);
  } catch (error) {
    if (isPayloadTooLarge(error) && blocks.length > 1) {
      const mid = Math.floor(blocks.length / 2);
      console.warn(`[ingest] 413 received, splitting batch into ${mid} and ${blocks.length - mid}`);
      const left = await callModelOrSplit(blocks.slice(0, mid));
      const right = await callModelOrSplit(blocks.slice(mid));
      return [...left, ...right];
    }
    throw error;
  }
}

function collectBlocks(pages) {
  return pages.flatMap(page => (Array.isArray(page.blocks) ? page.blocks : []));
}

function groupBlocksByCharLimit(blocks) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const block of blocks) {
    const formatted = formatBlockForPrompt(block);
    const blockSize = estimateBlockSize(formatted);
    if (current.length && size + blockSize > MAX_CHARS_PER_BATCH) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(formatted);
    size += blockSize;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function buildBatchFilename(range, batchIndex = 0) {
  const start = String(range.start).padStart(4, '0');
  const end = String(range.end).padStart(4, '0');
  const suffix = batchIndex ? `-b${batchIndex}` : '';
  return `${start}_${end}${suffix}.json`;
}

function deriveRangeForBlocks(blocks) {
  const pages = blocks.map(block => block.pageNumber).filter(Number.isFinite);
  if (!pages.length) {
    return { start: 0, end: 0 };
  }
  return { start: Math.min(...pages), end: Math.max(...pages) };
}

export async function processPagesToFiles({ docId, pages, baseDir, onBatchComplete }) {
  if (!Array.isArray(pages) || !pages.length) {
    return [];
  }
  await ensureDir(baseDir);
  const blocks = collectBlocks(pages).filter(block => {
    if (block.kind === 'table') {
      return Array.isArray(block.rows) && block.rows.length;
    }
    return normaliseWhitespace(block.text || '').length > 0;
  });
  if (!blocks.length) {
    return [];
  }
  const batches = groupBlocksByCharLimit(blocks);
  const summaries = [];
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const range = deriveRangeForBlocks(batch);
    const filename = buildBatchFilename(range, batches.length > 1 ? i : 0);
    const filePath = path.join(baseDir, filename);
    const response = await callModelOrSplit(batch);
    const productBlocks = response
      .filter(entry => entry && entry.blockId && entry.label === 'product_table')
      .map(entry => ({
        blockId: entry.blockId,
        label: entry.label,
        rows: entry.rows,
      }));
    const payload = {
      docId,
      pageRange: range,
      blocks: productBlocks,
      sourceBlockIds: batch.map(block => block.id),
    };
    await writeJson(filePath, payload);
    console.log(`[ingest] wrote ${filename} (${productBlocks.length} product blocks) to ${filePath}`);
    const summary = {
      file: filename,
      path: filePath,
      pageRange: range,
      productBlockCount: productBlocks.length,
      sourceBlocks: batch.length,
    };
    summaries.push(summary);
    if (onBatchComplete) {
      await onBatchComplete(summary);
    }
  }
  return summaries;
}

export function buildAutomaticPageWindows(totalPages, windowSize = 20) {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return [];
  const windows = [];
  for (let start = 1; start <= totalPages; start += windowSize) {
    const end = Math.min(totalPages, start + windowSize - 1);
    windows.push({ start, end });
  }
  return windows;
}

export function filterPagesByWindow(pages, window) {
  if (!window) return pages;
  return pages.filter(page => page.pageNumber >= window.start && page.pageNumber <= window.end);
}
