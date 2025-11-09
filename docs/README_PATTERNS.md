# Pattern Registry & Row Pattern Language (RPL)

The pattern registry stores deterministic row extraction recipes in `patterns/*.yml`.
Each file is valid JSON and describes a **Row Pattern Language (RPL)** entry:

- `id` and `description` name the pattern.
- `columns` define the ordered logical fields (`code`, `cas`, `name`, `pack`, `price`, `notes`).
  - `header_keywords` help locate compatible headers in noisy text.
  - `value_regex` and `min_length` constrain acceptable cell values.
- `validation` configures required roles and minimum row confidence.
- `normalization` applies currency and unit standardisation.

## Adding a new pattern

1. Copy one of the existing starter files in `patterns/` and update the metadata.
2. Describe each logical column in the order it appears from left to right.
3. Provide `header_keywords` that appear in source PDFs. Use lower-case tokens.
4. Add `value_regex` if the field follows a rigid format (CAS numbers, SKU codes, etc.).
5. Declare required roles under `validation.required_roles`. Required roles must resolve for a
   row to be accepted.
6. Use `normalization.currency` to map currency symbols or codes to the canonical identifier.
7. Use `normalization.units.pack` to massage pack strings into a consistent format.
8. Save the file with a `.yml` extension. JSON syntax is valid YAML, which keeps the parser simple.
9. Run the regression tests to confirm no determinism regressions:
   ```bash
   node tests/patternEngine.spec.js
   ```

## Pattern Engine lifecycle

1. The pipeline loads all `.yml` files in `patterns/`.
2. Each pattern scans cached `pages.raw.json` lines for matching headers.
3. Candidate rows are split using whitespace clustering and validated against pattern rules.
4. Rows that meet the confidence threshold are mapped into the unified catalog schema.
5. A `qc_report.json` artifact records row counts, field bitmasks, and leftover text.

Patterns must remain **universal**—avoid vendor-specific keywords unless they are generic to the
column semantics (e.g. `mrp`, `price`, `pack`).
