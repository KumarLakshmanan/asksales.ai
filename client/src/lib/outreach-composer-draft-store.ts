"use client";

import type { OutreachComposerDraft } from '@/components/outreach/create/OutreachCreationPage';

/**
 * Keeps the unsent standalone outreach draft while the user visits another
 * dashboard page (for example Follow-up settings) and comes back.
 *
 * The draft lives in memory only, per signed-in user and business, so message
 * wording never reaches browser storage. A reload or sign-out discards it.
 */
export type StoredOutreachComposerDraft = OutreachComposerDraft & { outreachName?: string };

const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
const drafts = new Map<string, { draft: StoredOutreachComposerDraft; savedAt: number; handoff: string }>();
/** URL parameters that hand recipients to the composer. A different handoff starts a new draft. */
const HANDOFF_PARAMS = ['channel', 'leadIds', 'leadId', 'contactId', 'threadId'];
type Params = Pick<URLSearchParams, 'get' | 'has'>;

/** Identifies the page the draft was started from, so Back to the same URL restores it. */
export function outreachDraftHandoffKey(params: Params) {
  return HANDOFF_PARAMS.map(name => `${name}=${name === 'channel' ? params.get(name) || 'email' : params.get(name) ?? ''}`).join('&');
}

function identifiedScope(scope: string) {
  return Boolean(scope) && !scope.startsWith('anonymous:') && !scope.endsWith(':unselected');
}

function hasContent(draft: StoredOutreachComposerDraft) {
  return Boolean(draft.body?.trim() || draft.subject?.trim() || draft.outreachName?.trim() || draft.leadIds?.length
    || draft.attachments?.length || draft.templateId || draft.schedule
    || Object.values(draft.followUps || {}).some(value => value?.enabled || value?.steps?.length));
}

export function saveOutreachComposerDraft(scope: string, draft: StoredOutreachComposerDraft, handoff: string) {
  if (!identifiedScope(scope)) return;
  if (!hasContent(draft)) { drafts.delete(scope); return; }
  // Local blob previews are revoked when the composer unmounts; never restore them.
  const { mediaPreview: _preview, ...templateValues } = draft.templateValues || {};
  drafts.set(scope, { draft: { ...draft, templateValues }, savedAt: Date.now(), handoff });
}

/** Returns the kept draft when the user comes back to the same composer URL. */
export function readOutreachComposerDraft(scope: string, params: Params): StoredOutreachComposerDraft | undefined {
  if (!identifiedScope(scope)) return undefined;
  const stored = drafts.get(scope);
  if (!stored) return undefined;
  if (Date.now() - stored.savedAt > DRAFT_TTL_MS) { drafts.delete(scope); return undefined; }
  // New message text in the URL is a fresh handoff; it replaces the kept draft.
  if (params.has('message')) return undefined;
  return stored.handoff === outreachDraftHandoffKey(params) ? stored.draft : undefined;
}

export function clearOutreachComposerDraft(scope: string) {
  drafts.delete(scope);
}

export function resetOutreachComposerDraftsForTests() {
  drafts.clear();
}
