// /lib/io.js
import path from 'node:path';
import fs from 'node:fs/promises';

export function getDataDir(docId) {
  // Prefer env override, else use /tmp in serverless; local dev falls back to project ./data
  const base =
    process.env.DATA_BASE_DIR ||
    (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '/tmp/data' : path.join(process.cwd(), 'data'));
  return path.join(base, docId);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath, obj) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

export async function readJsonFile(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}
