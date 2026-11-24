"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { supportApi } from '@/lib/support-api';
import { createGuardedRefresh } from '@/lib/guardedRefresh';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Turn = { request_id: string; status: string; cancel_requested?: boolean; error_code?: string };

/** A reloadable projection of server ownership. Acknowledging an interrupted
 * turn releases the queue without replaying an action. */
const ACTIVE_POLL_MS = 3000;

export function ConversationTurnStatus({ basePath, member = false, active = false, idlePollMs = ACTIVE_POLL_MS }: {
  basePath?: string;
  member?: boolean;
  /** The caller knows a turn is in flight (for example, a message was just sent). */
  active?: boolean;
  /** How often to read while nothing is queued or running. Live pages that
   * also receive socket events can afford a slow safety read. */
  idlePollMs?: number;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const client = member ? supportApi : api;
  const generation = useRef(0);
  const busy = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastReadAt = useRef(0);
  const guardRef = useRef<ReturnType<typeof createGuardedRefresh> | null>(null);
  const refresh = useCallback(async () => {
    if (!basePath) return;
    const started = generation.current;
    lastReadAt.current = Date.now();
    const response = await client.get<Turn[]>(`${basePath}/turns`);
    if (started !== generation.current) return;
    const list = Array.isArray(response) ? response : [];
    busy.current = list.some(turn => ['queued', 'running'].includes(turn.status));
    setTurns(list);
  }, [basePath, client]);
  useEffect(() => {
    setTurns([]); setError(''); setNote(''); setWorking(false);
    busy.current = false;
    // Ticks skip hidden tabs and never overlap a read that is still running.
    const guard = createGuardedRefresh(refresh);
    guardRef.current = guard;
    void guard.run();
    const timer = setInterval(() => {
      const inFlight = busy.current || activeRef.current;
      if (!inFlight && Date.now() - lastReadAt.current < idlePollMs) return;
      guard.poll();
    }, ACTIVE_POLL_MS);
    return () => { guard.stop(); generation.current++; clearInterval(timer); if (guardRef.current === guard) guardRef.current = null; };
  }, [refresh, idlePollMs]);
  // A newly sent message shows its Stop control without waiting for an idle tick.
  useEffect(() => { if (active) void guardRef.current?.run(); }, [active]);
  const pending = turns.filter(turn => ['queued', 'running'].includes(turn.status));
  const uncertain = turns.find(turn => turn.status === 'uncertain');
  if (!basePath || (!pending.length && !uncertain)) return null;
  const act = async (action: 'stop' | 'reconcile', turn: Turn) => {
    const started = generation.current;
    setWorking(true); setError('');
    try {
      await client.post(`${basePath}/${action}`, { requestId: turn.request_id, note });
      if (started === generation.current) { await refresh(); setNote(''); }
    }
    catch (cause) { if (started === generation.current) setError(cause instanceof Error ? cause.message : 'Unable to update this turn.'); }
    finally { if (started === generation.current) setWorking(false); }
  };
  return <aside aria-label="Conversation activity" className="shrink-0 space-y-2 border-b px-4 py-2 text-xs">
    {pending.map(turn => <div key={turn.request_id} className="flex items-center justify-between gap-2">
      <span>{turn.cancel_requested ? 'Stopping before the next action…' : turn.status === 'queued' ? 'Message queued' : 'Response in progress'}</span>
      <Button size="sm" variant="ghost" disabled={working || turn.cancel_requested} onClick={() => void act('stop', turn)}>{turn.status === 'queued' ? 'Cancel queued message' : 'Stop'}</Button>
    </div>)}
    {uncertain && <div className="space-y-2" role="status"><p>A previous turn was interrupted. Review the saved messages and action receipts before continuing.</p>
      <Input aria-label="Turn review note" placeholder="Describe the result you verified" maxLength={500} value={note} onChange={event => setNote(event.target.value)} />
      <Button size="sm" variant="outline" disabled={working || note.trim().length < 3} onClick={() => void act('reconcile', uncertain)}>Record review and allow next message</Button>
      <p className="text-muted-foreground">This records your review. It does not repeat the interrupted action.</p>
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </aside>;
}
