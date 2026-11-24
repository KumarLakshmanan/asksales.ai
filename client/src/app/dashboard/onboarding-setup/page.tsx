"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { PageLoadingState } from "@/components/ui/page-state";

export default function OnboardingSetupRedirect() {
  const router = useRouter();
  const { hasBusinessProfile, hasBrandToolkit, isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (!isAuthenticated) {
        router.replace("/login");
      } else if (!hasBusinessProfile) {
        router.replace("/setup/business-profile");
      } else if (!hasBrandToolkit) {
        router.replace("/setup/brand-toolkit");
      } else {
        router.replace("/dashboard/home");
      }
    }
  }, [isLoading, isAuthenticated, hasBusinessProfile, hasBrandToolkit, router]);

  return <PageLoadingState className="min-h-svh" label="Preparing your setup…" />;
}
