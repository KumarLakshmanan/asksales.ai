"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { useAuth } from "@/contexts/AuthContext";
import { PageLoadingState } from "@/components/ui/page-state";

export default function DashboardIndex() {
  const router = useRouter();
  const { shouldShowOnboarding, isLoading, setupRedirectPath } = useSetupComplete();
  const { isApproved } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (shouldShowOnboarding && setupRedirectPath) {
        router.replace(setupRedirectPath);
      } else if (!isApproved) {
        router.replace("/dashboard/approval-pending");
      } else {
        router.replace("/dashboard/home");
      }
    }
  }, [isLoading, shouldShowOnboarding, isApproved, setupRedirectPath, router]);

  return <PageLoadingState className="min-h-svh" label="Opening your workspace…" />;
}
