const pending = new Map<string, string>();
export function needsContentReceipt(endpoint: string): boolean {
  return endpoint === '/api/crm/contacts'
    || /^\/api\/content\/(?:templates|assets|studio\/(?:email|sms|social|social-message|ad-copy-content|blog-post|image|video(?:\/start)?))$/.test(endpoint);
}
export async function contentRequestKey(endpoint: string, body: string, identity: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${identity}\n${endpoint}\n${body}`));
  const fingerprint = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
  const storageKey = `asksales:request:${fingerprint}`;
  let key = pending.get(storageKey);
  try { key ||= sessionStorage.getItem(storageKey) || undefined; } catch { /* memory fallback */ }
  key ||= crypto.randomUUID();
  pending.set(storageKey, key);
  try { sessionStorage.setItem(storageKey, key); } catch { /* memory fallback */ }
  return { key, clear: () => {
    // A late replay must not erase a newer request for the same content.
    if (pending.get(storageKey) === key) pending.delete(storageKey);
    try { if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey); } catch { /* memory fallback */ }
  } };
}
