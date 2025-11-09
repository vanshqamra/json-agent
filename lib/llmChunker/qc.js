function average(values = []) {
  if (!values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return sum / values.length;
}

export function buildChunkerQcReport({
  docId,
  chunkResults = [],
  mergedGroups = [],
  priceConflicts = [],
  provenance = {},
}) {
  const chunkSummaries = chunkResults.map(chunk => ({
    chunkId: chunk.chunkId,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    status: chunk.status || 'unknown',
    retries: chunk.retries || 0,
    costUsd: Number(chunk.costUsd || 0),
    llmUsed: chunk.source === 'llm',
    fallbackUsed: chunk.source === 'fallback',
    warnings: chunk.response?.warnings || [],
  }));

  const allVariants = mergedGroups.flatMap(group => group.variants || []);
  const confidenceValues = allVariants.map(variant => Number(variant.confidence || 0));
  const fallbackCount = chunkSummaries.filter(summary => summary.fallbackUsed).length;
  const llmCount = chunkSummaries.filter(summary => summary.llmUsed).length;
  const fallbackVariants = chunkResults
    .filter(chunk => chunk.source === 'fallback')
    .reduce((acc, chunk) => {
      const groups = chunk.response?.groups || [];
      const variants = groups.flatMap(group => group.variants || []);
      return acc + variants.length;
    }, 0);
  const fallbackRatio = allVariants.length ? fallbackVariants / allVariants.length : 0;

  return {
    docId,
    generated_at: new Date().toISOString(),
    totals: {
      chunks: chunkSummaries.length,
      variants: allVariants.length,
      llm_chunks: llmCount,
      fallback_chunks: fallbackCount,
    },
    confidence: {
      mean: average(confidenceValues),
    },
    rows_via_fallback: fallbackRatio,
    price_ambiguities: priceConflicts,
    provenance,
    chunks: chunkSummaries,
  };
}

