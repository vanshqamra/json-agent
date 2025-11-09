import assert from 'node:assert/strict';

import { runLLMChunkerPipeline } from '../../lib/llmChunker/pipeline.js';

function createPage(pageNumber, text) {
  return {
    pageNumber,
    rawText: text,
    textBlocks: [{ id: `block-${pageNumber}`, text }],
  };
}

(async function run() {
  const pages = [createPage(1, 'Sample product code AA-01 pack 500 mL price 1200 INR')];

  const mockFallback = async () => ({
    response: {
      groups: [
        {
          title: 'Sample Product',
          category: 'chemical',
          specs_headers: ['Code', 'Pack', 'Price'],
          variants: [
            {
              code: 'AA-01',
              name: 'Sample Product',
              pack: '500 mL',
              price_value: 1200,
              currency: 'INR',
              confidence: 0.5,
              fields_present: ['code', 'name', 'pack', 'price_value'],
            },
          ],
        },
      ],
      warnings: [],
      notes: [],
    },
    diagnostics: {},
    warnings: [],
    source: 'fallback',
  });

  const result = await runLLMChunkerPipeline({
    docId: 'fallback-doc',
    pages,
    dataDir: null,
    options: {
      llmMock: () => ({ groups: [], warnings: ['low_confidence'] }),
      fallbackHandler: mockFallback,
      useCache: false,
    },
  });

  assert.equal(result.chunker.chunks.length, 1, 'expected single chunk recorded');
  assert.equal(result.chunker.chunks[0].source, 'fallback', 'chunk should rely on fallback');
  assert.equal(result.groups.length, 1, 'fallback groups should propagate');
  assert.equal(result.groups[0].variants[0].code, 'AA-01');

  console.log('PASS fallback.test.js');
})().catch(error => {
  console.error('FAIL fallback.test.js', error);
  process.exit(1);
});
