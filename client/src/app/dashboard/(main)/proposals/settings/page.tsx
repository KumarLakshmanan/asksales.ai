"use client";

import Link from "next/link";
import { ProposalReviewPolicyDialog } from "@/components/proposals/ProposalReviewPolicyDialog";
import { WorkspaceSettingsScope } from "@/components/settings/WorkspaceSettingsScope";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";

export default function ProposalSettingsPage() {
  const profiles = useBusinessProfiles();
  return <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <Link href="/dashboard/proposals" className="text-sm text-muted-foreground hover:underline">← Back to proposals</Link>
    <div><h1 className="text-2xl font-semibold tracking-tight">Proposal settings</h1><p className="mt-2 text-sm text-muted-foreground">Choose when offers can be sent and who must review them.</p></div>
    <WorkspaceSettingsScope detail="Proposal review and approval policy applies to proposals in this workspace." className="max-sm:flex-col max-sm:gap-1" />
    {!profiles.isLoading && !profiles.isError && profiles.activeProfile && <ProposalReviewPolicyDialog key={profiles.activeProfile.id} inline />}
  </div>;
}
