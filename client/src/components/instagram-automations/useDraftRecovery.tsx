'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selectedBusinessProfileId } from '@/lib/business-profile';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';

/** A tab-local recovery copy, scoped to business/account/editor and the saved revision. */
export function useDraftRecovery<T>({ accountId, editor, revision, value, dirty, isDraft, onRestore }: {
  accountId: string; editor: string; revision: number; value: T; dirty: boolean;
  isDraft: (value: unknown) => value is T; onRestore: (value: T) => void;
}) {
  const key = `instagram-draft:${selectedBusinessProfileId() || 'none'}:${accountId}:${editor}`;
  const [recovered, setRecovered] = useState<T | null>(null), [available, setAvailable] = useState(true), [stale, setStale] = useState(false);
  const state = useRef({ value, dirty, revision, pending: true, cleared: false });
  useLayoutEffect(() => { state.current = { ...state.current, value, dirty, revision }; }, [value, dirty, revision]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw && raw.length <= 120000) {
        const saved = JSON.parse(raw);
        if (saved.revision === revision && Date.now() - saved.at < 7 * 86400000 && isDraft(saved.value)) { setRecovered(saved.value); return; }
        sessionStorage.removeItem(key); setStale(true);
      }
    } catch { setAvailable(false); }
    state.current.pending = false;
    // Editors remount when account, kind or saved rule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const write = () => {
      const current = state.current;
      if (!current.dirty || current.pending || current.cleared) return;
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), revision: current.revision, value: current.value })); }
      catch { setAvailable(false); }
    };
    const timer = window.setTimeout(write, 200);
    return () => { window.clearTimeout(timer); };
  }, [value, dirty, revision, key]);
  useEffect(() => {
    const flush = () => {
      const current = state.current;
      if (!current.dirty || current.pending || current.cleared) return;
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), revision: current.revision, value: current.value })); } catch { /* The visible save controls remain usable when storage is unavailable. */ }
    };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [key]);
  const clear = () => {
    state.current.cleared = true; state.current.pending = false;
    setRecovered(null);
    try { sessionStorage.removeItem(key); } catch { setAvailable(false); }
  };
  const restore = () => {
    if (!recovered) return;
    onRestore(recovered); setRecovered(null); state.current.pending = false; state.current.cleared = false;
  };
  const discard = () => { clear(); state.current.cleared = false; };
  // A subsequent edit after a successful save may create another recovery copy.
  useEffect(() => { if (dirty) state.current.cleared = false; }, [value, dirty]);
  const banner = recovered ? <Callout tone="info" announce actions={<><Button type="button" size="sm" onClick={restore}>Restore unfinished draft</Button><Button type="button" size="sm" variant="outline" onClick={discard}>Discard recovered draft</Button></>}>An unfinished draft for this account is available in this tab.</Callout>
    : !available ? <p role="status" className="text-xs text-muted-foreground">Browser draft recovery is unavailable. Save your draft before leaving.</p>
      : stale ? <p role="status" className="text-xs text-muted-foreground">An older recovery copy was discarded because the saved setup changed or the copy expired.</p> : null;
  return { banner, clear };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stringList = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(item => typeof item === 'string');
const message = (value: unknown): boolean => object(value) && ['text', 'quick_replies', 'buttons', 'carousel'].includes(String(value.format)) && typeof value.text === 'string'
  && Array.isArray(value.buttons) && value.buttons.every(item => object(item) && typeof item.title === 'string' && typeof item.url === 'string')
  && Array.isArray(value.quickReplies) && value.quickReplies.every(item => object(item) && typeof item.title === 'string' && typeof item.payload === 'string')
  && Array.isArray(value.cards) && value.cards.every(item => object(item) && typeof item.title === 'string' && typeof item.subtitle === 'string' && typeof item.imageUrl === 'string' && Array.isArray(item.buttons) && item.buttons.every(button => object(button) && typeof button.title === 'string' && typeof button.url === 'string'));
export function isRuleDraft(value: unknown): value is import('@/lib/instagram-automations').InstagramRuleDefinition {
  if (!object(value) || !object(value.trigger) || !object(value.filters) || !object(value.followGate)) return false;
  return typeof value.name === 'string' && ['comment_dm', 'comment_reply'].includes(String(value.kind)) && stringList(value.trigger.keywords) && stringList(value.trigger.negativeKeywords) && stringList(value.trigger.mediaIds)
    && ['all', 'specific', 'reels'].includes(String(value.trigger.scope)) && ['exact', 'contains'].includes(String(value.trigger.matchMode)) && message(value.message)
    && stringList(value.publicReplies) && stringList(value.tags) && typeof value.followGate.enabled === 'boolean' && typeof value.followGate.prompt === 'string' && typeof value.followGate.retryMessage === 'string'
    && ['any', 'followers', 'non_followers'].includes(String(value.filters.followers)) && typeof value.filters.skipPreviouslyMessaged === 'boolean' && typeof value.filters.maxPerDay === 'number' && typeof value.filters.cooldownMinutes === 'number';
}
export function isProfileDraft(value: unknown): value is import('@/lib/instagram-automations').InstagramProfileConfig {
  return object(value) && Array.isArray(value.locales) && value.locales.length <= 50 && value.locales.every(group => object(group) && typeof group.locale === 'string'
    && Array.isArray(group.questions) && group.questions.every(question => object(question) && typeof question.id === 'string' && typeof question.question === 'string')
    && Array.isArray(group.items) && group.items.every(item => object(item) && typeof item.id === 'string' && typeof item.title === 'string' && ['action', 'link'].includes(String(item.type)) && typeof item.url === 'string' && typeof item.payload === 'string' && message(item.response)));
}
