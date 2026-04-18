import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // surface this loudly — without these, nothing works
  console.error(
    '[living] missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
    'set both in Vercel → Project → Settings → Environment Variables.'
  );
}

export const supabase = createClient(url ?? 'http://missing', anon ?? 'missing', {
  realtime: { params: { eventsPerSecond: 10 } },
  auth: { persistSession: false },
});

// storage helpers
export const BUCKET = 'fragments';
export function publicUrl(path) {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
