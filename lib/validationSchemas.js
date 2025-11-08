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

export const ChunkProductSchema = z.object({
  group_title: z.string().min(1),
  category_hint: z.string().optional(),
  description: z.string().optional(),
  headers: z.array(z.string().min(1)).min(1),
  rows: z.array(z.array(Scalar)).min(1),
  notes: z.array(z.string()).optional(),
});

export const ChunkSegmentSchema = z.object({
  segment_id: z.string().optional(),
  label: z.enum(['intro', 'products', 'image_captions', 'noise']),
  page_range: z.array(z.number().int().min(1)).optional().default([]),
  summary: z.string().optional().default(''),
  raw_text_excerpt: z.string().optional(),
  products: z.array(ChunkProductSchema).optional().default([]),
  image_captions: z.array(z.string()).optional().default([]),
});

export const ChunkExtractionResponseSchema = z.object({
  segments: z.array(ChunkSegmentSchema),
});

export const ExtractionPartSchema = z.object({
  pdf_id: z.string(),
  chunk_id: z.string(),
  pages: z.array(z.number().int().min(1)).min(1),
  model: z.string().optional(),
  config: z
    .object({
      max_chars: z.number().optional(),
      temperature: z.number().optional(),
    })
    .optional(),
  meta: z
    .object({
      chunk_chars: z.number().optional(),
      tokens_estimate: z.number().optional(),
    })
    .optional(),
  segments: z.array(ChunkSegmentSchema),
});

export const ExtractionManifestSchema = z.object({
  pdfId: z.string(),
  created_at: z.string(),
  source: z.object({ filename: z.string(), pages: z.number().int().min(1) }),
  config: z.object({
    MAX_CHARS_PER_REQUEST: z.number(),
    MIN_CHARS_BEFORE_FAIL: z.number(),
    PAGES_PER_CHUNK_DEFAULT: z.number(),
  }),
  parts: z.array(
    z.object({
      chunk_id: z.string(),
      pages: z.array(z.number().int().min(1)).min(1),
      status: z.enum(['ok', 'error']),
      file: z.string(),
      error: z
        .object({
          message: z.string(),
          detail: z.string().optional(),
        })
        .optional(),
    })
  ),
});

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

export const MergedCatalogSchema = z.object({
  pdfId: z.string(),
  generated_at: z.string(),
  source: z.object({
    filename: z.string(),
    pages: z.number().int().min(1),
  }),
  groups: z.array(GroupSchema),
  notes: z.array(NoteSchema),
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
  artifacts: z
    .object({
      pdf_id: z.string(),
      manifest_path: z.string(),
      merged_catalog_path: z.string(),
      config: z
        .object({
          MAX_CHARS_PER_REQUEST: z.number(),
          MIN_CHARS_BEFORE_FAIL: z.number(),
          PAGES_PER_CHUNK_DEFAULT: z.number(),
        }),
      page_window: z
        .object({
          start: z.number().int().min(1),
          end: z.number().int().min(1),
        })
        .optional(),
    })
    .optional(),
});
