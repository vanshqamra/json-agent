import assert from 'node:assert';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { runPriceAnchoredRecovery } from '../lib/extractors/priceAnchoredExtractor.js';

const DOC_ID = '4f960036-3101-4d34-b517-fe596ef46a3f';
const DATA_DIR = path.join(process.cwd(), '.data', DOC_ID, 'artifacts');

async function loadPages() {
  const contents = await readFile(path.join(DATA_DIR, 'pages.raw.json'), 'utf8');
  return JSON.parse(contents);
}

async function loadEurPages() {
  const contents = await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'pages-eur.json'), 'utf8');
  return JSON.parse(contents);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('price anchored fallback recovers the Qualigens rows', async () => {
  const pages = await loadPages();
  const result = runPriceAnchoredRecovery(pages, { docId: DOC_ID });
  assert.ok(result.groups.length >= 1, 'expected a group from fallback');
  assert.ok(result.qcReport.matched_rows >= 50, 'expected at least 50 rows');
});

test('handles EUR currency and wrapped names', async () => {
  const pages = await loadEurPages();
  const result = runPriceAnchoredRecovery(pages, { docId: 'eur-fixture', minimumConfidence: 0 });
  assert.strictEqual(result.groups[0].variants[0].currency, 'EUR');
  assert.ok(result.groups[0].variants.some(v => v.name.includes('Stability Control Mix Deluxe')));
});

test('fallback output is deterministic', async () => {
  const pages = await loadPages();
  const first = runPriceAnchoredRecovery(pages, { docId: DOC_ID });
  const second = runPriceAnchoredRecovery(pages, { docId: DOC_ID });
  assert.deepStrictEqual(first.groups, second.groups);
  assert.deepStrictEqual(first.qcReport, second.qcReport);
});

(async () => {
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`✓ ${entry.name}`);
      passed += 1;
    } catch (error) {
      console.error(`✗ ${entry.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  if (passed === tests.length) {
    console.log(`All ${passed} price anchored tests passed.`);
  }
})();

