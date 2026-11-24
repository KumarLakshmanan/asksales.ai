export const NOTIFICATIONS_CHANGED = 'notifications:changed';

/** Reconcile server state in this document and other tabs, including lost responses. */
export function announceNotificationChange(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
  try {
    localStorage.setItem(NOTIFICATIONS_CHANGED, `${Date.now()}:${Math.random()}`);
  } catch { /* Focus and reconnect still reconcile when storage is unavailable. */ }
}
