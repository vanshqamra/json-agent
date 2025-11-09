# Price-Anchored Table Recovery (PATR)

The price-anchored fallback is a deterministic extractor that rebuilds catalog rows by
anchoring on the right-most price tokens.

## Heuristics

1. Collect line-level text from `pages.raw.json` (text blocks, labelled segments, tables, and the
   raw PDF tokens supplied by `pdfjs-dist`).
2. Detect header rows (`Cat No`, `Description`, `HSN`, `GST`, `Price`, `INR`, `LP`) and only begin
   harvesting rows after the first header has been observed. If a document has no header, we still
   recover rows but penalise their confidence.
3. Identify candidate price cells by clustering the right-most purely numeric token per row (2–7
   digits, optional decimals) and ignoring tokens that contain `%` or sit in GST columns. The
   string-based fallback honours the same boundary rules.
4. Use the chosen price token as a guard: each hit defines a row whose left boundary is the previous
   price centre (or the line start). This prevents multiple items on a single line from merging into
   one variant.
5. Classify supporting fields with targeted regexes—hyphenated SKUs, non-8-digit numeric SKUs,
   packs (`10/PK`, `500 mL`, `10x10mm`), molarity, and HSN/GST values—then reconstruct the product
   name from the span between the code (or first non-HSN token) and the pack cell.
6. Parse numbers using locale-aware rules (Indian, US, and EU grouping) and normalise currency
   symbols/keywords (`₹`, `INR`, `LP`, `MRP`, `Rate`).
7. Emit deterministic confidence scores that reward rich rows (code + name + pack + HSN/GST) and
   penalise ambiguous matches, duplicate prices on a line, or documents with no header.
8. Record `low_confidence` rows alongside textual leftovers so they can be inspected manually.

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
