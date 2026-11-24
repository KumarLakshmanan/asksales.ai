"use client";

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { readLibraryDraft } from '@/lib/libraryDraft';

/** Import an owned library record into the campaign composer, never launch it. */
export function useLibraryCampaignHandoff(kind: 'email' | 'sms', apply: (draft: { subject: string; body: string; sourceTemplateId?: number }) => void, enabled = true) {
  const params = useSearchParams();
  const { toast } = useToast();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const assetId = params.get('sourceAssetId');
  const templateId = params.get('sourceTemplateId');
  useEffect(() => {
    if (!enabled || (!assetId && !templateId)) return;
    const id = Number(assetId || templateId);
    if (!Number.isSafeInteger(id) || id <= 0 || (assetId && templateId)) {
      toast({ title: 'Invalid library reference', description: 'Choose a draft or template from the content library again.', variant: 'destructive' });
      return;
    }
    let active = true;
    void api.get<{ type: string; content: string; subject?: string; htmlContent?: string; isApproved?: boolean }>(`/api/content/${assetId ? 'assets' : 'templates'}/${id}`).then(record => {
      if (!active) return;
      if (record.type !== kind && record.type !== `${kind}_template`) throw new Error('This content belongs to a different channel.');
      if (templateId && record.isApproved === false) throw new Error('Review and approve this reusable template in the library before using it in a campaign.');
      const parsed = readLibraryDraft(record.content);
      applyRef.current({ subject: record.subject || parsed.subject, body: kind === 'email' ? record.htmlContent || parsed.html || parsed.body : parsed.body, ...(templateId ? { sourceTemplateId: id } : {}) });
      toast({ title: 'Content added to campaign', description: 'Choose recipients, review variables, and confirm before sending.' });
    }).catch(cause => {
      if (active) toast({ title: 'Unable to load selected content', description: cause instanceof Error ? cause.message : 'Return to the library and select the item again.', variant: 'destructive' });
    });
    return () => { active = false; };
  }, [kind, assetId, templateId, toast, enabled]);
}
