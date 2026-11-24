export const BUSINESS_PROFILE_HEADER = 'X-Business-Profile-Id';
const CHANGE_EVENT = 'business-profile-changed';

export function businessProfileAccountId(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const id = user?.id ?? user?.user?.id;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}
function selectionKey(): string | null {
  const id = businessProfileAccountId();
  return id ? `active-business-profile:${id}` : null;
}
export function selectedBusinessProfileId(): number | null {
  const key = selectionKey();
  if (!key) return null;
  const id = Number(sessionStorage.getItem(key));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export function selectBusinessProfile(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid business profile');
  const key = selectionKey();
  if (!key) throw new Error('Sign in to select a business profile');
  if (selectedBusinessProfileId() !== id) {
    // Legacy handoffs have no owner in their key. Never carry them into a
    // different business; scoped drafts are retained under their own keys.
    for (const name of ['outreach_selected_leads', 'outreach_thread_id', 'outreach_generated_template_id', 'outreach_template_type']) {
      sessionStorage.removeItem(name);
    }
  }
  sessionStorage.setItem(key, String(id));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function clearBusinessProfileSelection(): void {
  const key = selectionKey();
  if (!key) return;
  sessionStorage.removeItem(key);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function subscribeBusinessProfile(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === 'user' || event.key === selectionKey()) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}
export function businessProfileHeaders(): Record<string, string> {
  const id = selectedBusinessProfileId();
  return id ? { [BUSINESS_PROFILE_HEADER]: String(id) } : {};
}
/** A new document tears down page state, pending queries and realtime clients
 * together. Other tabs keep their independently selected business. */
export function openBusinessDashboard(): void { window.location.assign('/dashboard/home'); }
