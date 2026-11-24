"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { LoadingState } from "@/components/ui/loading-state";
import { SESSION_CARD_RECHECK_MS } from "@/lib/sessionCheckRetry";

export function AdminProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, admin, error, checkAuth } = useAdminAuth();
  const router = useRouter();
  const hasAdminRole = !!admin && ["admin", "super_admin"].includes(admin.role);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    // An outage (error set) is not a sign-out: only a settled check with no
    // admin and no error (a real 401/403) goes to the sign-in page.
    if (isLoading || error) return;
    if (!isAuthenticated || !hasAdminRole) {
      router.push("/admin/login");
    }
  }, [isAuthenticated, isLoading, hasAdminRole, error, router]);

  const recheck = async () => {
    setRechecking(true);
    try { await checkAuth(); } finally { setRechecking(false); }
  };

  // A longer server outage outlasts the automatic retries in checkAuth. Keep
  // checking in the background so the admin dashboard opens once it recovers.
  useEffect(() => {
    if (!error || isLoading || rechecking) return;
    const timer = window.setTimeout(() => { void recheck(); }, SESSION_CARD_RECHECK_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, isLoading, rechecking, checkAuth]);

  if (isLoading) {
    return <LoadingState size="page" className="min-h-screen" label="Checking admin access…" />;
  }

  if (error && !isAuthenticated) {
    return (
      <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">Admin session check unavailable</h1>
        <p className="max-w-md text-sm text-muted-foreground">{error}</p>
        <p className="max-w-md text-sm text-muted-foreground">We will keep checking automatically.</p>
        <button type="button" className="rounded-md border px-4 py-2 text-sm disabled:opacity-60" disabled={rechecking} onClick={() => void recheck()}>
          {rechecking ? "Checking…" : "Retry session check"}
        </button>
      </div>
    );
  }

  if (!isAuthenticated || !hasAdminRole) {
    return <LoadingState size="page" className="min-h-screen" label="Redirecting to admin sign-in…" />;
  }

  return <>{children}</>;
}
