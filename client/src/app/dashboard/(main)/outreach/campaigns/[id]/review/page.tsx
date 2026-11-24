"use client";

import { useParams } from "next/navigation";
import CampaignDeliveryReview from "@/components/outreach/CampaignDeliveryReview";

export default function CampaignReviewPage() {
  const params = useParams<{ id: string }>();
  const campaignId = Number(params.id);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return <p role="alert" className="p-6">Invalid campaign.</p>;
  return <main className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6"><CampaignDeliveryReview campaignId={campaignId} /></main>;
}
