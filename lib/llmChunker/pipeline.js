import path from 'node:path';

import { ensureDir, pathExists, readJson, writeJson } from '../io.js';
import { postProcess } from '../postProcessor.js';
import { GroupSchema } from '../validationSchemas.js';
import { chunkPdfPages } from './chunkPdf.js';
import {
  createDocumentContext,
  formatContextForPrompt,
  updateContextWithChunk,
} from './buildContext.js';
import { buildChunkPrompt } from './prompt.js';
import { callLLMForChunk, ChunkerBudgetTracker } from './callLLM.js';
import { mergeChunkResponses } from './mergeChunks.js';
import { runFallbackForChunk } from './fallbackChunk.js';
import { buildChunkerQcReport } from './qc.js';
import { runUniversalCatalogPass } from '../catalog/pipeline.js';

function extractRawText(pages = []) {
  const lines = [];
  for (const page of pages) {
    if (page?.rawText) {
      lines.push(page.rawText);
      continue;
    }
    if (Array.isArray(page?.textBlocks)) {
      for (const block of page.textBlocks) {
        if (block?.text) lines.push(block.text);
      }
    }
  }
  return lines.join('\n');
}

function shouldFallback(response) {
  if (!response) return true;
  if (!Array.isArray(response.groups) || !response.groups.length) return true;
  if (Array.isArray(response.warnings)) {
    return response.warnings.some(warning => /low[_\s-]*confidence/i.test(warning));
  }
  return false;
}

function summarisePages(pages, limit = 5) {
  return pages.slice(0, limit).map(page => ({
    pageNumber: page.pageNumber,
    preview: (page.rawText || '').slice(0, 160),
  }));
}

async function loadCachedChunk(chunkDir, textHash) {
  const chunkPath = path.join(chunkDir, 'chunk.json');
  if (!(await pathExists(chunkPath))) {
    return null;
  }
  try {
    const cached = await readJson(chunkPath);
    if (cached?.textHash === textHash) {
      return cached;
    }
  } catch (error) {
    return null;
  }
  return null;
}

async function persistChunk(chunkDir, payload) {
  const enriched = { ...payload, updatedAt: new Date().toISOString() };
  await writeJson(path.join(chunkDir, 'chunk.json'), enriched, { pretty: true });
  return enriched;
}

function normaliseValidation(groups) {
  const validation = { errors: [], warnings: [] };
  const safeGroups = [];
  groups.forEach((group, index) => {
    const parsed = GroupSchema.safeParse(group);
    if (!parsed.success) {
      validation.errors.push({
        kind: 'group',
        index,
        title: group?.title,
        issues: parsed.error.issues,
      });
      safeGroups.push(group);
    } else {
      safeGroups.push(parsed.data);
    }
  });
  return { validation, groups: safeGroups };
}

function attachVariantProvenance(groups, provenanceMap) {
  for (const group of groups) {
    for (const variant of group.variants || []) {
      const variantId = variant.__variantId;
      if (variantId && provenanceMap[variantId]) {
        variant._provenance = {
          chunkId: provenanceMap[variantId].chunkId,
          pageStart: provenanceMap[variantId].pageStart,
          pageEnd: provenanceMap[variantId].pageEnd,
          source: provenanceMap[variantId].source,
          variantId,
        };
      }
      delete variant.__variantId;
    }
  }
}

async function runDeterministicReconciliation({ docId, pages, groups, options }) {
  try {
    const deterministic = await runUniversalCatalogPass({
      docId: `${docId}::deterministic`,
      pages,
      dataDir: null,
      options,
    });
    return deterministic;
  } catch (error) {
    return { warnings: [`deterministic_reconcile_failed:${error?.message || 'unknown'}`] };
  }
}

export async function runLLMChunkerPipeline({
  docId,
  pages,
  dataDir,
  options = {},
}) {
  const pagesPerChunk = options.pagesPerChunk || Number.parseInt(process.env.PAGES_PER_CHUNK || '10', 10);
  const concurrency = options.concurrency || Number.parseInt(process.env.LLM_CONCURRENCY || '2', 10) || 1;
  const budget = new ChunkerBudgetTracker(options.maxUsd || Number.parseFloat(process.env.LLM_MAX_USD || '10'));
  const useCache = options.useCache !== false;

  const chunks = chunkPdfPages(pages, { pagesPerChunk, docId });
  const chunkResults = [];
  const context = createDocumentContext();
  const artifactsDir = dataDir ? path.join(dataDir, 'artifacts') : null;
  const chunkDirRoot = artifactsDir ? path.join(artifactsDir, 'chunks') : null;
  if (chunkDirRoot) {
    await ensureDir(chunkDirRoot);
  }

  let processedIndex = 0;
  const workers = [];

  async function worker() {
    while (processedIndex < chunks.length) {
      const index = processedIndex;
      processedIndex += 1;
      const chunk = chunks[index];
      const chunkPages = chunk.pages || [];
      const chunkText = extractRawText(chunkPages);
      const chunkContext = formatContextForPrompt(context);
      const prompt = buildChunkPrompt({
        docId,
        chunkId: chunk.chunkId,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        pages: chunkPages,
        context: chunkContext,
      });

      const chunkDir = chunkDirRoot ? path.join(chunkDirRoot, chunk.chunkId) : null;
      if (chunkDir) await ensureDir(chunkDir);
      let cached = null;
      if (useCache && chunkDir) {
        cached = await loadCachedChunk(chunkDir, chunk.textHash);
      }

      let invocation = null;
      let source = 'llm';
      let status = 'queued';
      if (cached) {
        invocation = cached;
        status = cached.status || 'cached';
        source = cached.source || 'llm';
      } else {
        try {
          status = 'running';
          const mockResponse = typeof options.llmMock === 'function'
            ? options.llmMock({ chunk, prompt })
            : options.mockResponse;
          invocation = await callLLMForChunk({ prompt, budget, mockResponse });
          source = 'llm';
        } catch (error) {
          source = 'error';
          invocation = {
            response: { groups: [], warnings: [`llm_error:${error?.code || error?.message || 'unknown'}`], notes: [] },
            costUsd: 0,
            retries: 0,
            usage: null,
            error: error?.message,
          };
        }
        if (chunkDir) {
          await persistChunk(chunkDir, {
            ...invocation,
            textHash: chunk.textHash,
            chunkId: chunk.chunkId,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            source,
            status: invocation?.error ? 'error' : 'completed',
          });
        }
      }

      let response = invocation?.response || invocation?.parsed || invocation || { groups: [], warnings: [] };
      let usedSource = source;
      let retries = invocation?.retries || 0;
      let costUsd = invocation?.costUsd || 0;
      let estimatedCostUsd = invocation?.estimatedCostUsd || costUsd;

      if (shouldFallback(response)) {
        const fallbackHandler = options.fallbackHandler || runFallbackForChunk;
        const fallback = await fallbackHandler({
          docId,
          chunkId: chunk.chunkId,
          pages: chunkPages,
          options: { forcePriceAnchored: options.forcePriceAnchored },
        });
        if (fallback?.response?.groups?.length) {
          response = fallback.response;
          usedSource = 'fallback';
          if (chunkDir && !cached) {
            await persistChunk(chunkDir, {
              ...invocation,
              response,
              textHash: chunk.textHash,
              chunkId: chunk.chunkId,
              pageStart: chunk.pageStart,
              pageEnd: chunk.pageEnd,
              source: usedSource,
              status: 'fallback',
            });
          }
        }
      }

      const result = {
        chunkId: chunk.chunkId,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        response,
        textHash: chunk.textHash,
        status: usedSource === 'fallback' ? 'fallback' : 'done',
        costUsd,
        estimatedCostUsd,
        retries,
        source: usedSource,
      };
      chunkResults[index] = result;
      updateContextWithChunk(context, result);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, chunks.length));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const merged = mergeChunkResponses(chunkResults);
  attachVariantProvenance(merged.groups, merged.provenance);

  const postProcessed = await postProcess(merged.groups, options.postProcessOptions || {});
  const { validation, groups: validatedGroups } = normaliseValidation(postProcessed);

  const deterministic = await runDeterministicReconciliation({
    docId,
    pages,
    groups: validatedGroups,
    options: { forcePriceAnchored: options.forcePriceAnchored },
  });
  if (deterministic?.warnings?.length) {
    validation.warnings.push(...deterministic.warnings);
  }

  const qcReport = buildChunkerQcReport({
    docId,
    chunkResults,
    mergedGroups: validatedGroups,
    priceConflicts: merged.priceConflicts,
    provenance: merged.provenance,
  });

  const notes = chunkResults.flatMap(result => result.response?.notes || []);

  const estimatedSpend = chunkResults.reduce((acc, entry) => acc + Number(entry.estimatedCostUsd || 0), 0);
  const actualSpend = chunkResults.reduce((acc, entry) => acc + Number(entry.costUsd || 0), 0);

  const chunkWarnings = chunkResults.flatMap(result => result.response?.warnings || []);

  const diagnostics = {
    chunker: {
      chunksProcessed: chunkResults.length,
      estimatedSpendUsd: Number(estimatedSpend.toFixed(4)),
      actualSpendUsd: Number(actualSpend.toFixed(4)),
      concurrency: workerCount,
    },
    deterministic,
  };

  const artifacts = {};
  if (artifactsDir) {
    await ensureDir(artifactsDir);
    const llmPath = path.join(artifactsDir, 'catalog.llm.json');
    const finalPath = path.join(artifactsDir, 'catalog.json');
    const qcPath = path.join(artifactsDir, 'qc_report.json');
    const provenancePath = path.join(artifactsDir, 'provenance.json');
    await writeJson(llmPath, { groups: merged.groups }, { pretty: true });
    await writeJson(finalPath, { groups: validatedGroups, notes }, { pretty: true });
    await writeJson(qcPath, qcReport, { pretty: true });
    await writeJson(provenancePath, merged.provenance, { pretty: true });
    artifacts.catalog_llm_path = llmPath;
    artifacts.catalog_path = finalPath;
    artifacts.qc_report_path = qcPath;
    artifacts.provenance_path = provenancePath;
  }

  const status = validatedGroups.length ? 'ok' : 'partial';

  return {
    version: 'llm-chunker-v1',
    status,
    groups: validatedGroups,
    notes,
    diagnostics,
    warnings: [...validation.warnings, ...chunkWarnings],
    validation,
    artifacts,
    pagesPreview: summarisePages(pages),
    llm: {
      configured: true,
      used: true,
      model: process.env.LLM_MODEL || 'gpt-5',
      chunker: true,
    },
    price_anchored_forced: Boolean(options.forcePriceAnchored),
    chunker: {
      chunks: chunkResults.map(result => ({
        chunkId: result.chunkId,
        pageStart: result.pageStart,
        pageEnd: result.pageEnd,
        status: result.status,
        source: result.source,
        costUsd: result.costUsd,
        estimatedCostUsd: result.estimatedCostUsd,
        retries: result.retries,
      })),
    },
    qcReport,
  };
}

