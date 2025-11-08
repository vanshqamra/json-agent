// lib/supabaseIngest.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'json-agent';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast on server if misconfigured
  console.error('[supabaseIngest] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

let supabaseSingleton = null;
function getSupabase() {
  if (!supabaseSingleton) {
    supabaseSingleton = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { headers: { 'X-Client-Info': 'json-agent/ingest' } },
    });
  }
  return supabaseSingleton;
}

// Idempotent bucket ensure (safe to run per request)
export async function ensureBucketExists(bucketName = BUCKET) {
  const supabase = getSupabase();

  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    // If list fails due to permissions, we still try create
    console.warn('[supabaseIngest] listBuckets warning:', listErr.message);
  } else {
    if (Array.isArray(buckets) && buckets.some(b => b.name === bucketName)) {
      return bucketName;
    }
  }

  // Try to create private bucket
  const { error: createErr } = await supabase.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: '50MB',
  });
  if (createErr && !/Bucket already exists/i.test(createErr.message)) {
    throw new Error(`[supabaseIngest] createBucket failed: ${createErr.message}`);
  }
  return bucketName;
}

/**
 * Upload a JSON part to Supabase Storage (private).
 * @param {Object} params
 * @param {string} params.docId - document id folder
 * @param {number} params.partIndex - zero- or one-based index
 * @param {Object} params.content - raw JSON object to persist
 * @param {Object} [params.meta] - optional metadata to store in DB
 * @returns {Promise<{ bucket: string, path: string }>}
 */
export async function uploadPartToSupabase({ docId, partIndex, content, meta = {} }) {
  if (!docId) throw new Error('uploadPartToSupabase: missing docId');
  if (partIndex === undefined || partIndex === null) throw new Error('uploadPartToSupabase: missing partIndex');

  const supabase = getSupabase();
  const bucket = await ensureBucketExists();

  // Normalize index to 1-based, zero-padded
  const displayIndex = (Number(partIndex) + 1).toString().padStart(4, '0');
  const objectPath = `${docId}/part-${displayIndex}.json`;

  const jsonString = JSON.stringify(content ?? {}, null, 0);
  const { error: uploadErr } = await supabase
    .storage
    .from(bucket)
    .upload(objectPath, new Blob([jsonString], { type: 'application/json' }), { upsert: true });

  if (uploadErr) {
    throw new Error(`[supabaseIngest] upload failed: ${uploadErr.message}`);
  }

  // Optional: index in DB
  // Ensure a table like:
  // create table if not exists public.json_parts (
  //   id bigint generated always as identity primary key,
  //   doc_id text not null,
  //   part_index int not null,
  //   storage_bucket text not null,
  //   storage_path text not null,
  //   bytes int,
  //   created_at timestamptz default now(),
  //   meta jsonb
  // );
  if (meta && Object.keys(meta).length) {
    const { error: insertErr } = await supabase
      .from('json_parts')
      .insert({
        doc_id: docId,
        part_index: Number(partIndex),
        storage_bucket: bucket,
        storage_path: objectPath,
        bytes: jsonString.length,
        meta,
      });
    if (insertErr) {
      // Non-fatal; we still uploaded the file
      console.warn('[supabaseIngest] DB index insert warning:', insertErr.message);
    }
  }

  return { bucket, path: objectPath };
}
