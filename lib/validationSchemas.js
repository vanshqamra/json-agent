import { z } from 'zod';

export const SegmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['intro', 'product_text', 'product_table', 'image_callouts']),
  confidence: z.number().min(0).max(1),
  headers_canonical: z.array(z.string()).optional(),
  actions: z.array(z.string()).optional(),
  hint: z.string().optional(),
});

export const PageSegmentSchema = z.object({
  page: z.number().int().min(1),
  segments: z.array(SegmentSchema),
});

export const SegmentResponseSchema = z.object({
  pages: z.array(PageSegmentSchema),
});

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const VariantSchema = z.record(Scalar);

export const GroupSchema = z.object({
  category: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  specs_headers: z.array(z.string()).optional().default([]),
  variants: z.array(VariantSchema),
  pageStart: z.number().optional(),
  pageEnd: z.number().optional(),
  _warnings: z.array(z.string()).optional(),
});

export const NoteSchema = z.object({
  page: z.number().int().min(1),
  span: z.string(),
  type: z.string(),
  confidence: z.number().min(0).max(1).optional().default(0),
  hint: z.string().optional(),
});

export const ExtractionResultSchema = z.object({
  source: z.object({
    filename: z.string().default('uploaded.pdf'),
    pages: z.number().int().min(1),
  }),
  extraction_version: z.string().default('v1.3'),
  groups: z.array(GroupSchema),
  notes: z.array(NoteSchema),
  pages_preview: z.array(z.any()).optional(),
});
