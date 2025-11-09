#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { getDataDir, readJson } from '../lib/io.js';
import { runUniversalCatalogPass } from '../lib/catalog/pipeline.js';

function parseArgs(argv) {
  const opts = { doc: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--doc' || token === '-d') {
      opts.doc = argv[index + 1] || null;
      index += 1;
    }
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.doc) {
    console.error('Usage: node scripts/run-price-fallback.js --doc <docId>');
    process.exit(1);
    return;
  }

  const dataDir = getDataDir(args.doc);
  const artifactsDir = path.join(dataDir, 'artifacts');
  const pagesPath = path.join(artifactsDir, 'pages.raw.json');
  const pages = await readJson(pagesPath);

  const result = await runUniversalCatalogPass({
    docId: args.doc,
    pages,
    dataDir,
    options: { forcePriceAnchored: true },
  });

  const qcDir = path.join(artifactsDir, 'price_fallback');
  await fs.mkdir(qcDir, { recursive: true });
  const qcPath = path.join(qcDir, 'qc_report.json');
  if (result.qcReport) {
    await fs.writeFile(qcPath, JSON.stringify(result.qcReport, null, 2));
  }

  console.log(
    JSON.stringify(
      {
        matchedRows: result.qcReport?.matched_rows ?? 0,
        warnings: result.warnings,
        diagnostics: result.diagnostics,
        qcReportPath: result.qcReport ? qcPath : null,
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error('Price anchored fallback failed:', error);
  process.exit(1);
});

