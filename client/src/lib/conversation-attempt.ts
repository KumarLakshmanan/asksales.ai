export interface ConversationAttempt { requestId: string; clientSessionKey: string; fingerprint: string; text: string; context?: unknown }
const memory = new Map<string, ConversationAttempt>();
const keyFor = (scope: string) => `conversation-attempt:${creatorSessionScope()}:${scope}`;
export function readConversationAttempt(scope: string): ConversationAttempt | null {
  try {
    const raw = sessionStorage.getItem(keyFor(scope));
    if (raw) {
      const attempt = JSON.parse(raw);
      if (attempt && typeof attempt.text === 'string' && typeof attempt.fingerprint === 'string'
        && typeof attempt.requestId === 'string' && /^[A-Za-z0-9:_-]{8,140}$/.test(attempt.requestId)
        && typeof attempt.clientSessionKey === 'string' && /^[A-Za-z0-9:_-]{8,140}$/.test(attempt.clientSessionKey)) return attempt;
    }
  } catch { /* Storage can be unavailable in embeds. */ }
  return memory.get(keyFor(scope)) || null;
}
/** Keep identity across uncertain HTTP failures. Deliberately edited input starts
 * a new request, while an unchanged Retry retrieves the original outcome. */
export function conversationAttempt(scope: string, text: string, context: unknown = null): ConversationAttempt {
  const fingerprint = JSON.stringify([text, context]);
  const prior = readConversationAttempt(scope);
  if (prior?.fingerprint === fingerprint) return prior;
  const requestId = crypto.randomUUID();
  const attempt = { requestId, clientSessionKey: prior?.clientSessionKey || requestId, fingerprint, text, context };
  memory.set(keyFor(scope), attempt);
  try { sessionStorage.setItem(keyFor(scope), JSON.stringify(attempt)); } catch { /* Retain in memory. */ }
  return attempt;
}
/** Preserve a first-message identity when the server resolves its conversation
 * before the response arrives. Never replace a newer attempt in that scope. */
export function bindConversationAttempt(from: string, to: string, requestId: string): void {
  const attempt = readConversationAttempt(from);
  if (attempt?.requestId !== requestId) return;
  const target = readConversationAttempt(to);
  if (target && target.requestId !== requestId) return;
  memory.set(keyFor(to), attempt);
  try { sessionStorage.setItem(keyFor(to), JSON.stringify(attempt)); } catch { /* Retain in memory. */ }
  finishConversationAttempt(from, requestId);
}
export function finishConversationAttempt(scope: string, requestId: string): void {
  if (readConversationAttempt(scope)?.requestId !== requestId) return;
  memory.delete(keyFor(scope));
  try { sessionStorage.removeItem(keyFor(scope)); } catch { /* Already removed in memory. */ }
}
import { creatorSessionScope } from './creator-session';
