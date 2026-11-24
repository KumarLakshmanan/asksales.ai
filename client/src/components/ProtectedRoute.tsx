"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageLoadingState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { SESSION_CARD_RECHECK_MS } from "@/lib/sessionCheckRetry";
import { dashboardPageName } from "@/lib/dashboardPageName";

interface ProtectedRouteProps {
  children: React.ReactNode;
  skipSetupCheck?: boolean;
}

export function ProtectedRoute({ children, skipSetupCheck = false }: ProtectedRouteProps) {
  const { workspaceRole, user, isAuthenticated, isLoading, isApproved, isSetupComplete, hasBusinessProfile, hasBrandToolkit, error, checkAuth } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Network/rate-limit/server failure is not an authentication rejection.
    // Do not navigate or expose protected content until verification succeeds.
    if (error) return;
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
      return;
    }

    // Pages that are allowed even during onboarding
    const isSetupPage = pathname?.startsWith("/setup/");
    const isInvitationPage = pathname === '/dashboard/invitations';
    const isApprovalPendingPage = pathname === "/dashboard/approval-pending";
    const isBusinessManagementPage = pathname === '/dashboard/select-profile' || pathname?.startsWith('/dashboard/business-profiles') || pathname?.startsWith('/dashboard/settings/company');

    if (!isLoading && isAuthenticated && user && !skipSetupCheck) {
      // Determine effective setup complete - both business profile AND brand toolkit must exist
      const staff = workspaceRole === 'member' || workspaceRole === 'billing_admin';
      const bothComplete = hasBusinessProfile && (hasBrandToolkit || staff);

      // If setup is not complete, redirect to the appropriate setup page
      if (!bothComplete && !isSetupPage && !isBusinessManagementPage && !isInvitationPage) {
        if (!hasBusinessProfile) {
          router.push("/setup/business-profile");
          return;
        }
        if (!hasBrandToolkit) {
          router.push("/setup/brand-toolkit");
          return;
        }
      }

      // If setup is complete but not approved, redirect to account-verification
      if (bothComplete && !isApproved && !isApprovalPendingPage && !isSetupPage && !isInvitationPage) {
        router.push("/setup/account-verification");
        return;
      }

      // If approved and on approval-pending page, redirect to home (but NOT from setup pages)
      if (isApproved && isApprovalPendingPage) {
        router.push("/dashboard/home");
        return;
      }
    }
  }, [isAuthenticated, isLoading, isApproved, isSetupComplete, hasBusinessProfile, hasBrandToolkit, pathname, router, user, skipSetupCheck, error, workspaceRole]);

  // A longer server outage outlasts the automatic retries in checkAuth. Keep
  // checking in the background so the page opens once the server recovers.
  const [nextCheckAt, setNextCheckAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!error || isLoading) { setNextCheckAt(null); return; }
    setNextCheckAt(Date.now() + SESSION_CARD_RECHECK_MS);
    const timer = window.setTimeout(() => { void checkAuth(); }, SESSION_CARD_RECHECK_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearTimeout(timer); window.clearInterval(tick); };
  }, [error, isLoading, checkAuth]);

  const pageName = dashboardPageName(pathname) ?? undefined;

  if (isLoading) {
    return (
      <PageLoadingState
        className="min-h-screen"
        context={pageName}
        label="Loading your workspace…"
        description="Confirming your sign-in."
        onRetry={() => void checkAuth()}
      />
    );
  }

  if (error) {
    const secondsLeft = nextCheckAt ? Math.max(0, Math.ceil((nextCheckAt - now) / 1_000)) : null;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[14px] border border-border bg-card p-6 text-center shadow-sm">
          {pageName ? <p className="text-xs font-semibold uppercase tracking-wide text-primary">{pageName}</p> : null}
          <h1 className="mt-2 text-lg font-semibold">Session check unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
            {secondsLeft !== null && secondsLeft > 0 ? `Checking again in ${secondsLeft} seconds.` : "Checking again…"}
          </p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void checkAuth()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry session check
          </Button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <>{children}</>;
}
