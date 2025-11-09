import path from 'node:path';

import { loadPatternRegistry, PatternEngine } from '../patterns/engine.js';
import { runPriceAnchoredRecovery } from '../extractors/priceAnchoredExtractor.js';
import { preSegmentText } from '../extractors/preSegment.js';

function applyPreSegmentation(pages = []) {
  return (pages || []).map(page => {
    const segments = Array.isArray(page.segments) ? [...page.segments] : [];
    if (Array.isArray(page.textBlocks)) {
      for (const block of page.textBlocks) {
        const fragments = preSegmentText(block?.text || '');
        if (!fragments.length) continue;
        let counter = 0;
        for (const fragment of fragments) {
          counter += 1;
          segments.push({
            id: `${block?.id || 'block'}-seg${counter}`,
            text: fragment,
          });
        }
      }
    }
    if (!segments.length) {
      return page;
    }
    return { ...page, segments };
  });
}

export async function runUniversalCatalogPass({ docId, pages, dataDir = null, options = {} }) {
  const patternsDir = options.patternsDir || path.join(process.cwd(), 'patterns');
  const registry = await loadPatternRegistry(patternsDir);
  const warnings = [];
  const diagnostics = {
    registryErrors: registry.errors,
  };

  const segmentedPages = applyPreSegmentation(pages);

  let groups = [];
  let qcReport = null;

  if (!registry.patterns.length) {
    warnings.push('pattern_registry_empty');
  } else {
    const engine = new PatternEngine(registry.patterns, options.patternOptions || {});
    const patternResult = engine.matchPages(segmentedPages, { docId, dataDir });
    diagnostics.pattern = patternResult.diagnostics;
    if (patternResult.warnings?.length) {
      warnings.push(...patternResult.warnings);
    }
    if (patternResult.groups?.length) {
      groups = patternResult.groups;
      qcReport = patternResult.qcReport;
    }
  }

  const envForce = String(process.env.FORCE_PRICE_ANCHORED || '').toLowerCase();
  const forcePriceAnchored =
    options.forcePriceAnchored === true || envForce === '1' || envForce === 'true';
  if (!groups.length || forcePriceAnchored) {
    const fallbackResult = runPriceAnchoredRecovery(segmentedPages, {
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

