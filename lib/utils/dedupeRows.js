function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

function buildKey(row) {
  const codePart = row.code ? String(row.code).trim().toUpperCase() : '';
  const nameSlug = row.name ? toSlug(row.name) : '';
  const packPart = row.pack ? String(row.pack).trim().toUpperCase() : '';
  const hsnPart = row.hsn ? String(row.hsn).trim() : '';
  return `${codePart || nameSlug || 'unknown'}|${packPart}|${hsnPart}`;
}

function fieldCount(row) {
  return Array.isArray(row.fields_present) ? row.fields_present.length : 0;
}

function shouldReplace(existing, candidate) {
  const existingConfidence = Number.isFinite(existing?.confidence) ? existing.confidence : 0;
  const candidateConfidence = Number.isFinite(candidate?.confidence) ? candidate.confidence : 0;
  if (candidateConfidence > existingConfidence + 1e-6) return true;
  if (candidateConfidence < existingConfidence - 1e-6) return false;

  const existingFieldCount = fieldCount(existing);
  const candidateFieldCount = fieldCount(candidate);
  if (candidateFieldCount > existingFieldCount) return true;
  if (candidateFieldCount < existingFieldCount) return false;

  const existingNameLength = (existing?.name || '').length;
  const candidateNameLength = (candidate?.name || '').length;
  return candidateNameLength > existingNameLength;
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
    if (shouldReplace(existing, row)) {
      map.set(key, row);
      const index = ordered.indexOf(existing);
      if (index >= 0) {
        ordered[index] = row;
      }
    }
  }

  return { rows: ordered, duplicates };
}
