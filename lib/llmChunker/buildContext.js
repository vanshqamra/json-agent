function createEmptySet() {
  return new Set();
}

function normaliseValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function createDocumentContext() {
  return {
    columns: createEmptySet(),
    brands: createEmptySet(),
    taxonomy: createEmptySet(),
    variantCodes: createEmptySet(),
    chunkSummaries: [],
  };
}

export function cloneContext(context) {
  return {
    columns: new Set(context?.columns || []),
    brands: new Set(context?.brands || []),
    taxonomy: new Set(context?.taxonomy || []),
    variantCodes: new Set(context?.variantCodes || []),
    chunkSummaries: Array.isArray(context?.chunkSummaries)
      ? [...context.chunkSummaries]
      : [],
  };
}

export function snapshotContext(context) {
  return {
    columns: Array.from(context.columns),
    brands: Array.from(context.brands),
    taxonomy: Array.from(context.taxonomy),
    variantCodes: Array.from(context.variantCodes),
    chunkSummaries: [...context.chunkSummaries].slice(-5),
  };
}

export function updateContextWithChunk(context, chunkResult) {
  if (!chunkResult) return context;
  const { response, chunkId, pageStart, pageEnd, source } = chunkResult;
  if (response?.groups?.length) {
    for (const group of response.groups) {
      if (Array.isArray(group?.specs_headers)) {
        for (const header of group.specs_headers) {
          const normalised = normaliseValue(header);
          if (normalised) {
            context.columns.add(normalised);
          }
        }
      }
      if (group?.title) {
        const title = normaliseValue(group.title);
        if (title) {
          context.taxonomy.add(title);
        }
      }
      if (group?.brand) {
        const brand = normaliseValue(group.brand);
        if (brand) {
          context.brands.add(brand);
        }
      }
      if (Array.isArray(group?.variants)) {
        for (const variant of group.variants) {
          const code = normaliseValue(variant?.code);
          if (code) {
            context.variantCodes.add(code);
          }
        }
      }
    }
  }
  const summary = {
    chunkId,
    pageStart,
    pageEnd,
    source,
    groups: response?.groups?.length || 0,
    warnings: Array.isArray(response?.warnings) ? response.warnings.slice(0, 4) : [],
  };
  context.chunkSummaries.push(summary);
  return context;
}

export function formatContextForPrompt(context) {
  const snapshot = snapshotContext(context);
  const lines = [];
  if (snapshot.columns.length) {
    lines.push(`Columns so far: ${snapshot.columns.join(', ')}`);
  }
  if (snapshot.variantCodes.length) {
    lines.push(`Known variant codes: ${snapshot.variantCodes.slice(0, 12).join(', ')}`);
  }
  if (snapshot.brands.length) {
    lines.push(`Brand hints: ${snapshot.brands.slice(0, 8).join(', ')}`);
  }
  if (snapshot.taxonomy.length) {
    lines.push(`Categories seen: ${snapshot.taxonomy.slice(0, 8).join(', ')}`);
  }
  if (snapshot.chunkSummaries.length) {
    const formatted = snapshot.chunkSummaries.map(entry => {
      const range = entry.pageStart === entry.pageEnd ? `${entry.pageStart}` : `${entry.pageStart}-${entry.pageEnd}`;
      return `${entry.chunkId} [${range}] -> ${entry.groups} groups via ${entry.source}`;
    });
    lines.push(`Recent chunks: ${formatted.join('; ')}`);
  }
  if (!lines.length) {
    return 'No previous context. You are processing the first chunk of this document.';
  }
  return lines.join('\n');
}

