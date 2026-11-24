"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { CreativeBrief } from "../../../../shared/adCreativeIntelligence";
import { prepareCreativeDraftReview } from "@/lib/creative-draft-review";

export function CreativeBriefHandoff({
  disabled,
}: {
  disabled?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("creativeBriefId");
  const [brief, setBrief] = useState<CreativeBrief | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    setBrief(null);
    setError("");
    setBusy(false);
    if (!/^[1-9]\d*$/.test(id)) {
      setError("Invalid creative brief. Return to Paid Ads recommendations.");
      return;
    }
    let active = true;
    api
      .get<CreativeBrief>(`/api/campaigns/creative-intelligence/briefs/${id}`)
      .then((value) => {
        if (value.status !== "ready" || !value.selected_concept_id)
          throw new Error("Choose a ready concept in Paid Ads first.");
        if (active) setBrief(value);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load the brief.",
          );
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (!id) return null;
  return (
    <section
      className="mx-auto mb-3 w-full max-w-4xl rounded-lg border bg-primary/5 p-3"
      aria-label="Creative brief handoff"
    >
      <p className="text-sm font-medium">
        Create a draft from your reviewed concept
      </p>
      <p className="text-xs text-muted-foreground">
        Open the saved generation fields from your selected concept. Confirm
        them before generating draft assets.
      </p>
      {error && <p role="alert">{error}</p>}
      {(!error || brief) && (
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={!brief || disabled || busy}
          onClick={async () => {
            if (!brief) return;
            setBusy(true);
            setError("");
            try { router.push(await prepareCreativeDraftReview(brief)); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to open the draft review."); }
            finally { setBusy(false); }
          }}
        >
          {busy
            ? "Opening review…"
            : brief
              ? "Open ad-generation review"
              : "Loading brief…"}
        </Button>
      )}
    </section>
  );
}
