"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ApprovalResumeRecoveryItem } from '../../../../shared/supportApprovalRecovery';

export function ApprovalResumeRecovery() {
  const [items, setItems] = useState<ApprovalResumeRecoveryItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(false);
    try {
      const rows = await api.get<ApprovalResumeRecoveryItem[]>('/api/support/ai/approval-recovery', { signal: controller.signal });
      if (!Array.isArray(rows)) throw new Error('Invalid approval recovery response');
      if (!controller.signal.aborted) setItems(rows);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);

  return <Card className="shadow-none">
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
      <CardTitle className="text-sm">Approval resume recovery</CardTitle>
      <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>Refresh approvals</Button>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-xs text-muted-foreground">Review blocked approvals and verify configuration and any earlier execution before continuing.</p>
      {loading && <p role="status" className="text-sm">Loading approval recovery…</p>}
      {error && <p role="alert" className="text-sm text-destructive">Approval recovery could not be loaded. Try refreshing approvals.{items ? ' The last loaded approvals are still shown.' : ''}</p>}
      {!loading && !error && items?.length === 0 && <p className="text-sm">No approvals are blocked before execution.</p>}
      {items?.map(item => <div key={item.id} className="space-y-2 rounded-lg border p-3">
        <p className="break-words text-sm font-medium">{item.toolName.replaceAll('_', ' ')} · Review #{item.id}</p>
        <p className="text-sm text-destructive">{item.message}</p>
        <p className="text-xs text-muted-foreground">{item.threadId ? `Conversation #${item.threadId} · ` : ''}Approval {item.status}; resume {item.resumeStatus}.</p>
      </div>)}
      {items?.length === 100 && <p className="text-xs text-muted-foreground">Showing the 100 most recent blocked approvals.</p>}
    </CardContent>
  </Card>;
}
