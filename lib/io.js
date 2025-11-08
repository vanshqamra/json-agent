import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DEFAULT_LOCAL_DATA_DIR = '.data';
const DEFAULT_TMP_DIR = '/tmp/json-agent';

function resolveBaseDir() {
  if (process.env.DATA_BASE_DIR) {
    return process.env.DATA_BASE_DIR;
  }
  const isServerless = Boolean(
    process.env.VERCEL ||
      process.env.AWS_REGION ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT,
  );
  if (isServerless) {
    return DEFAULT_TMP_DIR;
  }
  return path.join(process.cwd(), DEFAULT_LOCAL_DATA_DIR);
}

export function getDataDir(docId = '') {
  const base = resolveBaseDir();
  return docId ? path.join(base, docId) : base;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeJson(filePath, data, { pretty = false } = {}) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const buffer = Buffer.from(json, 'utf8');
  await fs.writeFile(filePath, buffer);
  return {
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    buffer,
  };
}

export async function readJson(filePath) {
  const contents = await fs.readFile(filePath, 'utf8');
  return JSON.parse(contents);
}

export async function listJsonFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function stat(filePath) {
  return fs.stat(filePath);
}

export async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
}
