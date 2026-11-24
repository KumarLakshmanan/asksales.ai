import { Suspense } from "react";
import { CampaignEngagementView } from "@/components/outreach/reports/CampaignEngagementView";
export default function EngagementPage() {
  return (
    <Suspense fallback={<p className="p-6">Loading customer engagement…</p>}>
      <CampaignEngagementView />
    </Suspense>
  );
}
