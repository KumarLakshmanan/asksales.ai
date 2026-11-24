import { creatorSessionScope } from './creator-session';

type CommentDraft = { key: string; text: string };
const storageKey = (credentialId: number) => `youtube-comment-intents:${creatorSessionScope()}:${credentialId}`;

export function loadYouTubeCommentDrafts(credentialId: number): Record<string, CommentDraft> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey(credentialId)) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, CommentDraft] => {
      const value = entry[1] as Partial<CommentDraft> | null;
      return Boolean(value && typeof value.text === 'string' && typeof value.key === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value.key));
    }));
  } catch { return {}; }
}

/** Persist the reviewed request before dispatch, retaining its key after uncertainty. */
export function retainYouTubeCommentDraft(credentialId: number, parentId: string, text: string) {
  const drafts = loadYouTubeCommentDrafts(credentialId);
  const previous = drafts[parentId];
  const draft = previous?.text === text ? previous : { text, key: crypto.randomUUID() };
  sessionStorage.setItem(storageKey(credentialId), JSON.stringify({ ...drafts, [parentId]: draft }));
  return { ...draft, storageKey: storageKey(credentialId) };
}

export function clearYouTubeCommentDraft(credentialId: number, parentId: string, confirmed: { key: string; storageKey: string }) {
  if (confirmed.storageKey !== storageKey(credentialId)) return;
  const drafts = loadYouTubeCommentDrafts(credentialId);
  if (drafts[parentId]?.key !== confirmed.key) return;
  delete drafts[parentId];
  sessionStorage.setItem(confirmed.storageKey, JSON.stringify(drafts));
}
