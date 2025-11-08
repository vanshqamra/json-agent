// lib/supabaseIngest.js
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'json-agent';

// Guard so we blow up only on the server, not at import-time in the client.
function assertServerEnv() {
  if (!URL || !SERVICE_KEY) {
    throw new Error(
      'Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
}

// Create an admin client (service role) — server-only!
export function getSupabaseAdmin() {
  assertServerEnv();
  return createClient(URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Ensure bucket exists (idempotent)
export async function ensureBucketExists() {
  const supabase = getSupabaseAdmin();
  const { data: list, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) throw listErr;
  const exists = (list || []).some(b => b.name === BUCKET);
  if (exists) return { created: false, bucket: BUCKET };

  const { data, error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 50 * 1024 * 1024, // 50MB per file (tune as needed)
  });
  if (error) throw error;
  return { created: true, bucket: data.name };
}

// PUBLIC API used by your blockProcessing.js
export async function uploadPartToSupabase({ docId, partIndex, data }) {
  const supabase = getSupabaseAdmin();
  const key = `${docId}/parts/part-${String(partIndex).padStart(4, '0')}.json`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);

  // Optional: ensure bucket exists (first run)
  await ensureBucketExists();

  // Upload (upsert so re-runs overwrite)
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, payload, {
      contentType: 'application/json',
      upsert: true,
    });

  if (error) throw error;
  return { bucket: BUCKET, key };
}
