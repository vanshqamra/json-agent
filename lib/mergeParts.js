import path from 'path';

import { ensureDir, getDataDir, listJsonFiles, readJson, writeJson } from './io.js';

function isPartFile(filename) {
  return filename.endsWith('.json') && filename !== 'merged.json';
}

export async function mergeDocParts(docId) {
  const dataDir = getDataDir(docId);
  await ensureDir(dataDir);
  const files = (await listJsonFiles(dataDir)).filter(isPartFile);
  if (!files.length) {
    throw new Error(`No part files found for docId ${docId}`);
  }

  const parts = [];
  const allRows = [];

  for (const file of files) {
    const fullPath = path.join(dataDir, file);
    const payload = await readJson(fullPath);
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    const rows = blocks.flatMap(block => Array.isArray(block.rows) ? block.rows : []);
    allRows.push(...rows);
    parts.push({
      file,
      pageRange: payload?.pageRange || null,
      blockCount: blocks.length,
      rowCount: rows.length,
    });
  }

  const merged = {
    docId,
    generatedAt: new Date().toISOString(),
    parts,
    rows: allRows,
  };

  const mergedPath = path.join(dataDir, 'merged.json');
  await writeJson(mergedPath, merged);
  console.log(`[ingest] merged ${parts.length} part files into ${mergedPath}`);

  return { mergedPath, merged };
}

export async function streamMergedDoc(docId) {
  const { merged } = await mergeDocParts(docId);
  return JSON.stringify(merged);
}
