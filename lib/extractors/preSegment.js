const SKU_PATTERN = /([A-Z0-9]{3,}(?:-[A-Z0-9]+)+|(?<!HSN\s)\b[0-9]{6,}\b)/gi;
const PRICE_PATTERN = /\b(?:\d{1,3}(?:,\d{3})+|\d{2,})(?:\.\d+)?(?!\s*%)/g;

function hasPriceLike(text) {
  if (!text) return false;
  PRICE_PATTERN.lastIndex = 0;
  return PRICE_PATTERN.test(text);
}

export function preSegmentText(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const fragments = [];
  const matches = [];
  let match;
  SKU_PATTERN.lastIndex = 0;
  while ((match = SKU_PATTERN.exec(trimmed)) != null) {
    matches.push({ index: match.index, token: match[0] });
  }

  if (!matches.length) {
    if (hasPriceLike(trimmed)) {
      fragments.push(trimmed);
    }
    return fragments;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : trimmed.length;
    const fragment = trimmed.slice(start, end).trim();
    if (!fragment) continue;
    if (!hasPriceLike(fragment)) continue;
    fragments.push(fragment);
  }

  return fragments;
}

export function preSegmentBlock(block) {
  if (!block || typeof block.text !== 'string') return [];
  return preSegmentText(block.text).map((text, index) => ({
    id: block.id ? `${block.id}-seg${index + 1}` : `segment-${index + 1}`,
    text,
  }));
}
