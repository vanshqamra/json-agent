# Fix Summary

- Added `lib/custom/qualigensGcSecondary.js`, a deterministic parser that detects "GC Secondary Reference Standard" blocks and converts raw text rows into structured variants (handles CAS extraction, pack-size normalization, price coercion, and wrapped product names).
- Updated the catalog pipeline to invoke the custom parser before post-processing, capture diagnostics, persist a `qc_report.json` artifact, and forward raw pages into post processing; artifacts persistence now supports auxiliary files.
- Extended regression tests (`tests/run-parse-tests.js`) with a Qualigens-specific fixture covering multi-line names to lock the new parser behaviour.
- Added `scripts/run-qualigens-manual.js` helper to rerun the pipeline against the cached text payload and regenerate `out/catalog.json` + `out/qc_report.json` for review.
