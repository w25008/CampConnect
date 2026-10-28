import { createClient } from '@supabase/supabase-js';

// Tolerate values pasted as a whole .env line (e.g. "VITE_SUPABASE_URL=https://...") or with stray spaces/newlines.
const clean = (value, name) => (value || '').trim().replace(new RegExp(`^${name}\\s*=\\s*`), '').trim();

const url = clean(import.meta.env.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL');
const publishableKey = clean(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'VITE_SUPABASE_PUBLISHABLE_KEY');

// A password-reset email link brings the user back with "type=recovery" in the URL.
// Read it before the client consumes the URL, so the app can ask for a new password.
export const openedFromRecoveryLink = typeof window !== 'undefined'
  && /(^|[#&?])type=recovery(&|$)/.test(`${window.location.hash}&${window.location.search}`);

export const supabase = url && publishableKey
  ? createClient(url, publishableKey)
  : null;
