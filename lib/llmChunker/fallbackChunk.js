import { runUniversalCatalogPass } from '../catalog/pipeline.js';

function pickWarnings(result) {
  if (!result) return [];
  const warnings = [];
  if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
  if (result.diagnostics?.pattern?.warnings) {
    warnings.push(...result.diagnostics.pattern.warnings);
  }
  return warnings;
}

export async function runFallbackForChunk({
  docId,
  chunkId,
  pages,
  options = {},
}) {
  const fallbackDocId = `${docId || 'doc'}::${chunkId}`;
  const result = await runUniversalCatalogPass({
    docId: fallbackDocId,
    pages,
    dataDir: null,
    options,
  });
  const groups = Array.isArray(result.groups) ? result.groups : [];
  return {
    response: {
      groups,
      warnings: pickWarnings(result),
      notes: [],
    },
    diagnostics: result?.diagnostics || {},
    warnings: pickWarnings(result),
    source: groups.length ? 'fallback' : 'none',
  };
}

