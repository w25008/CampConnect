// Remembers each contact's chat key in this browser ("trust on first use").
// The first key seen for a contact is stored automatically, so students can chat
// without comparing keys. If a different key shows up later, the app shows a
// notice. Comparing keys by hand is optional and is recorded separately.
// `storage` is localStorage in the app (anything with getItem/setItem works).

const verifiedName = (userId, contactId) => `campconnect:verified-key:${userId}:${contactId}`;
const seenName = (userId, contactId) => `campconnect:seen-key:${userId}:${contactId}`;

// Call when a conversation opens. Returns:
//   verified - the student compared this exact key by hand earlier
//   changed  - this browser remembers a different key for this contact
export function checkContactKey(storage, userId, contactId, fingerprint) {
  const verified = storage.getItem(verifiedName(userId, contactId));
  // Keys verified before this feature existed count as already seen.
  const seen = storage.getItem(seenName(userId, contactId)) || verified;
  if (!seen) storage.setItem(seenName(userId, contactId), fingerprint);
  return { verified: verified === fingerprint, changed: !!seen && seen !== fingerprint };
}

// The student dismissed the "key changed" notice: remember the new key.
export function acceptContactKey(storage, userId, contactId, fingerprint) {
  storage.setItem(seenName(userId, contactId), fingerprint);
}

// The student compared the key by hand and confirmed it.
export function verifyContactKey(storage, userId, contactId, fingerprint) {
  storage.setItem(verifiedName(userId, contactId), fingerprint);
  storage.setItem(seenName(userId, contactId), fingerprint);
}
