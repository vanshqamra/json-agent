export type PriceAnchoredOptions = {
  docId?: string;
  minimumConfidence?: number;
};

export type PriceAnchoredResult = {
  groups: Array<Record<string, unknown>>;
  qcReport: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  warnings: string[];
};

export function runPriceAnchoredRecovery(
  pages: Array<Record<string, unknown>>,
  options: PriceAnchoredOptions = {},
): PriceAnchoredResult {
  // TypeScript shim for editor support. Runtime implementation lives in priceAnchoredExtractor.js
  throw new Error('runPriceAnchoredRecovery is implemented in priceAnchoredExtractor.js');
}

