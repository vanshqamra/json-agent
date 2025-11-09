const SYSTEM_PROMPT = `You are a deterministic catalog converter. Output must be valid JSON only, matching this schema:
{
  "groups": [
    {
      "title": "string",
      "category": "string",
      "specs_headers": ["string", "..."],
      "variants": [
        {
          "code": "string|null",
          "cas": "string|null",
          "name": "string",
          "pack": "string|null",
          "price_value": "number|null",
          "currency": "string|null",
          "notes": "string|null",
          "confidence": "number",
          "fields_present": ["code","name","pack","price_value","..."]
        }
      ]
    }
  ],
  "warnings": ["string", "..."],
  "notes": ["string", "..."]
}

Never invent products; only emit rows recoverable from the provided text.

Keep units/currency as seen; numeric price_value should be digits only.

No prose; JSON only.`;

function stringifyTextBlocks(blocks = []) {
  return blocks
    .map(block => {
      const text = typeof block === 'string' ? block : block?.text || '';
      return text.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function stringifyPages(pages = []) {
  const lines = [];
  for (const page of pages) {
    const header = `--- Page ${page.pageNumber ?? '?'} ---`;
    lines.push(header);
    if (page?.rawText) {
      lines.push(page.rawText.trim());
    } else if (Array.isArray(page?.textBlocks)) {
      lines.push(stringifyTextBlocks(page.textBlocks));
    }
  }
  return lines.join('\n');
}

export function buildChunkPrompt({
  docId,
  chunkId,
  pageStart,
  pageEnd,
  pages,
  context,
}) {
  const contextText = context?.trim() ? context.trim() : 'No previous context provided.';
  const body = [
    `Document: ${docId || 'unknown'}`,
    `Chunk: ${chunkId} covering pages ${pageStart} to ${pageEnd}`,
    '',
    'Document context:',
    contextText,
    '',
    'Raw text for this chunk (only include rows visible in these pages):',
    stringifyPages(pages),
    '',
    'Instructions:',
    '1. Identify product sections and produce groups with appropriate titles/categories.',
    '2. For each variant include best-effort code, name, pack, price_value, currency, notes.',
    '3. Set confidence between 0 and 1. Include fields_present array for populated fields.',
    '4. If unsure or data missing, add warning entries explaining the gap.',
  ].join('\n');

  return {
    system: SYSTEM_PROMPT,
    user: body,
  };
}

export { SYSTEM_PROMPT };

