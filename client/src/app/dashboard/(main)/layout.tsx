"use client";

import { DashboardLayout } from "@/components/DashboardLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageLoadingState } from "@/components/ui/page-state";
import { usePlatformAccess } from "@/hooks/use-platform-access";
import { getModuleUnavailableMessage, isHiddenDashboardPath, moduleForDashboardPath } from "@/lib/platform-access";
import { PlatformAccessState } from "@/components/PlatformAccessState";
import { BRAND_NAME } from "@/lib/brand";
import { dashboardPageName } from "@/lib/dashboardPageName";
import { reloadCurrentPage } from "@/lib/page-error-recovery";

export default function MainDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isApproved, isLoading: authLoading, checkAuth } = useAuth();
  const { shouldShowOnboarding, isLoading: setupLoading, setupRedirectPath } = useSetupComplete();
  const access = usePlatformAccess(!authLoading && isApproved);
  const hiddenDashboardPath = isHiddenDashboardPath(pathname);
  const businessManagementPath = pathname.startsWith('/dashboard/business-profiles') || pathname.startsWith('/dashboard/settings/company');
  const needsOnboarding = shouldShowOnboarding && !businessManagementPath;
  const billingRecoveryPath = businessManagementPath || /^\/dashboard\/(billing|support|user-profile|settings\/(profile|account|preferences|team))(\/|$)/.test(pathname);
  const subscriptionRequired = access.data?.subscription?.allowed === false && !billingRecoveryPath;

  useEffect(() => {
    if (authLoading || setupLoading) return;
    if (needsOnboarding && setupRedirectPath) {
      router.replace(setupRedirectPath);
    } else if (!isApproved) {
      router.replace("/dashboard/approval-pending");
    } else if (hiddenDashboardPath) {
      router.replace("/dashboard/home");
    } else if (subscriptionRequired) {
      router.replace("/subscribe");
    }
  }, [authLoading, hiddenDashboardPath, isApproved, router, setupLoading, setupRedirectPath, needsOnboarding, subscriptionRequired]);

  if (authLoading || setupLoading || needsOnboarding || !isApproved || hiddenDashboardPath || access.isLoading || subscriptionRequired) {
    // Name the step that is still running and retry only that step, so a slow
    // check never leaves the user on an unexplained full-screen loader.
    const gate = authLoading
      ? { description: "Confirming your sign-in.", retry: () => void checkAuth() }
      : setupLoading
        ? { description: "Checking your workspace setup.", retry: reloadCurrentPage }
        : access.isLoading
          ? { description: "Checking which modules your plan includes.", retry: () => void access.refetch() }
          : { description: "Opening the right page for your account.", retry: reloadCurrentPage };
    return (
      <PageLoadingState
        className="min-h-svh"
        context={dashboardPageName(pathname) ?? undefined}
        label="Checking account access…"
        description={gate.description}
        onRetry={gate.retry}
      />
    );
  }

  if (access.isError || !access.data) {
    return (
      <PlatformAccessState
        kind="error"
        title={`Reconnecting to ${BRAND_NAME}`}
        message="The platform service is temporarily unavailable. We will retry automatically; no module will be opened until server verification succeeds."
        onRetry={() => void access.refetch()}
      />
    );
  }

  if (access.data.maintenance.enabled) {
    return (
      <PlatformAccessState
        kind="maintenance"
        title="Scheduled maintenance"
        message={access.data.maintenance.message}
        onRetry={() => void access.refetch()}
      />
    );
  }

  const routeModule = moduleForDashboardPath(pathname);
  const routeAccess = routeModule ? access.data.modules.find((module) => module.key === routeModule) : null;
  if (routeModule && (!routeAccess || !routeAccess.enabled)) {
    return (
      <PlatformAccessState
        kind="unavailable"
        title={`${routeAccess?.name || "This module"} is unavailable`}
        message={getModuleUnavailableMessage(routeAccess)}
        onRetry={routeAccess?.status === "maintenance" ? () => void access.refetch() : undefined}
      />
    );
  }

  return (
    <DashboardLayout enabledModules={access.data.modules.filter((module) => module.enabled).map((module) => module.key)}>
      {children}
    </DashboardLayout>
  );
}
