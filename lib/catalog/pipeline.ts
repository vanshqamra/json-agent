import { PatternRegistry } from '../patterns/engine.js';
import type { PriceAnchoredResult } from '../extractors/priceAnchoredExtractor.js';

export type UniversalOptions = {
  patternsDir?: string;
  patternOptions?: Record<string, unknown>;
  forcePriceAnchored?: boolean;
  minimumConfidence?: number;
};

export type UniversalResult = {
  groups: Array<Record<string, unknown>>;
  qcReport: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  warnings: string[];
};

export async function runUniversalCatalogPass(args: {
  docId?: string;
  pages: Array<Record<string, unknown>>;
  dataDir?: string | null;
  options?: UniversalOptions;
}): Promise<UniversalResult> {
  // TypeScript shim to provide typings for the JavaScript implementation.
  // The real implementation lives in lib/catalog/pipeline.js.
  throw new Error('runUniversalCatalogPass is implemented in lib/catalog/pipeline.js');
}

