import { BrandToolkitSetup } from "@/components/setup/BrandToolkitSetup";
import { notFound } from "next/navigation";

export default async function WorkspaceBrandToolkitPage({ params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  const id = Number(profileId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  return <BrandToolkitSetup key={id} profileId={id} />;
}
