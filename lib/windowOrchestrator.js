import path from 'node:path';

import { ensureDir, getDataDir, writeJson } from './io.js';
import { runCatalogPipeline } from './pipeline/catalogPipeline.js';
import { validateAndMaybeRepair } from './llmValidator.js';
import { applyRepairs } from './repairEngine.js';

const MAX_REPAIR_ITERATIONS = 3;

function chunkPages(pages = [], windowSize = 10) {
  const chunks = [];
  for (let index = 0; index < pages.length; index += windowSize) {
    chunks.push(pages.slice(index, index + windowSize));
  }
  return chunks;
}

function toProvenanceEntry({ docId, windowIndex, pageStart, pageEnd }) {
  return {
    docId: docId || null,
    windowIndex,
    pageStart,
    pageEnd,
  };
}

function mergeProvenance(existing, addition) {
  const list = [];
  const push = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(entry => push(entry));
      return;
    }
    const serialised = JSON.stringify(value);
    if (!list.some(entry => JSON.stringify(entry) === serialised)) {
      list.push(value);
    }
  };
  push(existing);
  push(addition);
  return list;
}

function variantKey(variant) {
  if (!variant || typeof variant !== 'object') return null;
  if (variant.code) {
    return `code:${String(variant.code).trim().toUpperCase()}`;
  }
  if (variant.cas) {
    return `cas:${String(variant.cas).trim().toUpperCase()}`;
  }
  if (variant.name) {
    return `name:${String(variant.name).trim().toLowerCase()}`;
  }
  return null;
}

function mergeVariant(existingVariant, candidateVariant) {
  const existingConfidence = Number(existingVariant?._confidence ?? 0);
  const candidateConfidence = Number(candidateVariant?._confidence ?? 0);
  if (candidateConfidence > existingConfidence) {
    const preservedProvenance = mergeProvenance(existingVariant?._provenance, candidateVariant?._provenance);
    Object.keys(existingVariant).forEach(key => {
      if (!(key in candidateVariant)) {
        delete existingVariant[key];
      }
    });
    Object.assign(existingVariant, candidateVariant);
    existingVariant._provenance = preservedProvenance;
    return;
  }
  for (const [key, value] of Object.entries(candidateVariant)) {
    if (key === '_provenance' || key === '_confidence') continue;
    if (existingVariant[key] == null && value != null) {
      existingVariant[key] = value;
    }
  }
  existingVariant._provenance = mergeProvenance(existingVariant._provenance, candidateVariant._provenance);
  if (candidateConfidence > existingConfidence) {
    existingVariant._confidence = candidateConfidence;
  }
}

function createGroupKey(group) {
  const category = (group?.category || 'general').toLowerCase();
  const title = (group?.title || '').toLowerCase();
  return `${category}|${title}`;
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function mergeGroupsAcrossWindows(windowsResults, { docId }) {
  const groupMap = new Map();
  const mergedGroups = [];
  const allNotes = [];
  const warnings = [];
  const validation = { errors: [], warnings: [] };
  const diagnostics = { windows: [] };
  const qcReports = [];
  const pagesPreview = [];

  for (const windowEntry of windowsResults) {
    const { index, pageStart, pageEnd, baseline, final } = windowEntry;
    if (Array.isArray(final?.warnings)) {
      warnings.push(...final.warnings);
    }
    if (final?.validation?.errors?.length) {
      validation.errors.push(...final.validation.errors);
    }
    if (final?.validation?.warnings?.length) {
      validation.warnings.push(...final.validation.warnings);
    }
    if (Array.isArray(final?.notes)) {
      allNotes.push(...final.notes);
    }
    if (Array.isArray(final?.pagesPreview)) {
      pagesPreview.push(...final.pagesPreview);
    }
    diagnostics.windows.push({
      index,
      pageStart,
      pageEnd,
      status: final?.status || baseline?.status || 'partial',
      warnings: final?.warnings || [],
    });
    if (final?.diagnostics?.qcReport) {
      qcReports.push({ ...final.diagnostics.qcReport, windowIndex: index });
    }
    for (const group of final?.groups || []) {
      const key = createGroupKey(group);
      const provenance = toProvenanceEntry({ docId, windowIndex: index, pageStart, pageEnd });
      if (!groupMap.has(key)) {
        const clonedGroup = cloneValue(group);
        clonedGroup._provenance = mergeProvenance(clonedGroup._provenance, provenance);
        const variantMap = new Map();
        const variants = [];
        for (const variant of clonedGroup.variants || []) {
          const vClone = cloneValue(variant);
          vClone._provenance = mergeProvenance(vClone._provenance, provenance);
          const vKey = variantKey(vClone);
          if (vKey && !variantMap.has(vKey)) {
            variantMap.set(vKey, vClone);
            variants.push(vClone);
          } else if (!vKey) {
            variants.push(vClone);
          } else {
            mergeVariant(variantMap.get(vKey), vClone);
          }
        }
        clonedGroup.variants = variants;
        groupMap.set(key, { group: clonedGroup, variantMap });
        mergedGroups.push(clonedGroup);
      } else {
        const entry = groupMap.get(key);
        entry.group._provenance = mergeProvenance(entry.group._provenance, provenance);
        const seenHeaders = new Set(entry.group.specs_headers || []);
        if (Array.isArray(group.specs_headers)) {
          for (const header of group.specs_headers) {
            if (!seenHeaders.has(header)) {
              entry.group.specs_headers.push(header);
              seenHeaders.add(header);
            }
          }
        }
        if (!entry.group.description && group.description) {
          entry.group.description = group.description;
        }
        if (group.qc_report) {
          qcReports.push({ ...group.qc_report, windowIndex: index });
        }
        for (const variant of group.variants || []) {
          const vClone = cloneValue(variant);
          vClone._provenance = mergeProvenance(vClone._provenance, provenance);
          const vKey = variantKey(vClone);
          if (!vKey) {
            entry.group.variants.push(vClone);
            continue;
          }
          if (!entry.variantMap.has(vKey)) {
            entry.variantMap.set(vKey, vClone);
            entry.group.variants.push(vClone);
            continue;
          }
          mergeVariant(entry.variantMap.get(vKey), vClone);
        }
      }
    }
  }

  return {
    mergedGroups,
    notes: allNotes,
    warnings,
    validation,
    diagnostics,
    qcReports,
    pagesPreview,
  };
}

function pickWorstStatus(statuses = []) {
  const order = ['error', 'partial', 'ok'];
  let current = 'ok';
  for (const status of statuses) {
    const idx = order.indexOf(status);
    const currentIdx = order.indexOf(current);
    if (idx !== -1 && idx < currentIdx) {
      current = status;
    }
  }
  return current;
}

export async function runWindowedPipeline({
  docId,
  pagesRaw = [],
  windowSize = 10,
  enableOcr = false,
  forcePriceAnchored = false,
  llmCritique = true,
  dataDir = null,
  pipelineOptions = {},
  source = null,
}) {
  if (!Array.isArray(pagesRaw) || !pagesRaw.length) {
    return {
      version: 'v2.1.0',
      status: 'partial',
      groups: [],
      notes: [],
      diagnostics: { windowed: { reason: 'no_pages' } },
      warnings: ['window_pipeline_no_pages'],
      validation: { errors: [], warnings: [] },
      artifacts: {},
      pagesPreview: [],
      llmAudit: { enabled: llmCritique, windows: [] },
    };
  }

  const resolvedWindow = Math.max(1, Number.parseInt(windowSize, 10) || 10);
  const windows = chunkPages(pagesRaw, resolvedWindow);
  const resolvedDataDir = dataDir || getDataDir(docId);
  const shouldPersist = Boolean(dataDir);
  if (shouldPersist) {
    await ensureDir(resolvedDataDir);
  }
  const windowsDir = path.join(resolvedDataDir, 'windows');
  if (shouldPersist) {
    await ensureDir(windowsDir);
  }

  const windowResults = [];
  const auditWindows = [];

  for (let index = 0; index < windows.length; index += 1) {
    const windowPages = windows[index];
    const pageStart = windowPages[0]?.pageNumber ?? null;
    const pageEnd = windowPages[windowPages.length - 1]?.pageNumber ?? null;
    const windowDocId = `${docId}-w${index + 1}`;
    const windowSource = source || { filename: `window-${index + 1}`, pages: windowPages.length };
    const windowContext = {
      docId: windowDocId,
      pages: windowPages,
      source: windowSource,
    };

    const baselineResult = await runCatalogPipeline({
      docId: windowDocId,
      pages: windowPages,
      source: windowSource,
      dataDir: null,
      options: {
        ...pipelineOptions,
        forcePriceAnchored,
        persistArtifacts: false,
      },
    });

    const windowDir = path.join(windowsDir, String(index));
    if (shouldPersist) {
      await ensureDir(windowDir);
      await writeJson(path.join(windowDir, 'baseline.groups.json'), baselineResult.groups || [], { pretty: true });
      await writeJson(path.join(windowDir, 'baseline.diagnostics.json'), baselineResult.diagnostics || {}, { pretty: true });
    }

    const auditEntry = {
      index,
      pageStart,
      pageEnd,
      validator: [],
      repairs: [],
    };

    let currentResult = baselineResult;
    let validatorResponse = null;

    if (llmCritique) {
      validatorResponse = await validateAndMaybeRepair({
        inputWindow: { index, pageStart, pageEnd, totalPages: pagesRaw.length },
        rawSegments: windowPages,
        groupsJson: currentResult.groups || [],
        diagnostics: currentResult.diagnostics || {},
        context: { docId, llmCritique, source: windowSource },
      });
      auditEntry.validator.push({ iteration: 0, ...validatorResponse });
      if (shouldPersist) {
        await writeJson(path.join(windowDir, 'validator.iter-0.json'), validatorResponse, { pretty: true });
      }

      let iteration = 0;
      while (validatorResponse && validatorResponse.pass === false && iteration < MAX_REPAIR_ITERATIONS) {
        iteration += 1;
        const repairOutcome = await applyRepairs({
          repairs: validatorResponse.repairs || [],
          windowContext,
          pipelineOptions: {
            ...pipelineOptions,
            forcePriceAnchored,
          },
        });
        currentResult = repairOutcome.result;
        auditEntry.repairs.push({ iteration, adjustments: repairOutcome.adjustments });
        if (shouldPersist) {
          await writeJson(
            path.join(windowDir, `repair.iter-${iteration}.groups.json`),
            currentResult.groups || [],
            { pretty: true },
          );
          await writeJson(
            path.join(windowDir, `repair.iter-${iteration}.diagnostics.json`),
            currentResult.diagnostics || {},
            { pretty: true },
          );
        }
        validatorResponse = await validateAndMaybeRepair({
          inputWindow: { index, pageStart, pageEnd, totalPages: pagesRaw.length },
          rawSegments: windowPages,
          groupsJson: currentResult.groups || [],
          diagnostics: currentResult.diagnostics || {},
          context: { docId, llmCritique, source: windowSource },
        });
        auditEntry.validator.push({ iteration, ...validatorResponse });
        if (shouldPersist) {
          await writeJson(
            path.join(windowDir, `validator.iter-${iteration}.json`),
            validatorResponse,
            { pretty: true },
          );
        }
        if (validatorResponse.pass) {
          break;
        }
      }
    }

    if (shouldPersist) {
      await writeJson(path.join(windowDir, 'final.groups.json'), currentResult.groups || [], { pretty: true });
      await writeJson(path.join(windowDir, 'final.diagnostics.json'), currentResult.diagnostics || {}, { pretty: true });
    }

    auditEntry.finalPass = validatorResponse ? Boolean(validatorResponse.pass) : true;
    windowResults.push({
      index,
      pageStart,
      pageEnd,
      baseline: baselineResult,
      final: currentResult,
    });
    auditWindows.push(auditEntry);
  }

  const merged = mergeGroupsAcrossWindows(windowResults, { docId });
  const statuses = windowResults.map(entry => entry.final?.status || entry.baseline?.status || 'partial');
  const finalStatus = pickWorstStatus(statuses);

  const llmAudit = {
    enabled: llmCritique,
    windows: auditWindows,
  };

  const artifacts = {};
  if (shouldPersist) {
    const mergedCatalogPath = path.join(resolvedDataDir, 'merged.catalog.json');
    const mergedQcPath = path.join(resolvedDataDir, 'merged.qc_report.json');
    const auditPath = path.join(resolvedDataDir, 'llm_audit.json');
    await writeJson(mergedCatalogPath, { groups: merged.mergedGroups, notes: merged.notes }, { pretty: true });
    await writeJson(mergedQcPath, merged.qcReports, { pretty: true });
    await writeJson(auditPath, llmAudit, { pretty: true });
    artifacts.merged_catalog_path = mergedCatalogPath;
    artifacts.merged_qc_report_path = mergedQcPath;
    artifacts.llm_audit_path = auditPath;
    artifacts.windows_dir = windowsDir;
  }

  return {
    version: 'v2.1.0',
    status: finalStatus,
    groups: merged.mergedGroups,
    notes: merged.notes,
    diagnostics: {
      windowed: {
        windows: merged.diagnostics.windows,
        totalWindows: windowResults.length,
      },
      qcReport: merged.qcReports.length ? merged.qcReports[0] : null,
      qcReports: merged.qcReports,
    },
    warnings: merged.warnings,
    validation: merged.validation,
    artifacts,
    pagesPreview: merged.pagesPreview.slice(0, 20),
    llmAudit,
  };
}
