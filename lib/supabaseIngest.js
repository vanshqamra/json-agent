import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

let supabaseClient = null;

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return null;
  }
  if (!supabaseClient) {
    try {
      supabaseClient = createClient(url, serviceKey, { auth: { persistSession: false } });
    } catch (error) {
      console.warn('[ingest] failed to create Supabase admin client:', error);
      supabaseClient = null;
      return null;
    }
  }
  return supabaseClient;
}

function shouldUploadToSupabase() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.INGEST_SUPABASE_UPLOAD !== 'false',
  );
}

export async function uploadPartToSupabase({ localPath, storageKey, metadata }) {
  if (!shouldUploadToSupabase()) {
    return null;
  }
  const client = getSupabaseClient();
  if (!client) return null;

  const bucket = process.env.INGEST_SUPABASE_BUCKET || 'ingest';
  const fileBuffer = await fs.readFile(localPath);
  const uploadResult = await client.storage
    .from(bucket)
    .upload(storageKey, fileBuffer, { contentType: 'application/json', upsert: true });
  if (uploadResult.error) {
    const error = new Error(`Supabase upload failed: ${uploadResult.error.message}`);
    error.status = uploadResult.error.statusCode || 500;
    error.details = {
      bucket,
      key: storageKey,
      message: uploadResult.error.message,
    };
    throw error;
  }

  const shouldPersistRow = String(process.env.SUPABASE_TABLE_ENABLED || '').toLowerCase() === 'true';
  if (shouldPersistRow) {
    const payload = {
      doc_id: metadata.docId,
      window_start: metadata.window.start,
      window_end: metadata.window.end,
      path: storageKey,
      size_bytes: metadata.sizeBytes,
      sha256: metadata.sha256,
      created_at: metadata.createdAt,
    };
    const insertResult = await client.from('ingest_parts').insert(payload);
    if (insertResult.error) {
      const error = new Error(`Supabase insert failed: ${insertResult.error.message}`);
      error.status = insertResult.error.code || 500;
      error.details = {
        table: 'ingest_parts',
        message: insertResult.error.message,
      };
      throw error;
    }
  }

  return {
    bucket,
    key: storageKey,
  };
}
