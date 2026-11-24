"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { creatorSessionScope } from '@/lib/creator-session';
import { useCreatorScope, creatorDraftScope } from '@/components/content-studio/CreatorScope';

/** Session-scoped recovery: never writes business drafts to permanent local storage. */
export function useCreatorPrompt(kind: string) {
  const scope = useCreatorScope();
  const recoveryScope = scope.threadId ? `:${creatorDraftScope(scope)}` : '';
  const key = `asksales:creator:${creatorSessionScope()}:${kind}${recoveryScope}:prompt`;
  const [prompt, setPrompt] = useState("");
  const [loadedKey, setLoadedKey] = useState('');
  const [proposal, setProposal] = useState<{ original: string; enhanced: string; applied: boolean } | null>(null);
  useEffect(() => {
    setProposal(null);
    try { setPrompt(sessionStorage.getItem(key) || ""); } catch { /* Storage may be disabled. */ }
    setLoadedKey(key);
  }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    try { sessionStorage.setItem(key, prompt); } catch { /* Editing still works without storage. */ }
  }, [key, loadedKey, prompt]);
  const proposeEnhancement = (enhanced: string) => {
    if (key !== `asksales:creator:${creatorSessionScope()}:${kind}${recoveryScope}:prompt`) return;
    setProposal({ original: prompt, enhanced, applied: false });
  };
  const enhancementReview = proposal && (
    <section className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm" aria-label="Compare prompt enhancement">
      <p className="font-medium">Review enhanced prompt</p>
      <details><summary className="cursor-pointer text-xs">Compare with original</summary><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{proposal.original}</p></details>
      <p className="whitespace-pre-wrap">{proposal.enhanced}</p>
      <div className="flex gap-2">
        <Button size="sm" type="button" disabled={proposal.applied} onClick={() => { setPrompt(proposal.enhanced); setProposal({ ...proposal, applied: true }); }}>Apply</Button>
        {proposal.applied && <Button size="sm" type="button" variant="outline" onClick={() => { setPrompt(proposal.original); setProposal(null); }}>Undo</Button>}
        <Button size="sm" type="button" variant="ghost" onClick={() => setProposal(null)}>Dismiss</Button>
      </div>
      <p className="text-xs text-muted-foreground">Changing the prompt does not regenerate your preview.</p>
    </section>
  );
  return { prompt, setPrompt, proposeEnhancement, enhancementReview };
}
