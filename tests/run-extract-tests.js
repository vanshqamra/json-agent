// Simple regression-style test that feeds text fixtures through the pipeline
import fs from 'fs';
import path from 'path';
import url from 'url';

import { segmentTextPages } from '../lib/pdfSegmenter.js';
import { labelSegments } from '../lib/segmentLabeler.js';
import { assembleGroupsFromSegments } from '../lib/groupAssembler.js';
import { postProcess } from '../lib/postProcessor.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function loadExpected(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'expected', name), 'utf8'));
}

async function runPipelineFromText(text) {
  const pagesText = text
    .split(/\n\s*\n/)
    .map(section => section.trim())
    .filter(Boolean);
  const pages = segmentTextPages(pagesText);
  const labeled = await labelSegments(pages);
  const { groups } = assembleGroupsFromSegments(pages, labeled);
  const processed = await postProcess(groups);
  return { groups: processed };
}

function shallowGroupShape(groups) {
  return groups.map(g => ({
    title: g.title,
    category: g.category,
    variants: g.variants.map(v => ({
      code: v.code,
      pack_size: v.pack_size,
    })).slice(0, 4)
  }));
}

function diff(a,b) {
  return JSON.stringify(a,null,2) + "\n--- vs ---\n" + JSON.stringify(b,null,2);
}

async function main() {
  const text = readFixture('catalog_sample_pages.txt');
  const expected = loadExpected('catalog_sample_pages.json');
  const { groups } = await runPipelineFromText(text);
  const got = { groups: shallowGroupShape(groups) };

  const pass = JSON.stringify(got) === JSON.stringify(expected);
  if (!pass) {
    console.error('FAIL\n' + diff(got, expected));
    process.exit(1);
  }
  console.log('PASS 1 fixture');

  await testPostProcessNormalization();
}

async function testPostProcessNormalization() {
  const groups = [
    {
      title: 'Sample Product',
      category: 'chemical',
      specs_headers: ['code', 'pack_size', 'price_mrp'],
      variants: [
        { code: ' aa-01 ', pack_size: '2 x 500 ml', price_mrp: '₹ 1,200' },
        { code: 'AA-01', pack_size: '2 x 500 ml', price_mrp: '₹1200' },
      ],
    },
  ];

  const processed = await postProcess(groups);
  if (processed.length !== 1) {
    console.error('FAIL postProcess normalization: expected 1 group');
    process.exit(1);
  }
  const variant = processed[0].variants[0];
  if (processed[0].variants.length !== 1) {
    console.error('FAIL postProcess normalization: expected deduped variants');
    process.exit(1);
  }
  if (variant.code !== 'AA-01') {
    console.error('FAIL postProcess normalization: code normalization failed');
    process.exit(1);
  }
  if (variant.price_mrp_value !== 1200) {
    console.error('FAIL postProcess normalization: price normalization failed');
    process.exit(1);
  }
  if (!variant.pack || !variant.pack.base_total) {
    console.error('FAIL postProcess normalization: pack parsing failed');
    process.exit(1);
  }
  console.log('PASS postProcess normalization');
}

await main();
