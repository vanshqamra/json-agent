import { SegmentResponseSchema } from './validationSchemas.js';
import { getOpenAIClient, isOpenAIConfigured } from './openaiClient.js';
import { canonicalizeHeaderList } from './headerUtils.js';

const BATCH_SIZE = 3;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

const SCHEMA_OBJECT = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['intro', 'product_text', 'product_table', 'image_callouts'],
                },
                confidence: { type: 'number' },
                headers_canonical: {
                  type: 'array',
                  items: { type: 'string' },
                },
                actions: {
                  type: 'array',
                  items: { type: 'string' },
                },
                hint: { type: 'string' },
              },
              required: ['id', 'kind', 'confidence'],
            },
          },
        },
        required: ['page', 'segments'],
      },
    },
  },
  required: ['pages'],
};

function truncate(text, max = 320) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function summarisePage(page) {
  const lines = [];
  page.textBlocks.forEach((block, idx) => {
    lines.push(`text_blocks[${idx}]: ${truncate(block.text)}`);
  });
  page.tables.forEach((table, idx) => {
    const header = table.header.join(', ');
    const sampleRows = table.rows.slice(0, 2).map(row => row.join(' | '));
    lines.push(
      `table[${idx}]: header=[${header}] rows=[${sampleRows.join('; ')}]`
    );
  });
  page.images.forEach((img, idx) => {
    lines.push(`images[${idx}]: caption="${truncate(img.caption, 120)}"`);
  });
  return `page ${page.pageNumber} ->\n${lines.join('\n')}`;
}

function heuristicLabel(page) {
  const labels = [];
  for (const segment of page.segments) {
    if (segment.type === 'text') {
      const text = segment.text || '';
      const productLike = /price|mrp|capacity|ml|mm|joint|cat|code|catalog|acid|flask|funnel|beaker|glass/i.test(text);
      const looksTitle =
        text.length >= 6 &&
        text.length <= 120 &&
        /^[A-Z0-9 ,.&/\-]+$/.test(text) &&
        /[A-Z]{3}/.test(text) &&
        !/index|table of/i.test(text);
      const hasNumbers = /\d/.test(text);
      const kind = productLike || hasNumbers || looksTitle ? 'product_text' : 'intro';
      const confidence = productLike || looksTitle ? 0.65 : 0.4;
      labels.push({
        id: segment.id,
        kind,
        confidence,
      });
    } else if (segment.kind === 'table') {
      labels.push({
        id: segment.id,
        kind: 'product_table',
        confidence: 0.8,
        headers_canonical: canonicalizeHeaderList(segment.header),
        actions: [],
      });
    } else if (segment.kind === 'image') {
      labels.push({
        id: segment.id,
        kind: 'image_callouts',
        confidence: 0.5,
        hint: segment.caption,
      });
    }
  }
  return labels;
}

async function callOpenAIForBatch(pages) {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = [
    'SCHEMA:',
    JSON.stringify(SCHEMA_OBJECT, null, 2),
    '',
    'INPUT_SUMMARIES:',
    ...pages.map(page => summarisePage(page)),
    '',
    'TASK:',
    'Label segments per page, normalize headers where obvious, and propose actions. Only return JSON matching the schema.',
  ].join('\n');

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an information extraction engine. Only output JSON that matches the provided schema.' },
        { role: 'user', content: prompt },
      ],
    });
  } catch (err) {
    err.statusCode = err?.status ?? err?.statusCode;
    throw err;
  }

  const raw = (completion.choices?.[0]?.message?.content || '').trim();
  if (!raw) throw new Error('OpenAI returned an empty response.');
  if (/^\s*</.test(raw)) {
    throw new Error(`OpenAI returned non-JSON payload: ${raw.slice(0, 120)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse OpenAI JSON: ${err.message}`);
  }
  return SegmentResponseSchema.parse(parsed);
}

export async function labelSegments(pages, options = {}) {
  if (!pages?.length) {
    const empty = [];
    empty.meta = { llmConfigured: false, llmUsed: false, llmErrors: [] };
    return empty;
  }

  const { useLLM = true } = options;
  const configured = useLLM && isOpenAIConfigured();
  const meta = { llmConfigured: configured, llmUsed: false, llmErrors: [] };
  const results = [];

  if (configured) {
    const batches = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      batches.push(pages.slice(i, i + BATCH_SIZE));
    }
    for (const batch of batches) {
      let attempt = 0;
      let response = null;
      while (attempt < MAX_RETRIES) {
        try {
          response = await callOpenAIForBatch(batch);
          if (response && response.pages) {
            meta.llmUsed = true;
          }
          break;
        } catch (err) {
          const status = err?.statusCode || err?.status;
          meta.llmErrors.push({
            status: status ?? null,
            message: err?.message || 'unknown error',
          });
          const retryable = status === 429 || (status >= 500 && status < 600);
          if (!retryable || attempt === MAX_RETRIES - 1) {
            console.error('OpenAI labeling failed:', err);
            response = null;
            break;
          }
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt += 1;
        }
      }
      if (response && response.pages) {
        results.push(...response.pages);
      } else {
        batch.forEach(page => {
          results.push({ page: page.pageNumber, segments: heuristicLabel(page) });
        });
      }
    }
  } else {
    pages.forEach(page => {
      results.push({ page: page.pageNumber, segments: heuristicLabel(page) });
    });
  }

  const filled = pages.map(page => {
    const match = results.find(entry => entry.page === page.pageNumber);
    if (match) return match;
    return { page: page.pageNumber, segments: heuristicLabel(page) };
  });

  filled.meta = meta;
  return filled;
}
