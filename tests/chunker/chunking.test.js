import assert from 'node:assert/strict';

import { chunkPdfPages, reChunkWithStableWindows } from '../../lib/llmChunker/chunkPdf.js';

function createMockPages(count) {
  return Array.from({ length: count }, (_, index) => ({
    pageNumber: index + 1,
    rawText: `Page ${index + 1} contents`,
  }));
}

(function run() {
  const pages = createMockPages(23);
  const chunks = chunkPdfPages(pages, { pagesPerChunk: 10, docId: 'testdoc' });
  assert.equal(chunks.length, 3, 'expected three chunks');
  assert.equal(chunks[0].pageStart, 1);
  assert.equal(chunks[0].pageEnd, 10);
  assert.equal(chunks[1].pageStart, 11);
  assert.equal(chunks[1].pageEnd, 20);
  assert.equal(chunks[2].pageStart, 21);
  assert.equal(chunks[2].pageEnd, 23);

  const reChunked = reChunkWithStableWindows(chunks, pages, { pagesPerChunk: 10, docId: 'testdoc' });
  assert.equal(reChunked.length, chunks.length, 'stable rechunk count mismatch');
  for (let i = 0; i < chunks.length; i += 1) {
    assert.equal(reChunked[i].chunkId, chunks[i].chunkId, 'chunk id should remain stable');
    assert.equal(reChunked[i].textHash, chunks[i].textHash, 'text hash should remain stable');
  }

  console.log('PASS chunking.test.js');
})();
