# Price-Anchored Table Recovery (PATR)

The price-anchored fallback is a deterministic extractor that rebuilds catalog rows by
anchoring on the right-most price tokens.

## Heuristics

1. Collect line-level text from `pages.raw.json` (text blocks, labelled segments, and tables).
2. Identify candidate price cells using currency keywords (`price`, `mrp`, `rate`) and
   trailing numeric tokens (₹, €, $, integers, decimals).
3. For each price cell, scan leftwards to pull out `code`, `cas`, `name`, and `pack` values using
   lightweight regular expressions.
4. Attach continuation lines (without a price) to the previous row's `name` field.
5. Parse numbers using locale-aware rules (Indian, US, and EU grouping) and normalise currency codes.
6. Produce a per-row confidence score and field bitmask to support UI highlighting.
7. Record `low_confidence` rows alongside textual leftovers so they can be inspected manually.

## Limits

- Designed for O(n) passes—no sorting, clustering, or LLM calls.
- Only runs when the primary grouping fails or when `FORCE_PRICE_ANCHORED=1`.
- Relies on the **right-most** numeric token being the price. Discount/GST columns must be ignored
  upstream by the pattern registry.
- Wrapped product names must be contiguous lines. Random marketing paragraphs cannot be reconstructed.

## CLI usage

```bash
node scripts/run-price-fallback.js --doc <docId>
```

The command prints the matched row count, diagnostics, and any warnings.

## Determinism

Two successive runs over the same cached artifact must produce identical `catalog.json` and
`qc_report.json`. The regression tests (`tests/priceAnchored.spec.js`) assert this guarantee.
