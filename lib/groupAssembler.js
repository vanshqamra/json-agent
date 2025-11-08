import { canonicalizeHeaderList } from './headerUtils.js';

const NUMERIC_HINT_SUFFIXES = ['_ml', '_mm', '_cm', '_inr', '_value', '_kg', '_g', '_l'];
const PRICE_KEYS = new Set(['price_inr', 'mrp', 'price']);

function inferTitleFromText(text = '') {
  const trimmed = String(text || '').split(/\n+/)[0].trim();
  if (!trimmed) return 'Untitled Product';
  const candidate = trimmed.split(/[:.]/)[0];
  const clean = candidate.replace(/[^A-Za-z0-9 ()\-\/]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length ? clean.slice(0, 80) : 'Untitled Product';
}

function inferCategory(text = '') {
  const hay = text.toLowerCase();
  if (/flask|bottle|beaker|jar|volumetric/.test(hay)) return 'volumetric_glassware';
  if (/pipette|burette|funnel|tube|labware/.test(hay)) return 'labware';
  if (/acid|solvent|powder|reagent|chemical/.test(hay)) return 'chemical';
  if (/instrument|meter|controller|device/.test(hay)) return 'instrument';
  if (/plastic|consumable|tips?|filter/.test(hay)) return 'consumable';
  return 'general';
}

function coerceValue(key, value) {
  if (value == null) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const lowered = key ? key.toLowerCase() : '';
  const hasAlpha = /[a-zA-Z]/.test(raw.replace(/[^a-zA-Z]/g, ''));
  if (lowered.includes('pack') || (hasAlpha && /\d/.test(raw))) {
    return raw;
  }
  const looksPrice = PRICE_KEYS.has(lowered) || lowered.endsWith('_inr');
  const numericHint = NUMERIC_HINT_SUFFIXES.some(suffix => lowered.endsWith(suffix));
  if (looksPrice) {
    const match = raw.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}(?:[^\d]|$))/g, '');
    const num = Number(match.replace(/,/g, ''));
    if (Number.isFinite(num)) return num;
  }
  if (numericHint || /^\d/.test(raw)) {
    const normalized = raw.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}(?:[^\d]|$))/g, '');
    const num = Number(normalized.replace(/,/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

function rowsToVariants(header, rows) {
  if (!header.length) return [];
  return rows.map(row => {
    const variant = {};
    header.forEach((field, idx) => {
      const cell = row[idx] ?? '';
      variant[field] = coerceValue(field, cell);
    });
    return variant;
  });
}

function ensureGroup(group, pageNumber) {
  if (!group.pageStart) group.pageStart = pageNumber;
  group.pageEnd = pageNumber;
  return group;
}

function shouldStartNewGroup(currentGroup, text, label) {
  if (!currentGroup) return true;
  if (label?.actions?.includes('merge_with_prev_group')) return false;
  const normalized = (text || '').trim();
  if (!normalized) return false;
  const isUpper =
    normalized.length >= 6 &&
    normalized.length <= 120 &&
    /^[A-Z0-9 ,.&/\-]+$/.test(normalized) &&
    /[A-Z]{3}/.test(normalized);
  const hasProductKeywords = /acid|flask|beaker|bottle|pipette|funnel|solution|glass/i.test(normalized);
  return isUpper || hasProductKeywords;
}

function finalizeGroup(group) {
  if (!group) return null;
  group.description = group.descriptionParts.join(' ').replace(/\s+/g, ' ').trim();
  delete group.descriptionParts;
  group.specs_headers = canonicalizeHeaderList(group.specs_headers || []);
  if (!group.title || group.title === 'Untitled Product') {
    group.title = inferTitleFromText(group.description);
  }
  return group;
}

export function assembleGroupsFromSegments(pages, labeledPages) {
  const labelIndex = new Map();
  for (const entry of labeledPages) {
    const map = new Map();
    for (const seg of entry.segments || []) {
      map.set(seg.id, seg);
    }
    labelIndex.set(entry.page, map);
  }

  const groups = [];
  const notes = [];
  let currentGroup = null;

  const pushCurrent = () => {
    if (currentGroup) {
      const finalGroup = finalizeGroup(currentGroup);
      if (finalGroup && finalGroup.variants.length) {
        groups.push(finalGroup);
      }
    }
    currentGroup = null;
  };

  for (const page of pages) {
    const pageLabels = labelIndex.get(page.pageNumber) || new Map();
    for (const segment of page.segments) {
      const label = pageLabels.get(segment.id);
      const kind = label?.kind || (segment.kind === 'table' ? 'product_table' : segment.type === 'text' ? 'product_text' : 'intro');
      const confidence = label?.confidence ?? (kind === 'product_table' ? 0.8 : 0.5);

      if (kind === 'intro') {
        notes.push({
          page: page.pageNumber,
          span: segment.id,
          type: 'intro',
          confidence,
          hint: label?.hint,
        });
        continue;
      }

      if (kind === 'image_callouts') {
        notes.push({
          page: page.pageNumber,
          span: segment.id,
          type: 'image_callouts',
          confidence,
          hint: label?.hint ?? segment.caption,
        });
        continue;
      }

      if (kind === 'product_text') {
        const text = segment.text || '';
        const startNew = shouldStartNewGroup(currentGroup, text, label);
        if (startNew) {
          pushCurrent();
          currentGroup = {
            category: inferCategory(text),
            title: inferTitleFromText(text),
            descriptionParts: [],
            variants: [],
            specs_headers: [],
            pageStart: page.pageNumber,
            pageEnd: page.pageNumber,
          };
        }
        ensureGroup(currentGroup, page.pageNumber);
        currentGroup.descriptionParts.push(text);
        notes.push({
          page: page.pageNumber,
          span: segment.id,
          type: 'product_text',
          confidence,
          hint: label?.hint,
        });
        continue;
      }

      if (kind === 'product_table' && segment.kind === 'table') {
        if (!currentGroup) {
          currentGroup = {
            category: 'general',
            title: inferTitleFromText(segment.sourceRows?.[0] || ''),
            descriptionParts: [],
            variants: [],
            specs_headers: [],
            pageStart: page.pageNumber,
            pageEnd: page.pageNumber,
          };
        }
        ensureGroup(currentGroup, page.pageNumber);
        const headers = label?.headers_canonical?.length
          ? label.headers_canonical
          : canonicalizeHeaderList(segment.header);
        if (headers.length) {
          currentGroup.specs_headers = [...(currentGroup.specs_headers || []), ...headers];
        }
        const variants = rowsToVariants(headers, segment.rows);
        currentGroup.variants.push(...variants);
        notes.push({
          page: page.pageNumber,
          span: segment.id,
          type: 'product_table',
          confidence,
          hint: label?.hint || (label?.actions || []).join(',') || undefined,
        });
        continue;
      }
    }
  }

  pushCurrent();

  const dedupedNotes = [];
  const seen = new Set();
  for (const note of notes) {
    const key = `${note.page}:${note.span}:${note.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedNotes.push(note);
  }

  return { groups, notes: dedupedNotes };
}
