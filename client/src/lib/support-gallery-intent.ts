import { creatorSessionScope } from './creator-session';

const pending = new Map<string, string>();
const storageKey = (scope: string) => `support-gallery-creation:${scope}`;

export function galleryCreationScope() { return creatorSessionScope(); }

export function pendingGalleryCreation(scope: string): string | undefined {
  let key = pending.get(scope);
  try { key ||= sessionStorage.getItem(storageKey(scope)) || undefined; } catch { /* Keep retry identity in memory. */ }
  if (key) pending.set(scope, key);
  return key;
}

export function startGalleryCreation(scope: string): string {
  const key = pendingGalleryCreation(scope) || crypto.randomUUID();
  pending.set(scope, key);
  try { sessionStorage.setItem(storageKey(scope), key); } catch { /* Keep retry identity in memory. */ }
  return key;
}

export function finishGalleryCreation(scope: string, key: string) {
  if (pendingGalleryCreation(scope) !== key) return;
  pending.delete(scope);
  try { if (sessionStorage.getItem(storageKey(scope)) === key) sessionStorage.removeItem(storageKey(scope)); } catch { /* Memory state is already cleared. */ }
}
