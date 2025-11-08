import os from 'os';
import path from 'path';
import fs from 'fs/promises';

export function getDataDir(docId) {
  if (!docId) {
    throw new Error('docId is required to resolve data directory');
  }
  const base = process.env.RUNTIME_TMPDIR || os.tmpdir();
  return path.join(base, 'data', docId);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJson(filePath, payload) {
  const data = JSON.stringify(payload, null, 2);
  await fs.writeFile(filePath, data, 'utf8');
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function listJsonFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}
