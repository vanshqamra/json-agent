#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'node:path';

import { segmentTextPages } from '../lib/pdfSegmenter.js';
import { runCatalogPipeline } from '../lib/pipeline/catalogPipeline.js';
import { ensureDir, getDataDir, writeJson } from '../lib/io.js';

const DOC_ID = '4f960036-3101-4d34-b517-fe596ef46a3f';

async function main() {
  const inputPath = process.argv[2] || '/tmp/gc_secondary_pages.txt';
  const text = await fs.readFile(inputPath, 'utf8');
  const pagesText = text.split('\f').map(page => page.trim()).filter(Boolean);
  if (!pagesText.length) {
    throw new Error('No pages found in input text');
  }
  const pages = segmentTextPages(pagesText);
  const source = { filename: path.basename(inputPath), pages: pages.length };
  const dataDir = getDataDir(DOC_ID);
  await ensureDir(dataDir);

  const result = await runCatalogPipeline({
    docId: DOC_ID,
    pages,
    source,
    dataDir,
    options: {
      useLLM: false,
      persistArtifacts: true,
      postProcessOptions: {
        pages,
        docId: DOC_ID,
      },
    },
  });

  const outDir = path.join('out');
  await ensureDir(outDir);
  await writeJson(path.join(outDir, 'catalog.json'), { groups: result.groups, notes: result.notes }, { pretty: true });
  if (result.diagnostics?.custom?.qualigens_gc?.qcReport) {
    await writeJson(
      path.join(outDir, 'qc_report.json'),
      result.diagnostics.custom.qualigens_gc.qcReport,
      { pretty: true },
    );
  }

  console.log(`Pipeline status: ${result.status}`);
  console.log(`Groups: ${result.groups.length}`);
  const variantCount = result.groups.reduce((sum, group) => sum + group.variants.length, 0);
  console.log(`Variants: ${variantCount}`);
}

main().catch(err => {
  console.error('Failed to run Qualigens manual pipeline:', err);
  process.exitCode = 1;
});
