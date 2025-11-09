# LLM Critique & Repair Loop

The windowed orchestrator (`lib/windowOrchestrator.js`) splits large PDFs into configurable page windows and runs the existing deterministic catalog pipeline for each slice. After every baseline run the `lib/llmValidator.js` module asks OpenAI to critique the emitted JSON against schema rules, semantic hints (CAS, price, pack plausibility), page continuity, and the pipeline diagnostics. The validator only approves or returns a list of deterministic repair instructions (pattern hints, row stitching, price anchoring, column remapping). Instructions are interpreted by `lib/repairEngine.js`, which replays the window with targeted tweaks—never rewriting the pipeline wholesale. Up to three repair iterations are attempted; each validator verdict and repair plan is persisted for audit.

Artifacts are written under `/tmp/json-agent/<docId>/windows/<idx>/` (or the resolved data dir on non-serverless environments):

- `baseline.groups.json`, `baseline.diagnostics.json`
- `validator.iter-0.json`
- `repair.iter-<n>.groups.json`, `repair.iter-<n>.diagnostics.json`
- `validator.iter-<n>.json`
- `final.groups.json`, `final.diagnostics.json`

Top-level merges land in the same data directory:

- `merged.catalog.json` – merged groups/notes with deduped variants and aggregated provenance
- `merged.qc_report.json` – collected QC reports from every window
- `llm_audit.json` – per-window validator outcomes, repair summaries, and pass/fail flags

Run `npm run verify:windowed` to exercise the orchestrator against bundled fixtures without requiring OpenAI keys.
