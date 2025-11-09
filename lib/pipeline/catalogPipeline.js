import path from 'node:path';

import { ensureDir, writeJson } from '../io.js';
import { markNoise } from '../noiseFilter.js';
import { labelSegments } from '../segmentLabeler.js';
import { assembleGroupsFromSegments } from '../groupAssembler.js';
import { postProcess } from '../postProcessor.js';
import { GroupSchema, NoteSchema } from '../validationSchemas.js';
import { runUniversalCatalogPass } from '../catalog/pipeline.js';

const PIPELINE_VERSION = 'v2.1.0';

function normaliseGroup(group) {
  const base = {
    category: group?.category || 'general',
    title: group?.title && group.title.trim() ? group.title.trim() : 'Untitled Product',
    description: group?.description || '',
    specs_headers: Array.isArray(group?.specs_headers)
      ? group.specs_headers.filter(Boolean)
      : [],
    variants: Array.isArray(group?.variants) ? group.variants.filter(Boolean) : [],
    pageStart: group?.pageStart,
    pageEnd: group?.pageEnd,
    _warnings: Array.isArray(group?._warnings) ? [...group._warnings] : [],
  };

  if (group?.notes?.length) {
    base.notes = [...group.notes];
  }

  if (group?.category_hint && !base.category_hint) {
    base.category_hint = group.category_hint;
  }

  if (group?._provenance) {
    base._provenance = group._provenance;
  }

  if (group?.source_docId) {
    base.source_docId = group.source_docId;
  }

  if (group?.qc_report) {
    base.qc_report = group.qc_report;
  }

  return { ...group, ...base };
}

function attachVariantProvenance(groups) {
  for (const group of groups) {
    const provenance = {
      groupTitle: group.title,
      pageStart: group.pageStart ?? null,
      pageEnd: group.pageEnd ?? null,
    };
    for (const variant of group.variants) {
      if (variant && typeof variant === 'object' && !variant._provenance) {
        variant._provenance = provenance;
      }
    }
  }
}

function summarisePages(pages, limit = 5) {
  return pages.slice(0, limit).map(page => ({
    pageNumber: page.pageNumber,
    section: page.section || 'unknown',
    isNoise: Boolean(page.isNoise),
    noiseScore: page.noiseScore ?? null,
    textBlocks: (page.textBlocks || []).slice(0, 3).map(block => block.text?.slice(0, 320) || ''),
    tables: (page.tables || []).slice(0, 2).map(tbl => ({
      header: tbl.header,
      sampleRows: tbl.rows?.slice(0, 3) || [],
    })),
  }));
}

function computeNoiseDiagnostics(pages) {
  const counts = { intro: 0, catalog: 0, index: 0, appendix: 0, unknown: 0 };
  const emptyPages = [];
  for (const page of pages) {
    const section = page.section || 'unknown';
    if (counts[section] == null) counts[section] = 0;
    counts[section] += 1;
    const hasBlocks = Array.isArray(page.blocks) && page.blocks.length > 0;
    if (!hasBlocks) {
      emptyPages.push(page.pageNumber);
    }
  }
  return { counts, emptyPages };
}

function sanitiseNotes(notes, validation) {
  const output = [];
  for (const note of notes || []) {
    const candidate = {
      page: note?.page ?? note?.pageNumber ?? 0,
      span: note?.span || note?.id || 'unknown',
      type: note?.type || 'note',
      confidence: note?.confidence ?? 0,
      hint: note?.hint,
    };
    const parsed = NoteSchema.safeParse(candidate);
    if (parsed.success) {
      output.push({ ...note, ...parsed.data });
    } else {
      validation.errors.push({
        kind: 'note',
        reference: candidate.span,
        issues: parsed.error.issues,
      });
    }
  }
  return output;
}

async function persistArtifacts({
  dataDir,
  docId,
  pages,
  labeled,
  groups,
  notes,
  validation,
  qcReport,
}) {
  if (!dataDir) {
    return {};
  }
  const artifactsDir = path.join(dataDir, 'artifacts');
  await ensureDir(artifactsDir);

  const artifactMap = {};

  const writes = [
    { key: 'pages_raw_path', filename: 'pages.raw.json', payload: pages },
    { key: 'segments_labeled_path', filename: 'segments.labeled.json', payload: labeled },
    { key: 'groups_raw_path', filename: 'groups.raw.json', payload: groups },
    { key: 'catalog_path', filename: 'catalog.json', payload: { groups, notes } },
    { key: 'validation_path', filename: 'validation.json', payload: validation },
  ];

  if (qcReport) {
    writes.push({ key: 'qc_report_path', filename: 'qc_report.json', payload: qcReport });
  }

  for (const entry of writes) {
    try {
      const filePath = path.join(artifactsDir, entry.filename);
      await writeJson(filePath, entry.payload, { pretty: true });
      artifactMap[entry.key] = filePath;
    } catch (error) {
      // Swallow errors but record them in validation warnings.
      validation.warnings.push(`failed_to_write_${entry.filename}: ${error.message}`);
    }
  }

  return artifactMap;
}

export async function runCatalogPipeline({
  docId,
  pages,
  source,
  dataDir = null,
  options = {},
}) {
  const {
    useLLM = true,
    persistArtifacts: persist = true,
    postProcessOptions = {},
  } = options;

  const diagnostics = {};
  const validation = { errors: [], warnings: [] };
  const warnings = [];
  let pipelineStatus = 'ok';

  let annotatedPages = pages;
  try {
    annotatedPages = markNoise(pages);
  } catch (error) {
    warnings.push(`noise_marking_failed: ${error.message}`);
    pipelineStatus = 'partial';
  }

  let labeledSegments;
  let labelMeta = { llmConfigured: false, llmUsed: false, llmErrors: [] };
  try {
    const labeled = await labelSegments(annotatedPages, { useLLM });
    labelMeta = labeled.meta || labelMeta;
    labeledSegments = Array.isArray(labeled) ? labeled : [];
    if (!labelMeta.llmConfigured && useLLM) {
      warnings.push('llm_not_configured_falling_back_to_heuristics');
      pipelineStatus = 'partial';
    } else if (labelMeta.llmConfigured && !labelMeta.llmUsed) {
      warnings.push('llm_not_used_fell_back_to_heuristics');
      pipelineStatus = 'partial';
    }
    if (labelMeta.llmErrors?.length) {
      validation.warnings.push(
        ...labelMeta.llmErrors.map(err => `llm_error:${err.status || 'unknown'}:${err.message}`),
      );
    }
  } catch (error) {
    warnings.push(`segment_labeling_failed:${error.message}`);
    labeledSegments = annotatedPages.map(page => ({ page: page.pageNumber, segments: [] }));
    pipelineStatus = 'partial';
  }

  let assembledGroups = [];
  let assembledNotes = [];
  try {
    const assembled = assembleGroupsFromSegments(annotatedPages, labeledSegments);
    assembledGroups = assembled.groups || [];
    assembledNotes = assembled.notes || [];
  } catch (error) {
    warnings.push(`group_assembly_failed:${error.message}`);
    pipelineStatus = 'error';
  }

  let processedGroups = assembledGroups;
  try {
    processedGroups = await postProcess(assembledGroups, postProcessOptions);
  } catch (error) {
    warnings.push(`post_process_failed:${error.message}`);
    pipelineStatus = 'partial';
  }

  let normalisedGroups = processedGroups.map(group => normaliseGroup(group));
  let qcReport = null;

  const forcePriceAnchored =
    options.forcePriceAnchored === true ||
    (process.env.FORCE_PRICE_ANCHORED || '').toString().trim().toLowerCase() === '1';

  const shouldAttemptUniversal = (!normalisedGroups.length || forcePriceAnchored) && annotatedPages?.length;
  if (shouldAttemptUniversal) {
    try {
      const universal = await runUniversalCatalogPass({
        docId,
        pages: annotatedPages,
        dataDir,
        options: {
          forcePriceAnchored,
          minimumConfidence: options.minimumPriceConfidence || 0.5,
        },
      });
      diagnostics.universal = universal.diagnostics;
      if (universal.warnings?.length) {
        warnings.push(...universal.warnings);
      }
      if (universal.groups?.length) {
        normalisedGroups = universal.groups.map(group => normaliseGroup(group));
        qcReport = universal.qcReport || null;
      }
    } catch (error) {
      warnings.push(`universal_catalog_failed:${error.message}`);
      pipelineStatus = pipelineStatus === 'error' ? 'error' : 'partial';
    }
  }

  attachVariantProvenance(normalisedGroups);

  const finalGroups = [];
  for (let index = 0; index < normalisedGroups.length; index += 1) {
    const group = normalisedGroups[index];
    const parsed = GroupSchema.safeParse(group);
    if (!parsed.success) {
      pipelineStatus = pipelineStatus === 'error' ? 'error' : 'partial';
      validation.errors.push({
        kind: 'group',
        index,
        title: group.title,
        issues: parsed.error.issues,
      });
      // keep best-effort group with defaults already applied
      finalGroups.push(group);
    } else {
      finalGroups.push({ ...group });
    }
    if (group._warnings?.length) {
      warnings.push(...group._warnings.map(w => `group_${index + 1}:${w}`));
    }
  }

  const finalNotes = sanitiseNotes(assembledNotes, validation);

  if (!finalGroups.length) {
    pipelineStatus = pipelineStatus === 'error' ? 'error' : 'partial';
    warnings.push('no_groups_detected');
  }

  const noiseSummary = computeNoiseDiagnostics(annotatedPages);
  diagnostics.noise = noiseSummary;
  diagnostics.labeling = labelMeta;

  const pagesPreview = summarisePages(annotatedPages);

  let artifacts = {};
  if (persist && dataDir) {
    try {
      artifacts = await persistArtifacts({
        dataDir,
        docId,
        pages: annotatedPages,
        labeled: labeledSegments,
        groups: finalGroups,
        notes: finalNotes,
        validation,
        qcReport,
      });
    } catch (error) {
      warnings.push(`artifact_persist_failed:${error.message}`);
      pipelineStatus = pipelineStatus === 'error' ? 'error' : 'partial';
    }
  }

  if (qcReport) {
    diagnostics.qcReport = {
      engine: qcReport.engine,
      matched_rows: qcReport.matched_rows ?? 0,
      matched_pattern: qcReport.matched_pattern ?? null,
    };
  }

  if (!('universal' in diagnostics)) {
    diagnostics.universal = null;
  }

  const status = pipelineStatus;
  const globalWarnings = [...warnings, ...validation.warnings];

  return {
    version: PIPELINE_VERSION,
    status,
    groups: finalGroups,
    notes: finalNotes,
    diagnostics,
    warnings: globalWarnings,
    validation,
    artifacts,
    pagesPreview,
  };
}
