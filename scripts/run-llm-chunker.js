#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { getDataDir, readJson } from '../lib/io.js';
import { runLLMChunkerPipeline } from '../lib/llmChunker/pipeline.js';

function parseArgs(argv) {
  const args = { pagesPerChunk: undefined, maxUsd: undefined, concurrency: undefined, nocache: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--doc') {
      args.docId = argv[++i];
    } else if (token === '--pages-per-chunk') {
      args.pagesPerChunk = Number.parseInt(argv[++i], 10);
    } else if (token === '--max-usd') {
      args.maxUsd = Number.parseFloat(argv[++i]);
    } else if (token === '--concurrency') {
      args.concurrency = Number.parseInt(argv[++i], 10);
    } else if (token === '--nocache') {
      args.nocache = true;
    }
  }
  return args;
}

function formatRange(chunk) {
  if (chunk.pageStart === chunk.pageEnd) return `${chunk.pageStart}`;
  return `${chunk.pageStart}-${chunk.pageEnd}`;
}

async function loadPages(docId) {
  const dataDir = getDataDir(docId);
  const pagesPath = path.join(dataDir, 'artifacts', 'pages.raw.json');
  return readJson(pagesPath);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.docId) {
    console.error('Usage: node scripts/run-llm-chunker.js --doc <docId> [--pages-per-chunk N] [--max-usd X] [--concurrency N] [--nocache]');
    process.exit(1);
  }
  try {
    const pages = await loadPages(args.docId);
    const pipeline = await runLLMChunkerPipeline({
      docId: args.docId,
      pages,
      dataDir: getDataDir(args.docId),
      options: {
        pagesPerChunk: args.pagesPerChunk,
        maxUsd: args.maxUsd,
        concurrency: args.concurrency,
        useCache: !args.nocache,
      },
    });
    const chunks = pipeline.chunker?.chunks || [];
    const fallbacks = chunks.filter(chunk => chunk.source === 'fallback').length;
    const totalVariants = pipeline.groups.reduce((acc, group) => acc + (group.variants?.length || 0), 0);
    console.log(`Processed ${chunks.length} chunks for ${args.docId}.`);
    for (const chunk of chunks) {
      console.log(` - ${chunk.chunkId} [${formatRange(chunk)}] ${chunk.status} via ${chunk.source} cost=${Number(chunk.costUsd || 0).toFixed(4)} retries=${chunk.retries || 0}`);
    }
    console.log(`Variants: ${totalVariants} (fallback chunks: ${fallbacks})`);
    console.log(`Estimated spend: $${pipeline.diagnostics?.chunker?.estimatedSpendUsd?.toFixed(4)}`);
    console.log(`Actual spend:    $${pipeline.diagnostics?.chunker?.actualSpendUsd?.toFixed(4)}`);
  } catch (error) {
    console.error('Failed to run LLM chunker:', error?.message || error);
    process.exit(1);
  }
}

main();
