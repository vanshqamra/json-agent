import assert from 'assert';
import { analysePages } from '../scripts/detect.js';
import { normalizeGroups, __test__ as normalizeTest } from '../scripts/normalize.js';
import { __test__ as extractTest } from '../scripts/extract.js';

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('header detection maps code and price columns', () => {
  const detectedGroups = [
    {
      pageNumber: 2,
      header: ['Cat No', 'Description', 'Pack Size', 'Price (Rs)'],
      rows: [
        ['AX-01', 'Premium Bottle', '6', 'Rs. 1,200.00'],
      ],
      sourceRows: [],
      heading: 'Premium Bottles',
      description: 'Durable premium bottles.',
      usedBlockIds: [],
      bbox: null,
      weak: false,
      rowCount: 1,
    },
  ];
  const result = normalizeGroups(detectedGroups);
  assert.strictEqual(result.products.length, 1);
  const variant = result.products[0].variants[0];
  assert.strictEqual(variant.code, 'AX-01');
  assert.strictEqual(variant.price.list, 1200);
  assert.strictEqual(variant.specs['Pack Size'], '6');
});

test('wrapped cell text merges within same column', () => {
  const items = [
    { text: 'AX-01', bbox: { x: 10, width: 20, y: 100, height: 10 } },
    { text: 'Premium', bbox: { x: 80, width: 20, y: 100, height: 10 } },
    { text: 'Bottle', bbox: { x: 105, width: 20, y: 100, height: 10 } },
    { text: '500', bbox: { x: 160, width: 20, y: 100, height: 10 } },
  ];
  const clusters = extractTest.splitColumnsFromItems(items);
  assert.strictEqual(clusters.length, 3);
  assert.strictEqual(clusters[1].text, 'Premium Bottle');
});

test('indian numbering is parsed correctly', () => {
  const value = normalizeTest.parseNumeric('1,20,000');
  assert.strictEqual(value, 120000);
});

test('duplicate codes are reported', () => {
  const detectedGroups = [
    {
      pageNumber: 3,
      header: ['Cat No', 'Product', 'Price'],
      rows: [
        ['AX-01', 'Bottle', '₹ 100'],
        ['AX-01', 'Bottle', '₹ 110'],
      ],
      sourceRows: [],
      heading: 'Duplicate Test',
      description: 'Testing duplicates',
      usedBlockIds: [],
      bbox: null,
      weak: false,
      rowCount: 2,
    },
  ];
  const result = normalizeGroups(detectedGroups);
  assert.strictEqual(result.duplicateCodeWarnings.length, 1);
  assert.strictEqual(result.duplicateCodeWarnings[0].code, 'ax-01');
});

test('intro page detection marks marketing content', () => {
  const pages = [
    {
      pageNumber: 1,
      textBlocks: [
        { id: 'p1-t1', text: 'Our Vision & Mission', bbox: { x: 10, y: 10, width: 100, height: 20 } },
        { id: 'p1-t2', text: 'Quality policy and certifications.', bbox: { x: 10, y: 40, width: 200, height: 20 } },
      ],
      tables: [],
    },
  ];
  const analysis = analysePages(pages);
  assert.ok(analysis.introPages.includes(1));
  assert.strictEqual(analysis.pageSummaries[0].intro, true);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

if (passed === tests.length) {
  console.log(`All ${passed} tests passed.`);
}
