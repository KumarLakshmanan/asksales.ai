import api from "@/lib/api";
import type { CreativeBrief } from "../../../shared/adCreativeIntelligence";

export async function prepareCreativeDraftReview(brief: CreativeBrief) {
  if (brief.status !== "ready" || !brief.selected_concept_id)
    throw new Error("Choose a ready concept in Paid Ads first.");
  const review = await api.post<{ threadId: number; widgetId: number }>(
    `/api/campaigns/creative-intelligence/briefs/${brief.id}/draft-review`,
    { revision: brief.revision, conceptId: brief.selected_concept_id },
  );
  if (!Number.isSafeInteger(review.threadId) || review.threadId <= 0)
    throw new Error("The draft review could not be opened. Try again.");
  return `/dashboard/conversations/${review.threadId}`;
}
