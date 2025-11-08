import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'json-agent';

let serverClient = null;
const ensuredBuckets = new Set();

function hasServerCredentials() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseServerClient() {
  if (!hasServerCredentials()) {
    return null;
  }
  if (!serverClient) {
    serverClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return serverClient;
}

export async function ensureBucketExists(bucket = DEFAULT_BUCKET) {
  const client = getSupabaseServerClient();
  if (!client) return null;
  const targetBucket = bucket || DEFAULT_BUCKET;
  if (!targetBucket) return null;
  if (ensuredBuckets.has(targetBucket)) {
    return { bucket: targetBucket, created: false };
  }
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) {
    throw listError;
  }
  if (Array.isArray(buckets) && buckets.some(entry => entry.name === targetBucket)) {
    ensuredBuckets.add(targetBucket);
    return { bucket: targetBucket, created: false };
  }
  const { data, error } = await client.storage.createBucket(targetBucket, {
    public: false,
    fileSizeLimit: 50 * 1024 * 1024,
  });
  if (error && !String(error.message || '').includes('already exists')) {
    throw error;
  }
  ensuredBuckets.add(targetBucket);
  return { bucket: data?.name || targetBucket, created: !error };
}

function normaliseUploadPayload(data) {
  if (data == null) {
    return Buffer.from('');
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  return Buffer.from(JSON.stringify(data));
}

export async function uploadPartToSupabase({
  bucket = DEFAULT_BUCKET,
  key,
  data,
  contentType = 'application/json',
  metadata,
} = {}) {
  if (!key) {
    throw new Error('Supabase upload requires a storage key.');
  }
  const client = getSupabaseServerClient();
  if (!client) return null;
  await ensureBucketExists(bucket);
  const payload = normaliseUploadPayload(data);
  const { error } = await client.storage.from(bucket).upload(key, payload, {
    cacheControl: '3600',
    contentType,
    upsert: true,
    metadata,
  });
  if (error) {
    throw error;
  }
  const { data: publicData } = client.storage.from(bucket).getPublicUrl(key);
  return {
    bucket,
    path: key,
    publicUrl: publicData?.publicUrl || null,
  };
}
