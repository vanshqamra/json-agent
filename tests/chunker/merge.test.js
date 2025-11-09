import assert from 'node:assert/strict';

import { mergeChunkResponses } from '../../lib/llmChunker/mergeChunks.js';

(function run() {
  const chunkResults = [
    {
      chunkId: 'chunk-001',
      pageStart: 1,
      pageEnd: 5,
      source: 'llm',
      response: {
        groups: [
          {
            title: 'Acetone',
            category: 'solvent',
            specs_headers: ['Code', 'Pack', 'Price'],
            variants: [
              {
                code: 'AC-100',
                name: 'Acetone LR',
                pack: '500 mL',
                price_value: 1200,
                currency: 'INR',
                confidence: 0.8,
                fields_present: ['code', 'name', 'pack', 'price_value'],
              },
            ],
          },
        ],
      },
    },
    {
      chunkId: 'chunk-002',
      pageStart: 6,
      pageEnd: 10,
      source: 'llm',
      response: {
        groups: [
          {
            title: 'Acetone',
            category: 'solvent',
            specs_headers: ['SKU', 'Pack Size', 'MRP'],
            variants: [
              {
                code: 'AC-100',
                name: 'Acetone LR',
                pack: '0.5 L',
                price_value: 1250,
                currency: 'INR',
                confidence: 0.7,
                fields_present: ['code', 'name', 'pack', 'price_value'],
              },
              {
                code: null,
                name: 'Acetone HR',
                pack: '1 L',
                price_value: 2200,
                currency: 'INR',
                confidence: 0.6,
              },
            ],
          },
        ],
      },
    },
  ];

  const merged = mergeChunkResponses(chunkResults);
  assert.equal(merged.groups.length, 1, 'should merge groups with same title');
  const group = merged.groups[0];
  assert.equal(group.variants.length, 2, 'deduplication should collapse matching code variant');
  const codeVariant = group.variants.find(v => v.code === 'AC-100');
  assert.ok(codeVariant, 'code variant missing');
  assert.equal(codeVariant.confidence >= 0.8, true, 'confidence should keep max value');
  assert.ok(merged.priceConflicts.length >= 1, 'price conflicts should be recorded');
  assert.ok(merged.canonicalHeaders.length >= 3, 'header union expected');

  console.log('PASS merge.test.js');
})();
