import { getSupabaseServer } from './supabaseServer';

const TABLE = 'ingest_parts'; // see SQL below

export async function saveIngestParts({ docId, source, window, parts }) {
  const supabase = getSupabaseServer();

  // write in small chunks to avoid 413 / body limits
  const rows = parts.map((p, i) => ({
    doc_id: docId,
    window_start: window.start,
    window_end: window.end,
    part_index: i,
    source_filename: source.filename,
    payload: p,                 // JSONB column
  }));

  // upsert in batches of 100
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { error } = await supabase.from(TABLE).upsert(slice);
    if (error) throw error;
  }
}

export async function listIngestParts(docId) {
  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('doc_id', docId)
    .order('window_start')
    .order('part_index');
  if (error) throw error;
  return data;
}
