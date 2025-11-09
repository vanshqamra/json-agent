function normaliseHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s\-/_]/g, '');
}

function normaliseName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVariantKey(variant) {
  if (variant?.code) {
    return `code:${normaliseName(variant.code)}`;
  }
  const name = normaliseName(variant?.name);
  const pack = normaliseName(variant?.pack || variant?.pack_size || '');
  const size = normaliseName(variant?.size || '');
  return `name:${name}|pack:${pack}|size:${size}`;
}

function scoreVariant(variant) {
  let score = 0;
  if (variant?.confidence != null) {
    score += Number(variant.confidence) * 10;
  }
  if (variant?.code) score += 5;
  if (variant?.price_value != null) score += 3;
  if (variant?.fields_present?.length) {
    score += variant.fields_present.length;
  }
  const populated = ['code', 'name', 'pack', 'price_value', 'currency', 'notes'];
  for (const field of populated) {
    if (variant?.[field]) score += 0.5;
  }
  return score;
}

function mergeVariant(target, candidate) {
  const merged = { ...target };
  for (const key of Object.keys(candidate)) {
    if (candidate[key] == null) continue;
    if (merged[key] == null || merged[key] === '' || scoreVariant(candidate) > scoreVariant(merged)) {
      merged[key] = candidate[key];
    }
  }
  if (Array.isArray(target.fields_present) || Array.isArray(candidate.fields_present)) {
    const set = new Set();
    for (const list of [target.fields_present, candidate.fields_present]) {
      if (!Array.isArray(list)) continue;
      for (const field of list) {
        if (field) set.add(String(field));
      }
    }
    merged.fields_present = Array.from(set);
  }
  if (Number.isFinite(candidate.confidence)) {
    merged.confidence = Math.max(Number(target.confidence || 0), Number(candidate.confidence));
  }
  return merged;
}

function collectHeaders(group, headerMap) {
  if (!Array.isArray(group?.specs_headers)) return;
  for (const header of group.specs_headers) {
    const normalised = normaliseHeader(header);
    if (!normalised) continue;
    if (!headerMap.has(normalised)) {
      headerMap.set(normalised, header);
    }
  }
}

export function mergeChunkResponses(chunkResults = []) {
  const groups = [];
  const provenance = {};
  const headerMap = new Map();
  const priceConflicts = [];
  let variantCounter = 0;

  for (const chunkResult of chunkResults) {
    if (!chunkResult?.response?.groups?.length) continue;
    for (const group of chunkResult.response.groups) {
      const baseGroup = {
        title: group?.title || 'Untitled Product',
        category: group?.category || 'general',
        specs_headers: Array.isArray(group?.specs_headers) ? [...group.specs_headers] : [],
        variants: [],
      };
      collectHeaders(baseGroup, headerMap);
      let targetGroup = groups.find(candidate => normaliseName(candidate.title) === normaliseName(baseGroup.title));
      if (!targetGroup) {
        targetGroup = { ...baseGroup, __chunkSources: new Set() };
        groups.push(targetGroup);
      }
      targetGroup.__chunkSources.add(chunkResult.chunkId);

      if (Array.isArray(group?.variants)) {
        for (const variant of group.variants) {
          if (!variant || typeof variant !== 'object') continue;
          const key = buildVariantKey(variant);
          let existingVariant = targetGroup.variants.find(entry => entry.__mergeKey === key);
          if (!existingVariant) {
            const variantId = `var-${variantCounter += 1}`;
            const payload = { ...variant, __mergeKey: key, __variantId: variantId };
            targetGroup.variants.push(payload);
            provenance[variantId] = {
              chunkId: chunkResult.chunkId,
              pageStart: chunkResult.pageStart,
              pageEnd: chunkResult.pageEnd,
              source: chunkResult.source,
            };
          } else {
            if (
              existingVariant.price_value != null &&
              variant.price_value != null &&
              existingVariant.price_value !== variant.price_value
            ) {
              priceConflicts.push({
                code: variant.code || null,
                name: variant.name || null,
                chunks: [provenance[existingVariant.__variantId]?.chunkId, chunkResult.chunkId],
                values: [existingVariant.price_value, variant.price_value],
              });
            }
            Object.assign(existingVariant, mergeVariant(existingVariant, variant));
          }
        }
      }
    }
  }

  for (const group of groups) {
    group.specs_headers = Array.from(new Set([...group.specs_headers]));
    delete group.__chunkSources;
    group.variants = group.variants.map(variant => {
      const clone = { ...variant };
      delete clone.__mergeKey;
      return clone;
    });
  }

  const canonicalHeaders = Array.from(headerMap.values());

  return {
    groups,
    canonicalHeaders,
    provenance,
    priceConflicts,
  };
}

