'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AssistantDraft } from '@/lib/outreach-assistants';
import { Button } from '@/components/ui/button';
import { RECOVERY_TTL, recoverableAssistantDraft, restoreAssistantDraft } from './assistantEditorUtils';

export function useAssistantDraftRecovery({ scope, assistantId, version, draft, saved, dirty, onRestore }: {
  scope: readonly unknown[]; assistantId: string; version: number; draft: AssistantDraft; saved: AssistantDraft; dirty: boolean; onRestore: (draft: AssistantDraft) => void;
}) {
  const key = `assistant-draft:${String(scope[1] ?? 'anonymous')}:${String(scope[2])}:${assistantId}`;
  const [pending, setPending] = useState<AssistantDraft | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const state = useRef({ draft, version, dirty, blocked: true });
  useLayoutEffect(() => { Object.assign(state.current, { draft, version, dirty }); }, [draft, version, dirty]);
  useEffect(() => {
    setPending(null); state.current.blocked = false;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const record = raw.length < 100000 ? JSON.parse(raw) : null;
      const recovered = record?.version === version && Number.isFinite(record?.at) && record.at <= Date.now() && Date.now() - record.at < RECOVERY_TTL ? restoreAssistantDraft(saved, record.value) : null;
      if (recovered) { setPending(recovered); state.current.blocked = true; }
      else sessionStorage.removeItem(key);
    } catch { setUnavailable(true); }
  }, [key, version, saved]);
  const flush = () => {
    const current = state.current;
    if (!current.dirty || current.blocked) return;
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), version: current.version, value: recoverableAssistantDraft(current.draft) })); }
    catch { setUnavailable(true); }
  };
  const latestFlush = useRef(flush); useLayoutEffect(() => { latestFlush.current = flush; });
  useEffect(() => { const timer = window.setTimeout(flush, 300); return () => window.clearTimeout(timer); }, [draft, dirty, key]);
  useEffect(() => {
    const handle = () => latestFlush.current();
    window.addEventListener('pagehide', handle);
    window.addEventListener('business-profile-changed', handle);
    return () => { window.removeEventListener('pagehide', handle); window.removeEventListener('business-profile-changed', handle); handle(); };
  }, [key]);
  const clear = () => { state.current.blocked = true; setPending(null); try { sessionStorage.removeItem(key); } catch { setUnavailable(true); } };
  // A new edit after save/discard can create a new recovery copy.
  useEffect(() => { if (dirty && !pending) state.current.blocked = false; }, [draft, dirty, pending]);
  const banner = pending ? <div role="status" className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><p className="text-sm font-medium">An unfinished configuration is available in this tab.</p><p className="text-xs leading-5 text-muted-foreground">Recover account, model and resource selections. Names, descriptions, instructions, examples, policy text and customer-facing messages are not stored in browser recovery.</p><div className="flex flex-wrap gap-2"><Button type="button" onClick={() => { onRestore(pending); setPending(null); state.current.blocked = false; }}>Restore configuration</Button><Button type="button" variant="outline" onClick={clear}>Discard recovery copy</Button></div></div> : unavailable ? <p role="status" className="text-sm text-muted-foreground">Browser recovery is unavailable. Save your draft before leaving.</p> : null;
  return { clear, banner };
}
