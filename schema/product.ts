import { z } from 'zod';

const nullableString = z.union([z.string(), z.null()]);
const nullableNumber = z.union([z.number(), z.null()]);

export const priceSchema = z.object({
  currency: nullableString,
  list: nullableNumber,
  unit: nullableString,
});

export const variantSchema = z.object({
  code: nullableString,
  name: nullableString,
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  price: priceSchema,
  notes: nullableString,
});

export const productSchema = z.object({
  category: nullableString,
  title: z.string(),
  description: nullableString,
  specs_headers: z.array(z.string()),
  variants: z.array(variantSchema).min(1),
});

export const productsSchema = z.object({
  meta: z.object({
    source_file: z.string(),
    extraction_version: z.string(),
    generated_at: z.string(),
    pages_processed: z.number().int().min(10).max(10),
    intro_pages: z.array(z.number().int().min(1)),
  }),
  products: z.array(productSchema),
});

export type Price = z.infer<typeof priceSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductsFile = z.infer<typeof productsSchema>;
