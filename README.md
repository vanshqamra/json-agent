# Chemical JSON Agent (Complete)

Parses price-list PDFs into structured **groups → variants → normalized specs** with a deterministic pipeline.
Optional LLM escalation is supported behind a flag for edge cases.

## Quick Start
```bash
npm i
npm run dev -- --port 3001
# open http://localhost:3001
```
API: `app/api/ingest/parse/route.js` (Node runtime, `pdf-parse` + deterministic fallbacks).
UI consumes `result.pages_preview`, `result.groups`, `result.validation`, and `result.warnings`.

## Pipeline
1) **PDF → Segments** → `lib/pdfSegmenter.js`
2) **Noise/Section scoring** → `lib/noiseFilter.js`
3) **Segment labeling (heuristic + optional LLM)** → `lib/segmentLabeler.js`
4) **Group assembly** → `lib/groupAssembler.js`
5) **Post processing & normalization** → `lib/postProcessor.js`
6) **Pipeline orchestrator** → `lib/pipeline/catalogPipeline.js`
7) **API wrapper** → `app/api/ingest/parse/route.js`

Run tests:
```bash
npm run test:extract
```

### New in v2.1.0
- Pipeline always returns groups + diagnostics even if LLM is unavailable.
- Validation and warning surfaces are streamed back to the client.
- Artifacts (segments, catalog, validation) are saved under `.data/<docId>/artifacts`.

### How we decide "intro pages" count and when brochure sections change
- We compute per-page *signal density* (counts of price-like tokens, SKU-like tokens, spec patterns). Pages with density < threshold are **intro/advert/noise**. This naturally classifies early pages (often the first 20–50). Tune in `lib/noiseFilter.js`.
- When *technical variants change mid-brochure*, we detect **new group boundaries** using font/structure proxies (all-caps headers, dashed rules, repeated SKU prefixes) and **page header repetition**. See `lib/groupDetector.js`.
- If a **variant label appears once** with multiple sizes/types below, the **assembler** carries forward header context and normalizes column aliases. See `lib/variantAssembler.js`.
- When the brochure **ends** and **indexing** starts, heuristic flips: dense page of near-alphabetical entries + many page numbers + low spec density → flagged as `section:index`. See `lib/noiseFilter.js` + `lib/groupDetector.js`.
- **Important details under product** are captured as footnotes/notes blocks adjacent to the group and merged in `postProcessor`. See `lib/postProcessor.js`.

Tune thresholds via `PIPELINE_TUNING` constants in each module.
