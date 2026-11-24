"use client";

import { Button } from "@/components/ui/button";
import type { SetupDraftHandle } from "./useSetupDraft";

export function SetupDraftStatus<T>({ draft }: { draft: SetupDraftHandle<T> }) {
  const failed = draft.status === "error" || draft.status === "conflict";
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2 text-xs text-muted-foreground" role={failed ? "alert" : "status"} aria-live="polite">
      {failed ? <div className="flex flex-wrap items-center gap-2"><span>{draft.error}</span>
        {draft.conflictKind === "source" ? <Button size="sm" variant="outline" onClick={() => {
          if (window.confirm("Discard the older unfinished draft and continue with the latest saved details?")) void draft.discard();
        }}>Use latest saved details</Button> : draft.status === "conflict" ? <Button size="sm" variant="outline" onClick={() => {
          if (window.confirm("Replace this tab’s unfinished edits with the latest saved draft?")) void draft.reload();
        }}>Reload saved draft</Button> : <Button size="sm" variant="outline" onClick={() => void draft.retry()}>Retry saving draft</Button>}
      </div> : draft.status === "loading" ? "Loading your saved draft…" : draft.status === "saving" ? "Saving draft…" : draft.savedAt ? `Draft saved to your account at ${new Date(draft.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. You can continue on another device.` : "Your unfinished changes will be saved automatically."}
    </div>
  );
}
