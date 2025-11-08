import { productsSchema } from '../schema/product.js';

export function validateProductsDocument(doc) {
  try {
    const data = productsSchema.parse(doc);
    return { ok: true, data };
  } catch (error) {
    if (error && Array.isArray(error.issues)) {
      const issues = error.issues.map(issue => ({
        path: Array.isArray(issue.path) ? issue.path.join('.') || '(root)' : '(root)',
        message: issue.message,
      }));
      return { ok: false, issues };
    }
    return { ok: false, issues: [{ path: '(root)', message: error.message || 'Validation failed' }] };
  }
}
