import assert from 'node:assert';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { runPriceAnchoredRecovery } from '../lib/extractors/priceAnchoredExtractor.js';
import { segmentTextPages } from '../lib/pdfSegmenter.js';

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

test('captures HSN/GST without treating HSN as the SKU', () => {
  const pages = segmentTextPages([
    'Cat No    Description    Pack    HSN    GST    Price',
    '3031-915    Calibration Buffer Solution    2/PK    12345678    18%    250',
    'AB-99    Acid Titrant    500 mL    87654321    5%    199.50'
  ]);
  const result = runPriceAnchoredRecovery(pages, { docId: 'hsn-check', minimumConfidence: 0 });
  assert.ok(result.groups.length > 0, 'expected a recovered group');
  const variants = result.groups[0].variants;
  assert.ok(variants.length >= 2, 'expected at least two variants');
  const first = variants[0];
  assert.strictEqual(first.code, '3031-915');
  assert.strictEqual(first.hsn, '12345678');
  assert.strictEqual(first.gst_percent, 18);
  assert.ok(first.pack && first.pack.includes('2/PK'));
  const second = variants[1];
  assert.strictEqual(second.pack, '500ML');
  assert.strictEqual(second.gst_percent, 5);
  assert.ok(variants.every(entry => !(entry.code && /^\d{8}$/.test(entry.code))), 'hsn values should not be treated as codes');
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

