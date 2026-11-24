import CampaignDetailPage from "@/components/performance-marketing/CampaignDetailPage";

export default async function ManagedCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignDetailPage source="managed" campaignId={id}/>;
}
