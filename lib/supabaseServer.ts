import { createClient } from '@supabase/supabase-js';

export function getSupabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !service) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  // Never import this into client bundles.
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}
