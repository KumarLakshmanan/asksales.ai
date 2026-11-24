import type { InstagramAutomationReadiness } from '../../../shared/instagramAutomations';

export * from '../../../shared/instagramAutomations';
export * from '../../../shared/instagramAutomationTools';
export const INSTAGRAM_AUTOMATIONS_PATH = '/dashboard/integrations/instagram/automations';
export const instagramAutomationsApi = (accountId: string) =>
  `/api/instagram/automations/${encodeURIComponent(accountId)}`;

export function instagramAccountAuthorization(readiness: InstagramAutomationReadiness): boolean | null {
  if (typeof readiness.authorized === 'boolean') return readiness.authorized;
  const check = readiness.checks?.find(value => value.id === 'connection');
  if (check) return check.ready;
  // Older servers can prove readiness, but a rollout or permission blocker
  // alone cannot prove that the account is disconnected.
  return readiness.messages || readiness.comments || readiness.profile ? true : null;
}
export function instagramCardConnection(readiness: InstagramAutomationReadiness, kind: string) {
  const authorized = instagramAccountAuthorization(readiness);
  const ready = readiness.enabled && (kind === 'icebreakers' || kind === 'menu' ? readiness.profile : kind === 'comment_reply' ? readiness.comments : readiness.messages && readiness.comments);
  if (authorized === false) return { ready: false, label: 'Reconnect Instagram', detail: 'Account authorization needs attention.' };
  if (ready) return { ready: true, label: 'Connection ready', detail: 'Required access is available.' };
  const label = authorized ? 'Account connected' : 'Connection status unavailable';
  const ids = kind === 'icebreakers' || kind === 'menu' ? ['manage_messages'] : kind === 'comment_reply' ? ['manage_comments'] : ['manage_messages', 'manage_comments'];
  const pending = readiness.checks?.find(check => !check.ready && check.id !== 'connection' &&
    (['events', 'rollout', 'verification'].includes(check.id) || check.id.includes('basic') || check.id.startsWith('pages_') || ids.some(id => check.id.includes(id))));
  const detail = pending ? `${pending.title}: ${pending.action === 'reconnect' ? 'review connection' : 'administrator setup needed'}.`
    : !readiness.enabled ? 'Live automation access awaits administrator setup.' : 'Required automation access needs attention.';
  return { ready: false, label, detail };
}
