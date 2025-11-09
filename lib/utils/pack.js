const SIZE_RE = /\b\d+(?:\.\d+)?\s?(MM|CM|M|ML|L|µM|UM)\b/i;
const PACK_RE = /\b\d+\/PK\b|\bPK\d+\b|\b\d+PC[K|S]?\b|\b[12]RL\/PK\b/i;
const DIMENSION_RE = /\b\d+(?:\.\d+)?x\d+(?:\.\d+)?(MM|CM|M)\b/i;

function normalise(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatPack(match) {
  return match.replace(/\s+/g, '').toUpperCase();
}

export function extractPack(text) {
  if (!text) return { pack: null, pack_raw: null };
  const source = normalise(text);
  const sizeMatch = source.match(SIZE_RE);
  const packMatch = source.match(PACK_RE);
  const dimensionMatch = source.match(DIMENSION_RE);

  let packRaw = null;
  if (packMatch) {
    packRaw = packMatch[0];
  } else if (dimensionMatch) {
    packRaw = dimensionMatch[0];
  } else if (sizeMatch) {
    packRaw = sizeMatch[0];
  }

  if (!packRaw) {
    return { pack: null, pack_raw: null };
  }

  const normalized = formatPack(packRaw);
  return { pack: normalized, pack_raw: packRaw };
}
