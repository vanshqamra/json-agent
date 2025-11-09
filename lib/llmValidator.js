import { getOpenAIClient, isOpenAIConfigured } from './openaiClient.js';

const VALIDATOR_MODEL = process.env.OPENAI_VALIDATOR_MODEL || 'gpt-4.1-mini';
const SYSTEM_PROMPT = `You are a strict data QA for PDF→Catalog JSON conversion. You receive:
The PDF window text/tables excerpts (raw segments),
The current JSON output (groups/variants/specs),
Diagnostics (warnings, confidence, matched patterns, price-anchored notes).
Your job:
• Say pass: true|false — whether this JSON correctly represents the window’s products.
• If false, return a minimal, actionable repairs[] list that our pipeline can apply deterministically (e.g., “use pattern sku_name_pack_price on page 4 table A”, “stitch wrapped lines where a price directly follows a code”, “treat rightmost tokens with ₹/digits as price”, “map column 3→pack, 4→price”).
• Return explanations[] so we can persist audit.
• Never invent products; only reference the provided text/segments.`;

function summariseTable(table) {
  const header = Array.isArray(table?.header) ? table.header.join(' | ').slice(0, 160) : '';
  const sampleRows = Array.isArray(table?.rows) ? table.rows.slice(0, 3) : [];
  return {
    header,
    rows: sampleRows.map(row => row.join(' | ').slice(0, 160)),
  };
}

function summarisePage(page) {
  if (!page) return null;
  const summary = {
    pageNumber: page.pageNumber,
    textBlocks: [],
    tables: [],
  };
  if (Array.isArray(page.textBlocks)) {
    summary.textBlocks = page.textBlocks
      .slice(0, 3)
      .map(block => (block?.text || '').slice(0, 220));
  }
  if (Array.isArray(page.tables)) {
    summary.tables = page.tables.slice(0, 2).map(tbl => summariseTable(tbl));
  }
  if (!summary.textBlocks.length && typeof page.rawText === 'string') {
    summary.textPreview = page.rawText.slice(0, 280);
  }
  return summary;
}

function summariseSegments(pages = []) {
  return pages
    .map(page => summarisePage(page))
    .filter(Boolean)
    .slice(0, 8);
}

function summariseVariant(variant) {
  if (!variant || typeof variant !== 'object') return null;
  const clone = {};
  for (const [key, value] of Object.entries(variant)) {
    if (key.startsWith('_')) continue;
    if (value == null) continue;
    if (typeof value === 'string') {
      clone[key] = value.slice(0, 160);
    } else {
      clone[key] = value;
    }
  }
  if (variant?._confidence != null) {
    clone._confidence = variant._confidence;
  }
  if (variant?._provenance) {
    clone._provenance = variant._provenance;
  }
  return clone;
}

function summariseGroups(groups = []) {
  return groups.slice(0, 6).map(group => ({
    title: group?.title,
    category: group?.category,
    pageStart: group?.pageStart,
    pageEnd: group?.pageEnd,
    variants: Array.isArray(group?.variants)
      ? group.variants.slice(0, 6).map(variant => summariseVariant(variant)).filter(Boolean)
      : [],
    specs_headers: Array.isArray(group?.specs_headers)
      ? group.specs_headers.slice(0, 6)
      : [],
  }));
}

function summariseDiagnostics(diagnostics = {}) {
  if (!diagnostics || typeof diagnostics !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.slice(0, 5);
      continue;
    }
    if (typeof value === 'object') {
      const subset = {};
      let count = 0;
      for (const [innerKey, innerVal] of Object.entries(value)) {
        subset[innerKey] = innerVal;
        count += 1;
        if (count >= 5) break;
      }
      output[key] = subset;
    }
  }
  return output;
}

function normaliseRepairs(repairs) {
  if (!Array.isArray(repairs)) return [];
  return repairs
    .map(entry => {
      if (!entry) return null;
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'object') {
        if (typeof entry.action === 'string' || typeof entry.note === 'string') {
          return JSON.stringify(entry);
        }
      }
      return String(entry);
    })
    .filter(value => typeof value === 'string' && value.length);
}

function ensureArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (value == null) return [];
  return [String(value)];
}

export async function validateAndMaybeRepair({
  inputWindow = {},
  rawSegments = [],
  groupsJson = [],
  diagnostics = {},
  context = {},
}) {
  if (!context?.llmCritique) {
    return { pass: true, repairs: [], explanations: ['llm_validator_disabled'] };
  }
  if (!isOpenAIConfigured()) {
    return { pass: true, repairs: [], explanations: ['llm_not_configured'] };
  }
  const client = getOpenAIClient();
  if (!client) {
    return { pass: true, repairs: [], explanations: ['llm_client_unavailable'] };
  }

  const payload = {
    window: {
      index: inputWindow.index ?? null,
      pageStart: inputWindow.pageStart ?? null,
      pageEnd: inputWindow.pageEnd ?? null,
      totalPages: inputWindow.totalPages ?? null,
    },
    context: {
      docId: context.docId || null,
      source: context.source || null,
    },
    segments: summariseSegments(rawSegments),
    groups: summariseGroups(groupsJson),
    diagnostics: summariseDiagnostics(diagnostics),
  };

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ];

  try {
    const completion = await client.chat.completions.create({
      model: VALIDATOR_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
    });
    const raw = (completion.choices?.[0]?.message?.content || '{}').trim();
    const parsed = JSON.parse(raw);
    const pass = Boolean(parsed?.pass);
    const repairs = normaliseRepairs(parsed?.repairs);
    const explanations = ensureArray(parsed?.explanations);
    return { pass, repairs, explanations };
  } catch (error) {
    console.error('LLM validator failed:', error);
    return {
      pass: true,
      repairs: [],
      explanations: ['llm_validator_error', error?.message || 'unknown'],
    };
  }
}
