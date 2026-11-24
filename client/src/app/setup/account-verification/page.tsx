"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { SetupShell } from "@/components/setup/SetupShell";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageLoadingState } from "@/components/ui/page-state";
import { useAuth } from "@/contexts/AuthContext";
import { useSetupComplete } from "@/hooks/useSetupComplete";

export default function AccountVerificationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isApproved, error, checkAuth } = useAuth();
  const {
    hasBusinessProfile,
    hasBrandToolkit,
    isLoading: setupLoading,
  } = useSetupComplete();
  const [isChecking, setIsChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const checkingRef = useRef(false);
  const handleCheckStatus = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try { await checkAuth(); setLastChecked(new Date()); }
    finally { checkingRef.current = false; setIsChecking(false); }
  }, [checkAuth]);
  const justFinished = searchParams.get("justFinished") === "1";

  useEffect(() => {
    if (setupLoading) return;
    if (!hasBusinessProfile) {
      router.replace("/setup/business-profile");
    } else if (!hasBrandToolkit) {
      router.replace("/setup/brand-toolkit");
    }
  }, [setupLoading, hasBusinessProfile, hasBrandToolkit, router]);

  useEffect(() => {
    if (!isApproved) return;
    const timer = window.setTimeout(
      () => router.replace("/dashboard/home"),
      3000,
    );
    return () => window.clearTimeout(timer);
  }, [isApproved, router]);

  useEffect(() => {
    if (setupLoading || isApproved) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void handleCheckStatus();
    }, 30_000);
    const resume = () => { if (document.visibilityState === "visible") void handleCheckStatus(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [handleCheckStatus, isApproved, setupLoading]);


  if ((setupLoading && !isChecking) || !hasBusinessProfile || !hasBrandToolkit) {
    return (
      <PageLoadingState
        className="min-h-svh"
        label="Checking your setup progress…"
      />
    );
  }

  return (
    <SetupShell
      area="Account review"
      title="Your setup is saved."
      description="Your business profile and brand toolkit are ready. Here’s what happens next."
      sections={["Account status"]}
      step={1}
    >
      {isApproved ? (
        <div className="space-y-7 text-center" aria-live="polite">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10 text-success">
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </span>
          <div>
            <p className="mb-2 text-sm font-medium text-success">
              Account approved
            </p>
            <h2 className="text-3xl font-semibold tracking-tight">
              Your workspace is ready
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              You now have access to the dashboard. We’ll redirect you
              automatically.
            </p>
          </div>
          {justFinished && (
            <p className="rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
              Your setup was saved successfully.
            </p>
          )}
          <Button
            className="w-full"
            size="lg"
            onClick={() => router.replace("/dashboard/home")}
          >
            Open dashboard
          </Button>
        </div>
      ) : (
        <div className="space-y-7">
          <div className="text-center">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/10 text-warning">
              <Clock3 className="h-8 w-8" aria-hidden="true" />
            </span>
            <p className="mb-2 mt-6 text-sm font-medium text-warning">
              Pending administrator review
            </p>
            <h2 className="text-3xl font-semibold tracking-tight">
              Your account is under review
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Your business profile and brand toolkit are saved. Access will
              unlock as soon as an administrator approves the account.
            </p>
          </div>

          {justFinished && (
            <p className="rounded-lg border border-info/20 bg-info/10 px-4 py-3 text-sm text-info">
              Setup submitted. You can safely leave this page and return later.
            </p>
          )}

          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div>
                <h2 className="text-sm font-semibold">Approval notification</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  We’ll notify{" "}
                  <span className="font-medium text-foreground">
                    {user?.email}
                  </span>{" "}
                  when access is approved. This page also checks automatically
                  every 30 seconds while open.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border p-4">
            <h2 className="text-sm font-semibold">What you can do now</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
              <li>Review your saved brand toolkit while the administrator checks your account.</li>
              <li>Return with the same email address. Your setup remains saved, and this page will check your access again.</li>
              <li>If you need help with your review, <Link href="/contact" className="font-medium text-primary underline underline-offset-4">contact support</Link> and include your account email.</li>
            </ul>
          </div>
          {lastChecked && <p className="text-xs text-muted-foreground" role="status">{error ? "The last status check could not be completed. Try again when your connection is available." : `Last checked at ${lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}</p>}
          {error && (
            <Callout tone="danger">{error}</Callout>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => router.push("/setup/brand-toolkit")}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Review brand toolkit
            </Button>
            <Button
              className="flex-1"
              onClick={handleCheckStatus}
              loading={isChecking}
              loadingText="Checking status…"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Check status now
            </Button>
          </div>
        </div>
      )}
    </SetupShell>
  );
}
