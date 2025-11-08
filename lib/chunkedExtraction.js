import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

import { canonicalizeHeaderList } from './headerUtils.js';
import { getOpenAIClient } from './openaiClient.js';
import {
  ChunkExtractionResponseSchema,
  ExtractionManifestSchema,
  ExtractionPartSchema,
  MergedCatalogSchema,
} from './validationSchemas.js';

const DEFAULT_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-4.1-mini';

export const DEFAULT_EXTRACTION_CONFIG = {
  MAX_CHARS_PER_REQUEST: 12_000,
  MIN_CHARS_BEFORE_FAIL: 2_000,
  PAGES_PER_CHUNK_DEFAULT: 3,
};

const JSON_SCHEMA_NAME = 'catalog_chunk_segments';

const RESPONSE_SCHEMA = {
  name: JSON_SCHEMA_NAME,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      segments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            segment_id: { type: 'string' },
            label: {
              type: 'string',
              enum: ['intro', 'products', 'image_captions', 'noise'],
            },
            page_range: {
              type: 'array',
              items: { type: 'integer' },
              minItems: 2,
              maxItems: 2,
            },
            summary: { type: 'string' },
            raw_text_excerpt: { type: 'string' },
            products: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  group_title: { type: 'string' },
                  category_hint: { type: 'string' },
                  description: { type: 'string' },
                  headers: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                  },
                  rows: {
                    type: 'array',
                    items: {
                      type: 'array',
                      items: {
                        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
                      },
                    },
                    minItems: 1,
                  },
                  notes: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['group_title', 'headers', 'rows'],
              },
            },
            image_captions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['label', 'page_range', 'summary'],
        },
      },
    },
    required: ['segments'],
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliseWhitespace(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLargeText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    parts.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return parts;
}

function buildSegmentLines(page) {
  const lines = [`# Page ${page.pageNumber}`];
  for (const segment of page.segments || []) {
    if (segment.kind === 'table') {
      const header = segment.header?.join(' | ') || '';
      const rows = (segment.rows || []).map(row => row.join(' | ')).join(' || ');
      lines.push(`TABLE ${segment.id}: header=[${header}] rows=[${rows}]`);
    } else if (segment.kind === 'image') {
      lines.push(`IMAGE ${segment.id}: ${segment.caption || ''}`);
    } else {
      const text = segment.text || segment.rawText || '';
      lines.push(`TEXT ${segment.id}: ${text}`);
    }
  }
  return lines;
}

function flattenPages(pages) {
  const entries = [];
  for (const page of pages) {
    const lines = buildSegmentLines(page);
    const text = lines.join('\n');
    const segments = splitLargeText(text, 40_000); // guard extremely large pages
    segments.forEach((chunkText, idx) => {
      entries.push({
        pageNumber: page.pageNumber,
        text: chunkText,
        key: `${page.pageNumber}-${idx}`,
      });
    });
  }
  return entries;
}

function ensureEntrySize(entries, index, maxChars) {
  const entry = entries[index];
  if (!entry) return null;
  if (entry.text.length <= maxChars) return entry;
  const parts = splitLargeText(entry.text, maxChars);
  const replacement = parts.map((part, offset) => ({
    ...entry,
    text: part,
    key: `${entry.key}-s${offset}`,
  }));
  entries.splice(index, 1, ...replacement);
  return entries[index];
}

function buildChunk(entries, startIndex, maxChars, pagesPerChunk) {
  const lines = [];
  const pages = new Set();
  let length = 0;
  let index = startIndex;

  while (index < entries.length) {
    const current = ensureEntrySize(entries, index, maxChars);
    if (!current) break;
    const additionLength = current.text.length + (lines.length ? 1 : 0);
    const wouldAddNewPage = !pages.has(current.pageNumber);
    const wouldOverflowPages =
      lines.length > 0 && wouldAddNewPage && pages.size >= pagesPerChunk;
    const wouldOverflowChars = lines.length > 0 && length + additionLength > maxChars;
    if (lines.length && (wouldOverflowChars || wouldOverflowPages)) break;

    lines.push(current.text);
    length += additionLength;
    pages.add(current.pageNumber);
    index += 1;
  }

  if (!lines.length && index < entries.length) {
    // ensure at least one entry is included
    const current = ensureEntrySize(entries, index, maxChars);
    if (current) {
      const safeText = current.text.slice(0, maxChars);
      lines.push(safeText);
      pages.add(current.pageNumber);
      index += 1;
    }
  }

  return {
    text: lines.join('\n'),
    nextIndex: index,
    pages: Array.from(pages.values()),
  };
}

function formatPrompt({ pdfId, chunkId, pages, chunkText }) {
  return [
    'You are part of a PDF-to-JSON extraction pipeline.',
    'Split the provided chunk into coherent segments and label each one.',
    'Labels must be exactly: intro | products | image_captions | noise.',
    'For product segments, extract tabular data when present.',
    'Return ONLY JSON that matches the provided schema.',
    '',
    `PDF ID: ${pdfId}`,
    `Chunk ID: ${chunkId}`,
    `Pages: ${pages.join(', ')}`,
    '',
    'Chunk content:',
    chunkText,
  ].join('\n');
}

async function requestCompletion(client, messages) {
  return client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
    messages,
  });
}

async function attemptRepair(client, raw, errorMessage) {
  const prompt = [
    'The previous JSON response failed validation against the schema.',
    'Return a corrected JSON payload that satisfies the schema without changing meaning.',
    `Validation error: ${errorMessage}`,
    'Invalid JSON:',
    raw,
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You repair JSON outputs. Return ONLY valid JSON for the schema.' },
    { role: 'user', content: prompt },
  ];
  const repair = await requestCompletion(client, messages);
  const fixed = (repair.choices?.[0]?.message?.content || '').trim();
  if (!fixed) throw new Error('Repair attempt returned empty payload');
  return fixed;
}

async function callModelForChunk(client, { pdfId, chunkId, pages, chunkText }) {
  const messages = [
    {
      role: 'system',
      content:
        'You extract structured catalog data. Output JSON only. Obey the JSON schema. Keep descriptions short.',
    },
    { role: 'user', content: formatPrompt({ pdfId, chunkId, pages, chunkText }) },
  ];

  const completion = await requestCompletion(client, messages);
  const raw = (completion.choices?.[0]?.message?.content || '').trim();
  if (!raw) throw new Error('OpenAI returned an empty response.');
  if (/^\s*</.test(raw)) {
    throw new Error('Model returned non-JSON payload.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const repairedRaw = await attemptRepair(client, raw, err.message);
    parsed = JSON.parse(repairedRaw);
  }

  let validated;
  try {
    validated = ChunkExtractionResponseSchema.parse(parsed);
  } catch (err) {
    const repairedRaw = await attemptRepair(client, JSON.stringify(parsed), err.message);
    const repairedParsed = JSON.parse(repairedRaw);
    validated = ChunkExtractionResponseSchema.parse(repairedParsed);
  }

  return { segments: validated.segments, raw };
}

function normalisePageRange(range = [], fallbackStart, fallbackEnd) {
  if (!Array.isArray(range) || range.length < 2) return [fallbackStart, fallbackEnd];
  const [a, b] = range;
  const start = Number.isFinite(a) ? a : fallbackStart;
  const end = Number.isFinite(b) ? b : fallbackEnd;
  return start <= end ? [start, end] : [end, start];
}

function ensureSegmentIds(segments, chunkId) {
  return segments.map((segment, index) => {
    const id = segment.segment_id || `${chunkId}-seg${String(index + 1).padStart(3, '0')}`;
    const products = segment.products || [];
    const imageCaptions = segment.image_captions || [];
    return {
      ...segment,
      segment_id: id,
      products,
      image_captions,
    };
  });
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

class PartFileManager {
  constructor(baseDir, pdfId, source, config) {
    this.baseDir = baseDir;
    this.pdfId = pdfId;
    this.manifestPath = path.join(baseDir, 'manifest.json');
    this.manifest = {
      pdfId,
      created_at: new Date().toISOString(),
      source,
      config,
      parts: [],
    };
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await writeJson(this.manifestPath, this.manifest);
  }

  getNextPartIndex() {
    return this.manifest.parts.length + 1;
  }

  getChunkId(index) {
    return `part-${String(index).padStart(3, '0')}`;
  }

  async recordSuccess(part, index) {
    const fileName = `extraction_part-${String(index).padStart(3, '0')}.json`;
    const filePath = path.join(this.baseDir, fileName);
    await writeJson(filePath, part);
    this.manifest.parts.push({
      chunk_id: part.chunk_id,
      pages: part.pages,
      status: 'ok',
      file: fileName,
    });
    await writeJson(this.manifestPath, this.manifest);
    return filePath;
  }

  async recordFailure(meta, error, index) {
    const fileName = `extraction_part-${String(index).padStart(3, '0')}.error.json`;
    const filePath = path.join(this.baseDir, fileName);
    const message = error?.message ? String(error.message) : 'Unknown error';
    const detail = error?.detail || error?.stack || undefined;
    const payload = {
      pdf_id: this.pdfId,
      chunk_id: meta.chunk_id,
      pages: meta.pages,
      error: {
        message,
        detail,
      },
    };
    await writeJson(filePath, payload);
    this.manifest.parts.push({
      chunk_id: meta.chunk_id,
      pages: meta.pages,
      status: 'error',
      file: fileName,
      error: { message, detail },
    });
    await writeJson(this.manifestPath, this.manifest);
    return filePath;
  }
}

function rowToVariant(headers, row) {
  const variant = {};
  headers.forEach((header, idx) => {
    const value = row[idx];
    if (value == null) return;
    if (typeof value === 'number') {
      variant[header] = value;
    } else {
      const str = normaliseWhitespace(String(value));
      if (str) variant[header] = str;
    }
  });
  return variant;
}

function normaliseTitle(title = '') {
  const text = normaliseWhitespace(title);
  return text || 'Untitled Product Group';
}

function buildNotesFromSegment({ segment, chunkId, range }) {
  const [pageStart] = range;
  const hintSources = [];
  if (segment.summary) hintSources.push(segment.summary);
  if (segment.raw_text_excerpt) hintSources.push(segment.raw_text_excerpt);
  if (segment.label === 'image_captions' && segment.image_captions?.length) {
    hintSources.push(segment.image_captions.join(' | '));
  }
  return {
    page: pageStart,
    span: `${chunkId}:${segment.segment_id}`,
    type: segment.label,
    confidence: segment.label === 'products' ? 0.8 : 0.4,
    hint: hintSources.join(' ').slice(0, 400) || undefined,
  };
}

function mergeSegmentsIntoGroups(pdfId, parts) {
  const groupMap = new Map();
  const notes = [];

  for (const part of parts) {
    for (const segment of part.segments) {
      const range = normalisePageRange(segment.page_range, part.pages[0], part.pages[part.pages.length - 1]);
      notes.push(buildNotesFromSegment({ segment, chunkId: part.chunk_id, range }));

      if (segment.label !== 'products') continue;
      for (const product of segment.products || []) {
        const normalizedTitle = normaliseTitle(product.group_title);
        const canonicalHeaders = canonicalizeHeaderList(product.headers || []);
        if (!canonicalHeaders.length) continue;
        const key = `${normalizedTitle.toLowerCase()}::${canonicalHeaders.join('|')}`;
        let group = groupMap.get(key);
        if (!group) {
          group = {
            title: normalizedTitle,
            category: normaliseWhitespace(product.category_hint) || 'general',
            descriptionParts: [],
            specs_headers: canonicalHeaders,
            variants: [],
            pageStart: range[0],
            pageEnd: range[1],
          };
          groupMap.set(key, group);
        }
        group.pageStart = Math.min(group.pageStart, range[0]);
        group.pageEnd = Math.max(group.pageEnd, range[1]);
        const description = normaliseWhitespace(product.description || segment.summary || '');
        if (description) group.descriptionParts.push(description);
        for (const row of product.rows || []) {
          const variant = rowToVariant(canonicalHeaders, Array.isArray(row) ? row : []);
          if (Object.keys(variant).length) {
            group.variants.push(variant);
          }
        }
        if (product.notes?.length) {
          product.notes.forEach(note => {
            const hint = normaliseWhitespace(note);
            if (!hint) return;
            notes.push({
              page: range[0],
              span: `${part.chunk_id}:${segment.segment_id}:note`,
              type: 'product_note',
              confidence: 0.5,
              hint,
            });
          });
        }
      }
    }
  }

  const groups = [];
  for (const [, value] of groupMap.entries()) {
    const description = value.descriptionParts.join(' ').trim();
    const group = {
      title: value.title,
      category: value.category,
      description,
      specs_headers: value.specs_headers,
      variants: value.variants,
      pageStart: value.pageStart,
      pageEnd: value.pageEnd,
    };
    groups.push(group);
  }

  return { groups, notes };
}

async function mergePartsToCatalog({ pdfId, source, parts, baseDir }) {
  const { groups, notes } = mergeSegmentsIntoGroups(pdfId, parts);
  const merged = {
    pdfId,
    generated_at: new Date().toISOString(),
    source,
    groups,
    notes,
  };
  const validated = MergedCatalogSchema.parse(merged);
  const filePath = path.join(baseDir, 'merged_catalog.json');
  await writeJson(filePath, validated);
  return { merged: validated, filePath };
}

function filterPagesByWindow(pages, pageWindow) {
  if (!pageWindow) return pages;
  const { start, end } = pageWindow;
  return pages.filter(page => page.pageNumber >= start && page.pageNumber <= end);
}

export async function runChunkedExtraction({
  pages,
  source,
  pdfId = crypto.randomUUID(),
  outputDir = path.join(process.cwd(), 'data', 'parsed', pdfId),
  pageWindow = null,
  config = {},
}) {
  const effectiveConfig = {
    ...DEFAULT_EXTRACTION_CONFIG,
    ...config,
  };

  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not configured. Unable to run chunked extraction.');
  }

  const selectedPages = filterPagesByWindow(pages, pageWindow);
  if (!selectedPages.length) {
    throw new Error('No pages available for chunked extraction in the requested range.');
  }

  const manager = new PartFileManager(outputDir, pdfId, source, effectiveConfig);
  await manager.init();

  const entries = flattenPages(selectedPages);
  let cursor = 0;
  let chunkSize = effectiveConfig.MAX_CHARS_PER_REQUEST;
  const processedParts = [];

  while (cursor < entries.length) {
    const index = manager.getNextPartIndex();
    const chunkId = manager.getChunkId(index);
    const chunk = buildChunk(entries, cursor, chunkSize, effectiveConfig.PAGES_PER_CHUNK_DEFAULT);
    if (!chunk.text.trim()) {
      cursor = chunk.nextIndex;
      continue;
    }

    const payload = {
      pdfId,
      chunkId,
      pages: chunk.pages,
      chunkText: chunk.text,
    };

    let attempt = 0;
    let success = false;
    while (!success && attempt < DEFAULT_MAX_RETRIES) {
      try {
        const { segments } = await callModelForChunk(client, payload);
        const normalisedSegments = ensureSegmentIds(
          segments.map(segment => ({
            ...segment,
            page_range: normalisePageRange(segment.page_range, chunk.pages[0], chunk.pages[chunk.pages.length - 1]),
            summary: segment.summary || '',
            raw_text_excerpt: segment.raw_text_excerpt?.slice(0, 400),
          })),
          chunkId,
        );
        const partRecord = ExtractionPartSchema.parse({
          pdf_id: pdfId,
          chunk_id: chunkId,
          pages: chunk.pages,
          model: MODEL,
          config: {
            max_chars: chunkSize,
            temperature: 0,
          },
          meta: {
            chunk_chars: chunk.text.length,
          },
          segments: normalisedSegments,
        });
        await manager.recordSuccess(partRecord, index);
        console.info(
          `[ingest] chunk ${chunkId} processed (pages ${chunk.pages.join(', ')})`,
        );
        processedParts.push(partRecord);
        cursor = chunk.nextIndex;
        success = true;
      } catch (err) {
        const status = err?.status || err?.statusCode;
        if (status === 413) {
          const nextSize = Math.max(Math.floor(chunkSize / 2), effectiveConfig.MIN_CHARS_BEFORE_FAIL);
          if (nextSize === chunkSize) {
            await manager.recordFailure({
              pdf_id: pdfId,
              chunk_id: chunkId,
              pages: chunk.pages,
            }, err, index);
            cursor = chunk.nextIndex;
            success = true;
            break;
          }
          chunkSize = nextSize;
          console.warn(
            `OpenAI payload too large for chunk ${chunkId}. Reducing chunk size to ${chunkSize} characters and retrying.`,
          );
          await sleep(200);
          attempt += 1;
          continue;
        }

        if (status === 429 || (status >= 500 && status < 600)) {
          if (attempt >= DEFAULT_MAX_RETRIES - 1) {
            await manager.recordFailure({
              pdf_id: pdfId,
              chunk_id: chunkId,
              pages: chunk.pages,
            }, err, index);
            console.error(
              `[ingest] chunk ${chunkId} failed after retries: ${err?.message || err}`,
            );
            cursor = chunk.nextIndex;
            success = true;
            break;
          }
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`Retryable OpenAI error for chunk ${chunkId}. Waiting ${delay}ms before retry.`);
          await sleep(delay);
          attempt += 1;
          continue;
        }

        await manager.recordFailure({
          pdf_id: pdfId,
          chunk_id: chunkId,
          pages: chunk.pages,
        }, err, index);
        console.error(
          `[ingest] chunk ${chunkId} aborted: ${err?.message || err}`,
        );
        cursor = chunk.nextIndex;
        success = true;
      }
    }
  }

  const manifest = ExtractionManifestSchema.parse(manager.manifest);
  const { merged, filePath: mergedCatalogPath } = await mergePartsToCatalog({
    pdfId,
    source,
    parts: processedParts,
    baseDir: outputDir,
  });

  return {
    pdfId,
    manifestPath: manager.manifestPath,
    mergedCatalogPath,
    manifest,
    merged,
    groups: merged.groups,
    notes: merged.notes,
    config: effectiveConfig,
  };
}
