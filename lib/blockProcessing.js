import path from 'node:path';

import { getOpenAIClient, isOpenAIConfigured } from './openaiClient.js';
import { ensureDir, writeJson } from './io.js';
import { uploadPartToSupabase } from './supabaseIngest.js';

const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-4.1-mini';
const MAX_CHARS_PER_CALL = Number(process.env.INGEST_MAX_CHARS_PER_CALL || 12_000);
const MAX_PART_BYTES = Number(process.env.INGEST_MAX_PART_BYTES || 256_000);
const MAX_RETRIES = Number(process.env.INGEST_MAX_CALL_RETRIES || 4);
const RETRY_BASE_DELAY_MS = Number(process.env.INGEST_RETRY_BASE_DELAY_MS || 500);
const MAX_CELL_SEGMENT_LENGTH = Number(process.env.INGEST_MAX_CELL_SEGMENT_CHARS || 4_000);

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
    ? `bbox=${block.bbox.x.toFixed(1)},${block.bbox.y.toFixed(1)},${block.bbox.width.toFixed(1)},${block.bbox.height.toFixed(1)}`
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

function splitBlockForPrompt(block) {
  if (block.kind === 'table' && Array.isArray(block.rows) && block.rows.length > 1) {
    const slices = [];
    const header = Array.isArray(block.header) ? block.header : [];
    const estimatedSegments = Math.max(
      2,
      Math.ceil(estimateBlockSize(block) / MAX_CHARS_PER_CALL),
    );
    const chunkSize = Math.max(1, Math.ceil(block.rows.length / estimatedSegments));
    let cursor = 0;
    while (cursor < block.rows.length) {
      const rows = block.rows.slice(cursor, cursor + chunkSize);
      const slice = {
        ...block,
        id: block.id ? `${block.id}:seg${slices.length + 1}` : block.id,
        rows,
        sourceRows: Array.isArray(block.sourceRows)
          ? block.sourceRows.slice(cursor, cursor + chunkSize)
          : block.sourceRows,
      };
      slice.promptText = normaliseWhitespace(
        [...header, ...rows.flat().map(cell => normaliseWhitespace(cell))].join(' '),
      );
      slices.push(slice);
      cursor += rows.length;
    }
    return slices.length ? slices : [block];
  }
  if (block.promptText && block.promptText.length > MAX_CHARS_PER_CALL) {
    const segments = [];
    const segmentLength = Math.max(512, Math.floor(block.promptText.length / 2));
    for (let idx = 0; idx < block.promptText.length; idx += segmentLength) {
      const text = block.promptText.slice(idx, idx + segmentLength);
      segments.push({
        ...block,
        id: block.id ? `${block.id}:seg${segments.length + 1}` : block.id,
        promptText: text,
        text,
      });
    }
    return segments.length ? segments : [block];
  }
  return [block];
}

function isPayloadTooLarge(error) {
  const message = String(error?.message || error || '');
  const status = error?.status || error?.response?.status || error?.httpStatus;
  return status === 413 || message.includes('413');
}

function isRateLimited(error) {
  const status = error?.status || error?.response?.status || error?.httpStatus;
  return status === 429;
}

function isServerError(error) {
  const status = error?.status || error?.response?.status || error?.httpStatus;
  return status >= 500 && status < 600;
}

async function normaliseUpstreamError(error, fallbackMessage = 'Upstream request failed') {
  const normalised = new Error(error?.message || fallbackMessage);
  const status = error?.status || error?.httpStatus || error?.response?.status || error?.statusCode;
  normalised.status = status;
  const details = {
    status: status ?? null,
    message: error?.message || fallbackMessage,
    code: error?.code || error?.error?.code || null,
  };
  if (error?.response) {
    const response = error.response;
    try {
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (text) {
          details.preview = text.slice(0, 500);
        }
      } else if (typeof response.json === 'function') {
        const data = await response.json();
        details.data = data;
      }
    } catch (readError) {
      details.preview = readError?.message || 'Failed to read upstream body';
    }
  } else if (error?.error) {
    details.data = error.error;
  }
  normalised.details = details;
  return normalised;
}

async function callModel(blocks) {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI client is not configured');
  }
  const client = getOpenAIClient();
  try {
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
      ...entry,
      blockId: entry.blockId || entry.id || null,
      label: entry.label || 'other',
      rows: Array.isArray(entry.rows) ? entry.rows : [],
    }));
  } catch (error) {
    const normalised = await normaliseUpstreamError(error, 'OpenAI request failed');
    throw normalised;
  }
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
  if (!blocks.length) return [];
  const totalChars = blocks.reduce((sum, block) => sum + estimateBlockSize(block), 0);
  if (totalChars > MAX_CHARS_PER_CALL && blocks.length > 1) {
    const mid = Math.floor(blocks.length / 2);
    console.log(
      `[ingest] pre-splitting batch of ${blocks.length} blocks (chars=${totalChars}) into ${mid} and ${blocks.length - mid}`,
    );
    const left = await callModelOrSplit(blocks.slice(0, mid));
    const right = await callModelOrSplit(blocks.slice(mid));
    return [...left, ...right];
  }
  try {
    return await callModelWithRetry(blocks);
  } catch (error) {
    if (isPayloadTooLarge(error)) {
      if (blocks.length > 1) {
        const mid = Math.floor(blocks.length / 2);
        console.warn(`[ingest] 413 received, splitting batch into ${mid} and ${blocks.length - mid}`);
        const left = await callModelOrSplit(blocks.slice(0, mid));
        const right = await callModelOrSplit(blocks.slice(mid));
        return [...left, ...right];
      }
      if (blocks.length === 1) {
        const [block] = blocks;
        const split = splitBlockForPrompt(block);
        if (split.length > 1) {
          console.warn(
            `[ingest] 413 received for single block ${block.id || 'unknown'}, splitting into ${split.length} segments`,
          );
          return callModelOrSplit(split);
        }
      }
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
    const formattedSegments = splitBlockForPrompt(formatBlockForPrompt(block));
    for (const formatted of formattedSegments) {
      const blockSize = estimateBlockSize(formatted);
      if (current.length && size + blockSize > MAX_CHARS_PER_CALL) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(formatted);
      size += blockSize;
    }
    if (current.length && size > MAX_CHARS_PER_CALL) {
      batches.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function deriveRangeForBlocks(blocks) {
  const pages = blocks.map(block => block.pageNumber).filter(Number.isFinite);
  if (!pages.length) {
    return { start: 0, end: 0 };
  }
  return { start: Math.min(...pages), end: Math.max(...pages) };
}

function estimateEntrySize(entry) {
  return Buffer.byteLength(JSON.stringify(entry));
}

function splitRowIntoGroups(row, entry, maxBytes, depth = 0, segmentLength = MAX_CELL_SEGMENT_LENGTH) {
  const safeLength = Math.max(32, segmentLength);
  const segments = row.map(cell => {
    const text = cell == null ? '' : String(cell);
    if (!text.length) return [''];
    const pieces = [];
    for (let idx = 0; idx < text.length; idx += safeLength) {
      pieces.push(text.slice(idx, idx + safeLength));
    }
    return pieces;
  });
  const totalParts = Math.max(...segments.map(part => part.length));
  if (!Number.isFinite(totalParts) || totalParts <= 1) {
    return [[row]];
  }
  const rows = [];
  for (let i = 0; i < totalParts; i += 1) {
    rows.push([segments.map(part => part[i] ?? '')]);
  }
  if (depth >= 5) {
    return rows;
  }
  const needsAnotherPass = rows.some(group => {
    const candidate = { ...entry, rows: group };
    return estimateEntrySize(candidate) > maxBytes;
  });
  if (needsAnotherPass) {
    return splitRowIntoGroups(row, entry, maxBytes, depth + 1, Math.max(32, Math.floor(safeLength / 2)));
  }
  return rows;
}

function splitEntryBySize(entry, maxBytes, depth = 0) {
  const entrySize = estimateEntrySize(entry);
  if (entrySize <= maxBytes || depth > 6) {
    return [entry];
  }
  if (!Array.isArray(entry.rows) || !entry.rows.length) {
    return [entry];
  }
  const rowGroups = [];
  let currentRows = [];

  const flushCurrent = () => {
    if (currentRows.length) {
      rowGroups.push(currentRows);
      currentRows = [];
    }
  };

  for (const row of entry.rows) {
    const candidateRows = [...currentRows, row];
    const candidateEntry = { ...entry, rows: candidateRows };
    if (currentRows.length && estimateEntrySize(candidateEntry) > maxBytes) {
      flushCurrent();
    }
    const singleEntry = { ...entry, rows: [row] };
    if (estimateEntrySize(singleEntry) > maxBytes) {
      const rowSplits = splitRowIntoGroups(row, entry, maxBytes, depth);
      rowGroups.push(...rowSplits);
      currentRows = [];
      continue;
    }
    currentRows.push(row);
  }
  flushCurrent();

  if (!rowGroups.length) {
    rowGroups.push(...entry.rows.map(row => [row]));
  }

  const slices = rowGroups.map((rows, index) => {
    const suffix = rowGroups.length > 1 ? `:part${index + 1}` : '';
    const blockId = entry.blockId ? `${entry.blockId}${suffix}` : entry.blockId;
    return {
      ...entry,
      blockId,
      rows,
    };
  });

  return slices.flatMap(slice => splitEntryBySize(slice, maxBytes, depth + 1));
}

function prepareEntries(entries, maxBytes) {
  const prepared = [];
  for (const entry of entries) {
    const base = {
      ...entry,
      blockId: entry.blockId || entry.id || null,
      label: entry.label || 'other',
    };
    if (Array.isArray(base.rows)) {
      base.rows = base.rows.map(row => row.map(cell => (cell == null ? null : cell)));
    } else {
      base.rows = [];
    }
    const parts = splitEntryBySize(base, maxBytes);
    prepared.push(...parts);
  }
  return prepared;
}

function partitionEntries(entries, maxBytes) {
  const partitions = [];
  let current = [];
  let size = 0;

  for (const entry of entries) {
    const entrySize = estimateEntrySize(entry);
    if (current.length && size + entrySize > maxBytes) {
      partitions.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entrySize;
  }

  if (current.length) {
    partitions.push(current);
  }

  return partitions;
}

function buildPartPayloads({ docId, window, version, entries, sourceBlockIds }) {
  if (!entries.length) return [];
  const prepared = prepareEntries(entries, MAX_PART_BYTES);
  const partitions = partitionEntries(prepared, MAX_PART_BYTES);
  const parts = [];

  partitions.forEach((chunk, index) => {
    const partSourceIds = chunk
      .map(entry => entry.blockId)
      .filter(Boolean);
    const rowCount = chunk.reduce(
      (count, entry) => count + (Array.isArray(entry.rows) ? entry.rows.length : 0),
      0,
    );
    const payload = {
      docId,
      window,
      version,
      partIndex: index,
      partTotal: partitions.length,
      blocks: chunk,
      sourceBlockIds: Array.from(new Set([...sourceBlockIds, ...partSourceIds])),
      createdAt: new Date().toISOString(),
    };
    parts.push({
      payload,
      blockCount: chunk.length,
      rowCount,
    });
  });

  return parts;
}

function buildDryRunEntry({ docId, window, batchIndex, batch }) {
  const start = String(window.start).padStart(4, '0');
  const end = String(window.end).padStart(4, '0');
  const partId = `${docId}/win-${start}-${end}/part-${String(batchIndex + 1).padStart(3, '0')}.json`;
  const relativePath = path.join('parts', `win-${start}-${end}`, `part-${String(batchIndex + 1).padStart(3, '0')}.json`);
  const estimatedChars = batch.reduce((sum, block) => sum + estimateBlockSize(block), 0);
  return {
    id: partId,
    window,
    file: path.basename(relativePath),
    path: relativePath,
    status: 'dry-run',
    estimatedPromptChars: estimatedChars,
    promptBlockCount: batch.length,
  };
}

async function persistPart({
  docId,
  window,
  baseDir,
  payload,
  index,
  onPartWritten,
}) {
  const start = String(window.start).padStart(4, '0');
  const end = String(window.end).padStart(4, '0');
  const partName = `part-${String(index + 1).padStart(3, '0')}.json`;
  const windowDir = path.join(baseDir, 'parts', `win-${start}-${end}`);
  const relativePath = path.join('parts', `win-${start}-${end}`, partName);
  await ensureDir(windowDir);
  const filePath = path.join(windowDir, partName);
  const writeResult = await writeJson(filePath, payload, { pretty: false });
  const storageKey = `${docId}/win-${start}-${end}/${partName}`;
  let remote = null;
  try {
    remote = await uploadPartToSupabase({
      localPath: filePath,
      storageKey,
      metadata: {
        docId,
        window,
        sizeBytes: writeResult.bytes,
        sha256: writeResult.sha256,
        createdAt: payload.createdAt,
      },
    });
  } catch (error) {
    console.warn('[ingest] failed to upload part to Supabase:', error);
  }

  const manifestEntry = {
    id: storageKey,
    window,
    file: partName,
    path: relativePath,
    bytes: writeResult.bytes,
    sha256: writeResult.sha256,
    createdAt: payload.createdAt,
    blockCount: payload.blocks.length,
    rowCount: payload.blocks.reduce(
      (count, entry) => count + (Array.isArray(entry.rows) ? entry.rows.length : 0),
      0,
    ),
    sourceBlockIds: payload.sourceBlockIds,
    storage: remote ? { supabase: remote } : undefined,
  };
  if (onPartWritten) {
    await onPartWritten(manifestEntry);
  }
  return manifestEntry;
}

export async function processPagesToFiles({
  docId,
  pages,
  baseDir,
  extractionVersion,
  dryRun = false,
  onPartWritten,
}) {
  if (!Array.isArray(pages) || !pages.length) {
    return [];
  }
  if (!dryRun) {
    await ensureDir(baseDir);
  }
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
    if (dryRun) {
      summaries.push(buildDryRunEntry({ docId, window: range, batchIndex: i, batch }));
      continue;
    }
    const responseEntries = await callModelOrSplit(batch);
    if (!responseEntries.length) {
      continue;
    }
    const parts = buildPartPayloads({
      docId,
      window: range,
      version: extractionVersion,
      entries: responseEntries,
      sourceBlockIds: batch.map(block => block.id).filter(Boolean),
    });
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const manifestEntry = await persistPart({
        docId,
        window: range,
        baseDir,
        payload: parts[partIndex].payload,
        index: partIndex,
        onPartWritten,
      });
      summaries.push(manifestEntry);
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
