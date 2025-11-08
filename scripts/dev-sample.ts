import { normalizeGroups } from './normalize.js';
import { validateProductsDocument } from './validate.js';

const detectedGroups = [
  {
    pageNumber: 1,
    header: ['Cat No', 'Product', 'Capacity (mL)', 'Price (₹)'],
    rows: [
      ['QG-1001', 'Reagent Bottle Amber', '100', '₹ 120.00 / pc'],
      ['QG-1002', 'Reagent Bottle Amber', '250', '₹ 160.00 / pc'],
      ['QG-1003', 'Reagent Bottle Amber', '500', '₹ 220.00 / pc'],
    ],
    sourceRows: [],
    heading: 'Amber Reagent Bottles',
    description: 'Chemically resistant amber reagent bottles with screw caps.',
    usedBlockIds: ['p1-t1'],
    bbox: null,
    weak: false,
    rowCount: 3,
  },
];

const normalization = normalizeGroups(detectedGroups);
const meta = {
  source_file: 'dev-sample-fixture.pdf',
  extraction_version: 'pdf-products-v1',
  generated_at: new Date().toISOString(),
  pages_processed: 10,
  intro_pages: [],
};

const doc = {
  meta,
  products: normalization.products.map(product => ({
    category: product.category,
    title: product.title,
    description: product.description,
    specs_headers: product.specs_headers,
    variants: product.variants,
  })),
};

const validation = validateProductsDocument(doc);

if (!validation.ok) {
  console.error('Validation failed for dev sample', validation.issues);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(doc, null, 2));
}
