import fs from 'node:fs/promises';
import path from 'node:path';

export type PatternColumn = {
  role: 'code' | 'cas' | 'name' | 'pack' | 'price' | 'notes';
  required?: boolean;
  header_keywords?: string[];
  value_regex?: string;
  min_length?: number;
};

export type PatternDefinition = {
  id?: string;
  description?: string;
  filename?: string;
  columns: PatternColumn[];
  validation?: {
    required_roles?: string[];
    optional_roles?: string[];
    min_confidence?: number;
  };
  normalization?: {
    currency?: {
      default?: string;
      symbols?: Record<string, string>;
      codes?: Record<string, string>;
    };
    units?: {
      pack?: { pattern: string; format?: string }[];
    };
  };
};

export type PatternRegistry = {
  patterns: PatternDefinition[];
  errors: string[];
};

export type PatternAttempt = {
  pattern_id: string | undefined;
  matched_rows: number;
  reason: string | null;
};

export type PatternRow = {
  code: string | null;
  cas: string | null;
  name: string;
  pack: string | null;
  price_value: number | null;
  currency: string | null;
  notes: string | null;
  confidence: number;
  fields_present: string[];
  fields_bitmask: number;
  source: { text: string; pageNumber?: number | null; blockId?: string | null } | null;
};

export async function loadPatternRegistry(patternsDir: string): Promise<PatternRegistry> {
  const patterns: PatternDefinition[] = [];
  const errors: string[] = [];
  try {
    const entries = await fs.readdir(patternsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      const filePath = path.join(patternsDir, entry.name);
      const contents = await fs.readFile(filePath, 'utf8');
      try {
        const parsed = JSON.parse(contents) as PatternDefinition;
        patterns.push({ ...parsed, filename: entry.name });
      } catch (error) {
        errors.push(`Failed to parse pattern ${entry.name}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    errors.push(`registry_read_failed:${(error as Error).message}`);
  }
  return { patterns, errors };
}

export class PatternEngine {
  constructor(
    private readonly patterns: PatternDefinition[] = [],
    private readonly options: Record<string, unknown> = {},
  ) {}

  matchPages(
    pages: Array<{ textBlocks?: Array<{ id?: string; text?: string }>; segments?: Array<{ id?: string; text?: string }>; tables?: Array<{ id?: string; header?: string[]; rows?: string[][] }>; pageNumber?: number }>,
    context: { docId?: string | null; dataDir?: string | null } = {},
  ): {
    groups: Array<Record<string, unknown>>;
    qcReport: Record<string, unknown> | null;
    diagnostics: Record<string, unknown>;
    warnings: string[];
  } {
    // Implementation intentionally mirrors the JavaScript runtime version.
    // TypeScript file is provided for documentation and editor support.
    throw new Error('PatternEngine.matchPages is not implemented in TypeScript runtime file. Use engine.js instead.');
  }
}

