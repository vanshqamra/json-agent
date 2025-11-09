import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { segmentTextPages } from '../lib/pdfSegmenter.js';
import { runWindowedPipeline } from '../lib/windowOrchestrator.js';

async function loadPages() {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'catalog_sample_pages.txt');
  const raw = await fs.readFile(fixturePath, 'utf8');
  const pageText = raw.trim();
  const pageTexts = Array.from({ length: 15 }, () => pageText);
  return segmentTextPages(pageTexts);
}

async function main() {
  const pages = await loadPages();
  const result = await runWindowedPipeline({
    docId: 'verify-windowed-fixture',
    pagesRaw: pages,
    windowSize: 5,
    forcePriceAnchored: false,
    llmCritique: false,
    dataDir: null,
    pipelineOptions: { useLLM: false, persistArtifacts: false },
    source: { filename: 'fixture', pages: pages.length },
  });

  assert.ok(Array.isArray(result.groups), 'Expected groups array');
  assert.ok(result.groups.length > 0, 'Expected at least one group');
  assert.ok(result.llmAudit?.enabled === false, 'LLM audit should be disabled');

  const variantCodes = new Set();
  for (const group of result.groups) {
    for (const variant of group.variants || []) {
      if (!variant?.code) continue;
      const code = String(variant.code).toUpperCase();
      assert.ok(!variantCodes.has(code), `Duplicate variant code detected: ${code}`);
      variantCodes.add(code);
    }
  }

  console.log('verify-windowed succeeded', {
    groups: result.groups.length,
    variants: variantCodes.size,
  });
}

main().catch(error => {
  console.error('verify-windowed failed:', error);
  process.exit(1);
});
