"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2, Check, LogOut, Plus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinessProfiles, businessProfileName } from "@/hooks/use-business-profiles";
import { useToast } from "@/hooks/use-toast";
import { BusinessInvitations } from "@/components/BusinessInvitations";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";

export default function SelectBusinessProfilePage() {
  const router = useRouter();
  const { logout } = useAuth();
  const { toast } = useToast();
  const { profiles, activeProfile, isLoading, isError, refetch, switchProfile, isSwitching } = useBusinessProfiles();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const selectProfile = async (id: number) => {
    setSelectedId(id);
    try {
      await switchProfile(id);
    } catch (error) {
      toast({
        title: "Could not open business profile",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSelectedId(null);
    }
  };

  return (
    <main id="main-content" className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-xl">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Building2 className="h-6 w-6" /></span>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Select business profile</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your business profile is your workspace. Open one you own or have joined.</p>
        </div>

        <div className="mb-6"><BusinessInvitations /></div>
        {isLoading ? (
          <LoadingState size="section" label="Loading profiles" />
        ) : isError ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">Your business profiles could not be loaded.</p>
            <Button variant="outline" className="mt-4" onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {profiles.map((profile) => {
              const name = businessProfileName(profile);
              const active = profile.id === activeProfile?.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  disabled={isSwitching}
                  onClick={() => void selectProfile(profile.id)}
                  className="group flex min-h-20 w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/45 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xl font-semibold text-primary" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-foreground">{name}</span>
                    <span className="block text-xs text-muted-foreground">{`${profile.role === "owner" ? "Owner" : profile.role === "billing_admin" ? "Billing admin" : "Staff member"}${active ? " · Current business" : ""}`}</span>
                  </span>
                  {selectedId === profile.id && isSwitching ? <Spinner size="md" label={null} className="text-primary" /> : active ? <Check className="h-5 w-5 text-primary" /> : <ArrowRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
                </button>
              );
            })}
            <Link href="/setup/business-profile/new" className="flex min-h-16 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/45 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Add business profile <Plus className="h-4 w-4" />
            </Link>
          </div>
        )}

        <div className="mt-7 flex items-center justify-center gap-5 text-sm">
          <Link href="/dashboard/invitations" className="text-muted-foreground hover:text-foreground">Your invitations</Link>
          <button type="button" onClick={() => void logout()} className="inline-flex items-center gap-1.5 text-destructive hover:underline"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
        {activeProfile && <button type="button" onClick={() => router.push("/dashboard/home")} className="mx-auto mt-5 block text-xs text-muted-foreground underline-offset-4 hover:underline">Return to dashboard</button>}
      </div>
    </main>
  );
}
