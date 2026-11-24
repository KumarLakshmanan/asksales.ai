import CampaignDetailPage from "@/components/performance-marketing/CampaignDetailPage";

export default async function ProviderCampaignPage({ params }: { params: Promise<{ platform: "meta" | "google"; campaignId: string }> }) {
  const { platform, campaignId } = await params;
  return <CampaignDetailPage source="provider" platform={platform} campaignId={campaignId}/>;
}
