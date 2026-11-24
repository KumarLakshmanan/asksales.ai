import { redirect } from "next/navigation";

export default async function LegacyEditBusinessProfilePage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  redirect(`/dashboard/business-profiles/${encodeURIComponent(profileId)}`);
}
