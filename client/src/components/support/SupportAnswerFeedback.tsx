"use client";

import { useEffect, useRef, useState } from "react";
import { Flag, ThumbsUp } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface SupportStaffFeedback {
  rating: "helpful" | "needs_review";
  reason?: "incorrect" | "missing_information" | "outdated" | "other";
  notes?: string;
  status: "open" | "reviewed";
  updatedAt?: string;
}

export function SupportAnswerFeedback({ messageId, feedback, onSaved }: { messageId: number; feedback?: SupportStaffFeedback | null; onSaved?: () => void }) {
  const [saved, setSaved] = useState(feedback);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<NonNullable<SupportStaffFeedback["reason"]>>(feedback?.reason || "missing_information");
  const [notes, setNotes] = useState(feedback?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSaved(feedback); }, [feedback]);

  const save = async (rating: SupportStaffFeedback["rating"]) => {
    if (busy) return;
    setBusy(true); setError("");
    const value: SupportStaffFeedback = rating === "helpful"
      ? { rating, status: "reviewed" }
      : { rating, reason, notes: notes.trim(), status: "open" };
    try {
      await api.put(`/api/support/ai/messages/${messageId}/feedback`, value);
      if (!mounted.current) return;
      setSaved(value); setOpen(false); onSaved?.();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Feedback could not be saved. Try again.");
    } finally { if (mounted.current) setBusy(false); }
  };

  return <>
    <div className="flex flex-wrap items-center gap-1" aria-label="Answer feedback">
      <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1.5 px-2 text-xs text-muted-foreground" disabled={busy} aria-pressed={saved?.rating === "helpful"} onClick={() => void save("helpful")}><ThumbsUp className="h-3.5 w-3.5" />{saved?.rating === "helpful" ? "Marked helpful" : "Helpful"}</Button>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1.5 px-2 text-xs text-muted-foreground" disabled={busy} onClick={() => { setError(""); setOpen(true); }}><Flag className="h-3.5 w-3.5" />{saved?.rating === "needs_review" ? saved.status === "reviewed" ? "Review recorded" : "Flagged for review" : "Flag answer"}</Button>
      {error && !open && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
    </div>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Flag this answer</DialogTitle><DialogDescription>Add it to Answer quality so your team can check the response and improve the supporting knowledge.</DialogDescription></DialogHeader>
        <label className="space-y-2 text-sm font-medium"><span>Reason</span><select aria-label="Feedback reason" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={reason} disabled={busy} onChange={(event) => setReason(event.target.value as typeof reason)}><option value="missing_information">Missing information</option><option value="incorrect">Incorrect answer</option><option value="outdated">Outdated information</option><option value="other">Other</option></select></label>
        <label className="space-y-2 text-sm font-medium"><span>What should be checked? <span className="font-normal text-muted-foreground">(optional)</span></span><Textarea aria-label="Feedback notes" value={notes} disabled={busy} maxLength={2000} onChange={(event) => setNotes(event.target.value)} placeholder="Describe the issue and the correct information, if known." /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy} onClick={() => void save("needs_review")}>{busy ? "Saving…" : "Save flag"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
