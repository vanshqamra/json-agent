import assert from 'node:assert';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { runPriceAnchoredRecovery } from '../lib/extractors/priceAnchoredExtractor.js';

const DOC_ID = 'f64576f9-1db5-47d1-90c8-2bfba21150b5';
const DATA_DIR = path.join(process.cwd(), '.data', DOC_ID, 'artifacts');

async function loadPages() {
  const contents = await readFile(path.join(DATA_DIR, 'pages.raw.json'), 'utf8');
  return JSON.parse(contents);
}

(async () => {
  const pages = await loadPages();
  const result = runPriceAnchoredRecovery(pages, { docId: DOC_ID, minimumConfidence: 0.4 });
  const groups = result.groups || [];
  assert.ok(groups.length > 0, 'expected fallback group to be present');
  const variants = groups[0].variants || [];
  assert.ok(variants.length >= 120, `expected >= 120 rows, received ${variants.length}`);

  const withCodeAndPrice = variants.filter(
    v => v.code && v.price_value != null,
  ).length;
  const ratio = withCodeAndPrice / variants.length;
  assert.ok(ratio >= 0.95, `expected >=95% rows with code & price, got ${(ratio * 100).toFixed(2)}%`);

  const forbiddenToken = /\b(HSN|GST|INR)\b/i;
  assert.ok(!variants.some(v => forbiddenToken.test(v.name || '')), 'names should be scrubbed');

  const keys = new Set();
  for (const variant of variants) {
    const priceKey = variant.price_value != null ? Number(variant.price_value).toFixed(2) : 'null';
    keys.add(`${variant.code || variant.name}:${priceKey}`);
  }
  const duplicates = variants.length - keys.size;
  const duplicateRate = variants.length ? duplicates / variants.length : 0;
  assert.ok(
    duplicateRate <= 0.02,
    `duplicates too high: ${(duplicateRate * 100).toFixed(2)}%`,
  );

  const requiredCodes = ['1950-012', '1950-013', '1950-014'];
  for (const code of requiredCodes) {
    assert.ok(
      variants.some(v => v.code === code),
      `expected to find code ${code}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        matchedRows: variants.length,
        withCodeAndPrice,
        duplicateRate: Number((duplicateRate * 100).toFixed(2)),
        qcReportRows: result.qcReport?.matched_rows ?? 0,
      },
      null,
      2,
    ),
  );
})();
