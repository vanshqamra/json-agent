// Simple regression-style test that feeds text fixtures through the pipeline
import fs from 'fs';
import path from 'path';
import url from 'url';

import { tokenizeAndClassify } from '../lib/tokenize.js';
import { markNoise } from '../lib/noiseFilter.js';
import { detectGroups } from '../lib/groupDetector.js';
import { assembleVariants } from '../lib/variantAssembler.js';
import { normalizeGroupSpecs } from '../lib/specNormalizer.js';
import { postProcess } from '../lib/postProcessor.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function loadExpected(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'expected', name), 'utf8'));
}

async function runPipelineFromText(text) {
  const pagesText = text.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
  let tokenPages = await tokenizeAndClassify(pagesText);
  tokenPages = markNoise(tokenPages);
  let groups = detectGroups(tokenPages);
  groups = assembleVariants(groups);
  groups = await normalizeGroupSpecs(groups);
  groups = await postProcess(groups);
  return { groups };
}

function shallowGroupShape(groups) {
  return groups.map(g => ({
    title: g.title,
    category: g.category,
    variants: g.variants.map(v => ({ code: v.code, pack_size: v.pack_size })).slice(0,4)
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
}

await main();
