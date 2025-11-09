import path from 'node:path';

import { loadPatternRegistry, PatternEngine } from '../patterns/engine.js';
import { runPriceAnchoredRecovery } from '../extractors/priceAnchoredExtractor.js';

export async function runUniversalCatalogPass({ docId, pages, dataDir = null, options = {} }) {
  const patternsDir = options.patternsDir || path.join(process.cwd(), 'patterns');
  const registry = await loadPatternRegistry(patternsDir);
  const warnings = [];
  const diagnostics = {
    registryErrors: registry.errors,
  };

  let groups = [];
  let qcReport = null;

  if (!registry.patterns.length) {
    warnings.push('pattern_registry_empty');
  } else {
    const engine = new PatternEngine(registry.patterns, options.patternOptions || {});
    const patternResult = engine.matchPages(pages, { docId, dataDir });
    diagnostics.pattern = patternResult.diagnostics;
    if (patternResult.warnings?.length) {
      warnings.push(...patternResult.warnings);
    }
    if (patternResult.groups?.length) {
      groups = patternResult.groups;
      qcReport = patternResult.qcReport;
    }
  }

  const forcePriceAnchored = options.forcePriceAnchored === true;
  if (!groups.length || forcePriceAnchored) {
    const fallbackResult = runPriceAnchoredRecovery(pages, {
      docId,
      minimumConfidence: options.minimumConfidence || 0.5,
    });
    diagnostics.priceAnchored = fallbackResult.diagnostics;
    if (fallbackResult.warnings?.length) {
      warnings.push(...fallbackResult.warnings);
    }
    if (fallbackResult.groups?.length) {
      groups = fallbackResult.groups;
      qcReport = fallbackResult.qcReport;
    }
  }

  return {
    groups,
    qcReport,
    diagnostics,
    warnings,
  };
}

