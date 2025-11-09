import { createHash } from 'node:crypto';

function buildKey(row) {
  const pricePart = row.price_value != null ? Number(row.price_value) : 'null';
  const codePart = row.code ? String(row.code).trim().toUpperCase() : null;
  const namePart = row.name
    ? createHash('sha1').update(String(row.name).toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex')
    : null;
  return `${codePart || namePart || 'unknown'}::${pricePart}`;
}

export function dedupeRows(rows = []) {
  const map = new Map();
  const ordered = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = buildKey(row);
    if (!map.has(key)) {
      map.set(key, row);
      ordered.push(row);
      continue;
    }
    duplicates += 1;
    const existing = map.get(key);
    const existingNameLength = (existing.name || '').length || Number.POSITIVE_INFINITY;
    const candidateNameLength = (row.name || '').length || Number.POSITIVE_INFINITY;
    if (candidateNameLength < existingNameLength) {
      map.set(key, row);
      const index = ordered.indexOf(existing);
      if (index >= 0) {
        ordered[index] = row;
      }
    }
  }

  return { rows: ordered, duplicates };
}
