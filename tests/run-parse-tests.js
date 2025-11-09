import assert from 'assert';
import { analysePages } from '../scripts/detect.js';
import { normalizeGroups, __test__ as normalizeTest } from '../scripts/normalize.js';
import { __test__ as extractTest } from '../scripts/extract.js';
import { segmentTextPages } from '../lib/pdfSegmenter.js';
import { applyQualigensGcSecondaryParser } from '../lib/custom/qualigensGcSecondary.js';

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

test('Qualigens GC parser extracts multiline reference standards', () => {
  const sample = [
    'GC Secondary Reference Standard',
    'Product Code    CAS No.    Product Name                               Pack Size   Price',
    'Q5311RS100      107-06-2   1,2-Dichloroethane Reference Standard      100 ml      8999',
    'Q5312RS100      95-50-1    1,2-Dichlorobenzene Reference Standard     100 ml      9999',
    'Q5313RS100      541-73-1   1,3-Dichlorobenzene Reference Standard     100 ml      9999',
    'Q5314RS100      106-46-7   1,4-Dichlorobenzene Reference Standard     100 ml      9999',
    'Q5315RS100      75-85-4    tert-Amyl alcohol (2-Methyl-2-butanol) Re  100 ml      6999',
    '                       ference Standard',
    'Notes: Prices subject to change.',
  ].join('\n');

  const pages = segmentTextPages([sample]);
  const parsed = applyQualigensGcSecondaryParser({ pages, groups: [] });
  assert.ok(parsed?.groups?.length, 'parser should emit a group');
  const { variants } = parsed.groups[0];
  assert.strictEqual(variants.length, 5);
  assert.strictEqual(variants[0].product_code, 'Q5311RS100');
  assert.strictEqual(variants[0].price_inr, 8999);
  const collapsed = variants[4].name.replace(/\s+/g, '');
  assert.ok(collapsed.includes('ReferenceStandard'));
  assert.strictEqual(variants[4].pack_size, '100 ml');
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
