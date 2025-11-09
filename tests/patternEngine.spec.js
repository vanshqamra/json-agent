import assert from 'node:assert';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadPatternRegistry, PatternEngine } from '../lib/patterns/engine.js';
import { runUniversalCatalogPass } from '../lib/catalog/pipeline.js';

const DOC_ID = '4f960036-3101-4d34-b517-fe596ef46a3f';
const DATA_DIR = path.join(process.cwd(), '.data', DOC_ID, 'artifacts');

async function loadPages() {
  const contents = await readFile(path.join(DATA_DIR, 'pages.raw.json'), 'utf8');
  return JSON.parse(contents);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('registry exposes starter patterns', async () => {
  const registry = await loadPatternRegistry(path.join(process.cwd(), 'patterns'));
  assert.ok(registry.patterns.length >= 3, 'expected at least three starter patterns');
  assert.strictEqual(registry.errors.length, 0);
});

test('pattern engine extracts more than 50 variants from cached artifact', async () => {
  const pages = await loadPages();
  const registry = await loadPatternRegistry(path.join(process.cwd(), 'patterns'));
  const engine = new PatternEngine(registry.patterns);
  const result = engine.matchPages(pages, { docId: DOC_ID });
  assert.ok(result.groups.length >= 1, 'expected at least one group');
  assert.ok(result.qcReport.matched_rows >= 50, 'expected at least 50 matched rows');
  assert.strictEqual(result.groups[0].variants.length, result.qcReport.matched_rows);
});

test('universal pass is deterministic across runs', async () => {
  const pages = await loadPages();
  const first = await runUniversalCatalogPass({
    docId: DOC_ID,
    pages,
    dataDir: path.join(process.cwd(), '.data', DOC_ID),
    options: {},
  });
  const second = await runUniversalCatalogPass({
    docId: DOC_ID,
    pages,
    dataDir: path.join(process.cwd(), '.data', DOC_ID),
    options: {},
  });
  assert.deepStrictEqual(first.groups, second.groups, 'groups should be identical across runs');
  assert.deepStrictEqual(first.qcReport, second.qcReport, 'qc report should be identical across runs');
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
    console.log(`All ${passed} pattern tests passed.`);
  }
})();

