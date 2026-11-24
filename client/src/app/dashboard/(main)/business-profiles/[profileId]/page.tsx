"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { BusinessProfileForm } from "@/components/BusinessProfileForm";
import { LoadingState } from "@/components/ui/loading-state";

export default function BusinessProfilePage() {
  const params = useParams();
  const profileId = params.profileId as string;
  const router = useRouter();
  const profiles = useBusinessProfiles();
  const profile = profiles.profiles.find(item => item.id === Number(profileId));
  if (profiles.isLoading) return <LoadingState size="page" label="Loading business profile…" />;
  if (profiles.isError) return <div role="alert" className="p-6"><p>Business profiles could not be loaded.</p><Button className="mt-4" variant="outline" onClick={() => void profiles.refetch()}>Try again</Button></div>;
  if (!profile || profile.role !== 'owner') return <div className="space-y-4 p-6"><h1 className="text-2xl font-semibold">Business details</h1><p className="text-sm text-muted-foreground">Only the business owner can edit this profile.</p><Button variant="outline" onClick={() => router.push('/dashboard/home?workspace=choose')}>Back to business profiles</Button></div>;

  return (
    <div className="w-full space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8 rounded-lg"><Link href="/dashboard/home?workspace=choose" aria-label="Back to business profiles"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold">Business Profile</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Edit business profile</p>
        </div>
      </div>

      <BusinessProfileForm
        profileId={Number(profileId)}
        saveButtonLabel="Save changes"
        onSaveSuccess={() => router.push("/dashboard/home?workspace=choose")}
      />
    </div>
  );
}
