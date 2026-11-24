import { CampaignExportView } from "@/components/outreach/reports/CampaignExportView";
export default async function SavedExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CampaignExportView id={id} />;
}
