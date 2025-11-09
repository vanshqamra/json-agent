#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { getDataDir, readJson } from '../lib/io.js';
import { runLLMChunkerPipeline } from '../lib/llmChunker/pipeline.js';

async function main() {
  const args = process.argv.slice(2);
  const docFlagIndex = args.indexOf('--doc');
  if (docFlagIndex === -1 || !args[docFlagIndex + 1]) {
    console.error('Usage: node scripts/merge-llm-chunks.js --doc <docId>');
    process.exit(1);
  }
  const docId = args[docFlagIndex + 1];
  try {
    const pagesPath = path.join(getDataDir(docId), 'artifacts', 'pages.raw.json');
    const pages = await readJson(pagesPath);
    const result = await runLLMChunkerPipeline({
      docId,
      pages,
      dataDir: getDataDir(docId),
      options: { useCache: true },
    });
    console.log(`Merged ${result.chunker?.chunks?.length || 0} chunks for ${docId}.`);
    console.log(`Final groups: ${result.groups.length}`);
    console.log(`Artifacts:`);
    for (const [key, value] of Object.entries(result.artifacts || {})) {
      console.log(` - ${key}: ${value}`);
    }
  } catch (error) {
    console.error('Failed to merge LLM chunks:', error?.message || error);
    process.exit(1);
  }
}

main();
