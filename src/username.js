// Every username (@handle) is the school email ID, e.g. w25009@osfl.ac.jp -> w25009.
// The database applies the same rule (public.handle_from_email in
// supabase/migrations/0018_username_from_email.sql); this copy is for showing a preview.
export function handleFromEmail(email) {
  let handle = (email || '').trim().toLowerCase().split('@')[0].replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z]/.test(handle)) handle = `u_${handle}`;
  handle = handle.slice(0, 34);
  return handle.length < 3 ? handle.padEnd(3, '_') : handle;
}
