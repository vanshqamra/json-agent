const COUNT_PACK_RE = /\b\d+\s*\/\s*(PK|PCS|PC|BTL|RL|ROL|BOX)\b/i;
const SIZE_RE = /\b\d+(?:\.\d+)?\s?(ML|L|G|KG|MM|CM)\b/i;
const MOLARITY_RE = /\b\d+(?:\.\d+)?M\b/i;
const DIMENSION_RE = /\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(MM|CM)\b/i;

function normalise(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatPack(match) {
  return match.replace(/\s+/g, '').toUpperCase();
}

export function extractPack(text) {
  if (!text) return { pack: null, pack_raw: null };
  const source = normalise(text);
  const packMatch = source.match(COUNT_PACK_RE);
  const sizeMatch = source.match(SIZE_RE);
  const molarityMatch = source.match(MOLARITY_RE);
  const dimensionMatch = source.match(DIMENSION_RE);

  let packRaw = null;
  if (packMatch) {
    packRaw = packMatch[0];
  } else if (dimensionMatch) {
    packRaw = dimensionMatch[0];
  } else if (molarityMatch) {
    packRaw = molarityMatch[0];
  } else if (sizeMatch) {
    packRaw = sizeMatch[0];
  }

  if (!packRaw) {
    return { pack: null, pack_raw: null };
  }

  const normalized = formatPack(packRaw);
  return { pack: normalized, pack_raw: packRaw };
}
