"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";

type Platform = "facebook" | "instagram" | "whatsapp" | "youtube" | "gmail" | "resend" | "msg91";
type Status = "passing" | "failing" | "blocked";

interface VerificationCheck {
  id: string;
  status: "pass" | "fail" | "blocked" | "not_applicable";
  required: boolean;
  detail: string;
}

interface Verification {
  platform: Platform;
  status: Status;
  credentialId: number | null;
  providerAccountId: string | null;
  checks: VerificationCheck[];
  checkedAt: string;
  expiresAt: string;
}

interface ReadinessResponse {
  verifications: Verification[];
}

function customerIssue(check: VerificationCheck): string {
  if (["webhook_subscription", "webhook_signature_secret", "public_callback_https"].includes(check.id)) {
    return "Incoming updates need attention. Reconnect the account or contact support.";
  }
  return check.detail;
}

const platforms: Array<{ id: Platform; label: string; managePath: string }> = [
  { id: "facebook", label: "Facebook", managePath: "/dashboard/integrations/facebook" },
  { id: "instagram", label: "Instagram", managePath: "/dashboard/integrations/instagram" },
  { id: "whatsapp", label: "WhatsApp", managePath: "/dashboard/integrations/whatsapp" },
  { id: "youtube", label: "YouTube", managePath: "/dashboard/integrations/youtube" },
  { id: "gmail", label: "Gmail", managePath: "/dashboard/integrations/email" },
  { id: "resend", label: "Resend", managePath: "/dashboard/integrations/email" },
  { id: "msg91", label: "SMS · MSG91", managePath: "/dashboard/integrations/msg91" },
];

function StatusIcon({ status }: { status?: Status }) {
  if (status === "passing") return <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />;
  if (status === "failing") return <XCircle className="size-4 text-destructive" aria-hidden />;
  return <AlertCircle className="size-4 text-amber-500" aria-hidden />;
}

/** Tenant-level, read-only provider verification and setup runbook. */
export function ProviderReadinessPanel() {
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Platform | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setData(await api.get<ReadinessResponse>("/api/integration-readiness"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Readiness status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const verify = async (platform: Platform) => {
    try {
      setRunning(platform);
      // This only calls the provider's token/account/scope/webhook inspection
      // endpoints. It never publishes, sends, uploads, or deletes content.
      await api.post(`/api/integration-readiness/${platform}/verify`, {});
    } catch {
      // A failing verification intentionally returns 409. Reloading renders
      // the persisted, actionable provider checks instead of a vague toast.
    } finally {
      setRunning(null);
      await load();
    }
  };

  const byPlatform = new Map((data?.verifications || []).map((entry) => [entry.platform, entry]));

  return (
    <Card className="border-primary/15 bg-gradient-to-br from-primary/[0.035] to-transparent">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-5 text-primary" /> Provider release readiness</CardTitle>
          <CardDescription className="mt-1">Check whether each connected account is ready for messaging, publishing, and delivery.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} loading={loading} loadingText="Refresh">
          <RefreshCw className="mr-2 size-4" /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Callout tone="danger" size="sm" role="status">{error}</Callout>}
        <div className="grid gap-3 lg:grid-cols-2">
          {platforms.map(({ id, label, managePath }) => {
            const verification = byPlatform.get(id);
            // Deployment review is managed centrally. Keep it out of the
            // owner-facing readiness copy while retaining operational checks.
            const visibleChecks = verification?.checks.filter((check) => check.id !== "app_review") || [];
            const requiredIssues = visibleChecks.filter((check) => check.required && check.status !== "pass");
            const displayStatus: Status | undefined = verification
              ? requiredIssues.length === 0
                ? "passing"
                : requiredIssues.some((check) => check.status === "fail")
                  ? "failing"
                  : "blocked"
              : undefined;
            return <div key={id} className="rounded-lg border bg-background/75 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><StatusIcon status={displayStatus} /><p className="font-medium">{label}</p></div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {verification ? `Last checked ${new Date(verification.checkedAt).toLocaleString()}` : "Not yet verified"}
                  </p>
                </div>
                <Badge variant={displayStatus === "passing" ? "default" : "secondary"}>{displayStatus || "pending"}</Badge>
              </div>
              {requiredIssues.length > 0 && <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {requiredIssues.slice(0, 2).map((check) => <li key={check.id}>• {customerIssue(check)}</li>)}
              </ul>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void verify(id)} loading={running === id} disabled={running !== null && running !== id}>
                  Verify safely
                </Button>
                <a className="inline-flex items-center text-xs text-primary hover:underline" href={managePath}>Manage <ExternalLink className="ml-1 size-3" /></a>
              </div>
            </div>;
          })}
        </div>
        <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Connection checklist</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>Connect the intended account and select it as the publishing identity.</li>
            <li>Finish any account permissions or domain verification requested in the integration page.</li>
            <li>Run “Verify safely” to check whether the connection is working.</li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}
