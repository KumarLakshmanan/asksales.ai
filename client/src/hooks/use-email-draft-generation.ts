"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { creatorSessionScope } from '@/lib/creator-session';
import { EMAIL_GENERATION_WAIT_MS, emailGenerationErrorMessage, parseGeneratedEmailResponse } from '@/lib/emailGenerationRecovery';
import type { EmailDraft } from '@/lib/emailTemplateSections';
import { useToast } from '@/hooks/use-toast';

interface Attempt {
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  draftKey: string;
}

/** Campaign generation changes the draft only after a validated, current response. */
export function useEmailDraftGeneration({ open, scopeKey, draftKey }: { open: boolean; scopeKey: string; draftKey: string }) {
  const { toast } = useToast();
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string>();
  const attemptRef = useRef<Attempt | null>(null);
  const scope = `${creatorSessionScope()}:${scopeKey}`;
  const scopeRef = useRef({ open, scope, draftKey });

  const abortAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt) {
      clearTimeout(attempt.timeout);
      attempt.controller.abort();
    }
  }, []);
  const cancelGeneration = useCallback((notice?: string) => {
    abortAttempt();
    setIsGenerating(false);
    if (notice) setGenerationError(notice);
  }, [abortAttempt]);

  useEffect(() => {
    scopeRef.current.open = open;
    scopeRef.current.scope = scope;
    cancelGeneration();
    setGenerationError(undefined);
    return abortAttempt;
  }, [open, scope, abortAttempt, cancelGeneration]);

  useEffect(() => {
    scopeRef.current.draftKey = draftKey;
    if (attemptRef.current && attemptRef.current.draftKey !== draftKey) {
      cancelGeneration('Your draft changed while generating. The AI result will not replace your edits.');
    }
  }, [draftKey, cancelGeneration]);

  const generateEmailDraft = async (payload: Record<string, unknown>, onGenerated: (draft: EmailDraft) => void) => {
    if (!open || attemptRef.current) return;
    const session = creatorSessionScope();
    const attempt: Attempt = { controller: new AbortController(), draftKey };
    attemptRef.current = attempt;
    const isCurrent = () => attemptRef.current === attempt && !attempt.controller.signal.aborted
      && scopeRef.current.open && scopeRef.current.scope === scope && scopeRef.current.draftKey === attempt.draftKey
      && creatorSessionScope() === session;
    attempt.timeout = setTimeout(() => {
      if (isCurrent()) cancelGeneration('Email generation is taking longer than expected. Your draft has been kept.');
    }, EMAIL_GENERATION_WAIT_MS);
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      const response = await api.post<unknown>('/api/content/studio/email', { ...payload, persist: false }, { signal: attempt.controller.signal });
      if (!isCurrent()) return;
      const draft = parseGeneratedEmailResponse(response);
      // End the attempt before applying the draft; our own update is not a user edit.
      attemptRef.current = null;
      setIsGenerating(false);
      onGenerated(draft);
    } catch (error) {
      if (!isCurrent()) return;
      const description = emailGenerationErrorMessage(error, 'compose');
      setGenerationError(description);
      toast({ title: 'Generation Failed', description, variant: 'destructive' });
    } finally {
      clearTimeout(attempt.timeout);
      if (isCurrent()) {
        attemptRef.current = null;
        setIsGenerating(false);
      }
    }
  };

  return { isGenerating, generationError, generateEmailDraft, cancelGeneration };
}
