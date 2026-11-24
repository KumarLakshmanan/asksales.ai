"use client";
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Item = { id: string | number; conversation_id: number; status: string; effect_type?: string; channel?: string };
type Recovery = { replies: Item[]; effects: Item[]; turns: Item[] };
export function ConversationRecovery() {
  const [data, setData] = useState<Recovery>({ replies: [], effects: [], turns: [] });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.get<Recovery>('/api/support/ai/conversation-recovery')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load recovery items.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const items = [...(data.effects || []).map(item => ({ ...item, kind: 'effect' })),
    ...(data.replies || []).map(item => ({ ...item, kind: 'reply' })), ...(data.turns || []).map(item => ({ ...item, kind: 'turn' }))];
  const resolve = async (item: Item & { kind: string }, outcome: string) => {
    setWorking(true); setError('');
    try {
      await api.post(`/api/support/ai/conversation-recovery/${item.kind}/${item.id}`, { outcome, note: notes[`${item.kind}:${item.id}`] });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to reconcile this item.'); }
    finally { setWorking(false); }
  };
  return <Card className="shadow-none"><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-sm">Conversation and saved reply recovery</CardTitle><Button size="sm" variant="outline" onClick={() => void load()} disabled={working}>Refresh recovery</Button></CardHeader>
    <CardContent className="space-y-3"><p className="text-xs text-muted-foreground">Verify effects first, then resume saved replies. Record a turn review only after its delivery and action receipts have been checked.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!items.length && !error && <p className="text-sm">No interrupted conversations require recovery.</p>}
      {items.map(item => { const key = `${item.kind}:${item.id}`; return <div className="space-y-2 rounded-lg border p-3" key={key}>
        <p className="text-sm font-medium">{item.kind === 'reply' ? 'Saved widget reply' : item.kind === 'effect' ? (item.effect_type || 'Business effect').replaceAll('_', ' ') : 'Customer turn'} · conversation #{item.conversation_id}</p>
        <p className="text-xs text-muted-foreground">{item.status.replaceAll('_', ' ')}{item.channel ? ` · ${item.channel}` : ''}</p>
        <Input aria-label={`Verification note for ${key}`} maxLength={500} placeholder="How did you verify the outcome?" value={notes[key] || ''} onChange={event => setNotes(current => ({ ...current, [key]: event.target.value }))} />
        <div className="flex flex-wrap gap-2">{(item.kind === 'effect' ? [['succeeded','Confirm effect completed'], ['not_executed','Confirm no effect; allow retry']]
          : item.kind === 'reply' ? [['resume','Resume saved reply'], ['discard','Discard draft; handle reply manually']] : [['reviewed','Record review; allow next turn']]).map(([outcome,label]) => <Button key={outcome} size="sm" variant="outline" disabled={working || (notes[key] || '').trim().length < 3 || item.status === 'committing' || item.status === 'retry_ready'} onClick={() => void resolve(item, outcome)}>{label}</Button>)}</div>
      </div>; })}
    </CardContent></Card>;
}
