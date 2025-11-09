#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { getDataDir, readJson } from '../lib/io.js';
import { runCatalogPipeline } from '../lib/pipeline/catalogPipeline.js';

function parseArgs(argv) {
  const opts = { doc: null, forcePriceAnchored: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--doc' || token === '-d') {
      opts.doc = argv[index + 1] || null;
      index += 1;
    } else if (token === '--force-price-anchored' || token === '--force-price') {
      opts.forcePriceAnchored = true;
    }
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.doc) {
    console.error('Usage: node scripts/replay.js --doc <docId> [--force-price-anchored]');
    process.exit(1);
    return;
  }

  const dataDir = getDataDir(args.doc);
  const artifactsDir = path.join(dataDir, 'artifacts');
  const pagesPath = path.join(artifactsDir, 'pages.raw.json');
  const pages = await readJson(pagesPath);

  const result = await runCatalogPipeline({
    docId: args.doc,
    pages,
    source: { filename: 'cached_artifacts', pages: pages.length },
    dataDir,
    options: {
      useLLM: false,
      persistArtifacts: true,
      forcePriceAnchored: args.forcePriceAnchored,
    },
  });

  console.log(JSON.stringify({
    status: result.status,
    groups: result.groups.length,
    warnings: result.warnings,
    artifacts: result.artifacts,
    diagnostics: result.diagnostics,
  }, null, 2));
}

main().catch(error => {
  console.error('Replay failed:', error);
  process.exit(1);
});

