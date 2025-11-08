#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

import { extractPdf } from './extract.js';
import { analysePages } from './detect.js';
import { normalizeGroups } from './normalize.js';
import { validateProductsDocument } from './validate.js';
import { writeCanvasSummary } from './canvas.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function parsePageRange(value) {
  if (!value) return { start: 1, end: 10 };
  const match = String(value).match(/(\d+)(?:\s*[-:]\s*(\d+))?/);
  if (!match) return { start: 1, end: 10 };
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2] ?? match[1], 10);
  return { start: Math.max(1, start), end: Math.max(start, Math.min(end, start + 9)) };
}

function buildMeta({ source, introPages }) {
  return {
    source_file: source,
    extraction_version: 'pdf-products-v1',
    generated_at: new Date().toISOString(),
    pages_processed: 10,
    intro_pages: introPages,
  };
}

function computePriceStats(products, priceWarnings) {
  let total = 0;
  let parsed = 0;
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.price) {
        total += 1;
        if (variant.price.list != null) parsed += 1;
      }
    }
  }
  const failures = priceWarnings.length;
  const rate = total === 0 ? 1 : parsed / total;
  return { total, parsed, failures, rate };
}

async function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function collectUnmappedLines(pages, products, introPages) {
  const used = new Set();
  for (const product of products) {
    for (const id of product.usedBlockIds || []) {
      used.add(`${product.pageNumber}:${id}`);
    }
  }
  const unmapped = [];
  for (const page of pages) {
    if (introPages.includes(page.pageNumber)) continue;
    if (!page.textBlocks) continue;
    for (const block of page.textBlocks) {
      const key = `${page.pageNumber}:${block.id}`;
      if (used.has(key)) continue;
      if (!block.text) continue;
      const text = block.text.trim();
      if (!text) continue;
      if (text.length < 6) continue;
      unmapped.push({ page: page.pageNumber, text });
    }
  }
  return unmapped;
}

async function main() {
  const args = parseArgs(process.argv);
  const input = args.in || args.input;
  if (!input) {
    throw new Error('Missing --in <pdf-path> argument');
  }
  const pagesArg = args.pages;
  const outPath = args.out || path.resolve('out/products.json');
  const reportPath = args.report || path.resolve('out/parse_report.json');
  const canvasPath = args.canvas || path.resolve('CANVAS_products.md');

  const { start, end } = parsePageRange(pagesArg);
  const extraction = await extractPdf(input, { startPage: start, endPage: end });
  const { pages } = extraction;
  if (!pages.length) {
    throw new Error('No pages extracted from PDF.');
  }

  const analysis = analysePages(pages);
  analysis.introPages.sort((a, b) => a - b);
  const nonIntroGroups = analysis.groups.filter(group => !analysis.introPages.includes(group.pageNumber));
  const normalization = normalizeGroups(nonIntroGroups);

  const products = normalization.products.map(product => ({
    category: product.category,
    title: product.title,
    description: product.description,
    specs_headers: product.specs_headers,
    variants: product.variants.map(variant => ({
      code: variant.code,
      name: variant.name,
      specs: variant.specs,
      price: variant.price,
      notes: variant.notes,
    })),
    pageNumber: product.pageNumber,
    weak: product.weak,
    usedBlockIds: product.usedBlockIds,
  }));

  const meta = buildMeta({ source: path.resolve(input), introPages: analysis.introPages });
  meta.pages_processed = 10;

  const productsDoc = {
    meta,
    products: products.map(({ pageNumber, weak, usedBlockIds, ...rest }) => rest),
  };

  const validation = validateProductsDocument(productsDoc);
  const schemaIssues = validation.ok ? [] : validation.issues;

  const priceStats = computePriceStats(productsDoc.products, normalization.priceWarnings);
  const unmappedLines = collectUnmappedLines(pages, products, analysis.introPages);

  const report = {
    source_file: path.resolve(input),
    generated_at: meta.generated_at,
    pages_processed: pages.length,
    intro_pages: analysis.introPages,
    page_summaries: analysis.pageSummaries,
    groups_detected: products.length,
    variants_detected: productsDoc.products.reduce((sum, product) => sum + product.variants.length, 0),
    price_parse_failures: normalization.priceWarnings,
    duplicate_codes: normalization.duplicateCodeWarnings,
    weak_tables: normalization.warnings.filter(warn => warn.type === 'weak_table'),
    unmapped_lines: unmappedLines,
    schema_issues: schemaIssues,
    price_parse_success_rate: priceStats.rate,
    blocking: [],
  };

  if (!validation.ok) {
    report.blocking.push('Schema validation failed');
  }

  if (priceStats.rate < 0.8) {
    report.blocking.push('Price parse success rate below 80%');
  }

  if (pages.length < 10) {
    report.blocking.push(`Only ${pages.length} pages extracted; expected 10`);
  }

  const diagnostics = { report };

  await ensureDirectory(outPath);
  await ensureDirectory(reportPath);
  await fs.writeFile(outPath, JSON.stringify(productsDoc, null, 2), 'utf8');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await writeCanvasSummary(canvasPath, productsDoc, diagnostics);

  const summary = `Products: ${productsDoc.products.length}, Variants: ${report.variants_detected}, Intro pages: ${analysis.introPages.join(', ')}`;
  console.log(summary);
  console.log(`Products JSON written to ${path.resolve(outPath)}`);
  console.log(`Parse report written to ${path.resolve(reportPath)}`);
  console.log(`Canvas summary written to ${path.resolve(canvasPath)}`);

  if (!validation.ok) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exitCode = 1;
});
