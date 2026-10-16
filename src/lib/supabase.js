import { createClient } from '@supabase/supabase-js';

// Tolerate values pasted as a whole .env line (e.g. "VITE_SUPABASE_URL=https://...") or with stray spaces/newlines.
const clean = (value, name) => (value || '').trim().replace(new RegExp(`^${name}\\s*=\\s*`), '').trim();

const url = clean(import.meta.env.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL');
const publishableKey = clean(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'VITE_SUPABASE_PUBLISHABLE_KEY');

export const supabase = url && publishableKey
  ? createClient(url, publishableKey)
  : null;
