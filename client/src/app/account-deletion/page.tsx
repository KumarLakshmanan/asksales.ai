"use client";

import { FormEvent, useState } from "react";
import { Trash2 } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";

interface SubmissionResult {
  id: number;
  status: string;
  requestedAt: string;
}

export default function AccountDeletionPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { toast } = useToast();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) {
      toast({
        title: "Confirmation required",
        description: "Please confirm that you want to submit an account deletion request.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const data = await api.post<SubmissionResult>(
        "/api/legal/account-deletion-requests",
        {
          fullName: fullName.trim() || undefined,
          email: email.trim(),
          reason: reason.trim() || undefined,
          source: "account_deletion_page",
        },
        { skipAuth: true }
      );

      setResult(data);
      toast({
        title: "Request submitted",
        description: `Your request ID is #${data.id}. Our team will review it shortly.`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to submit request";
      setErrorMessage(message);
      toast({
        title: "Submission failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PublicLayout>
      <section className="pb-20 pt-28 sm:pt-32">
        <div className="mx-auto max-w-3xl px-5 sm:px-8">
          <div className="mb-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-destructive">
            <Trash2 className="w-4 h-4" />
            <span>Account Deletion Request</span>
          </div>

          <h1 className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
            Request account deletion
          </h1>
          <p className="text-muted-foreground mb-8 leading-relaxed">
            Use this form to request permanent deletion of your account data. Our team will verify your request and contact you at your registered email.
          </p>

          {result ? (
            <div className="border border-success/30 bg-success/5 p-6 sm:p-8">
              <h2 className="mb-2 text-xl font-semibold text-foreground">Request received</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Your account deletion request has been saved successfully.
              </p>
              <p className="text-sm text-muted-foreground mb-4">
                Next, our team will verify the request and contact you at your registered email. Keep the request ID below if you need to follow up.
              </p>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Request ID</p>
                  <p className="font-semibold text-foreground">#{result.id}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-semibold text-foreground capitalize">{result.status.replace("_", " ")}</p>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6 border border-border bg-card p-6 sm:p-8">
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name (optional)</Label>
                <Input
                  id="fullName"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email (required)</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  aria-describedby="deletion-email-hint"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <p id="deletion-email-hint" className="text-xs text-muted-foreground">Use the email address registered to your account.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reason">Reason (optional)</Label>
                <Textarea
                  id="reason"
                  rows={6}
                  placeholder="Tell us why you are requesting account deletion"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-warning/30 bg-warning/5 p-4">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span className="text-sm text-muted-foreground leading-relaxed">
                  I confirm this request is intentional and I understand account deletion is irreversible after processing.
                </span>
              </label>

              {errorMessage && (
                <Callout tone="danger" size="sm">
                  {errorMessage}
                </Callout>
              )}

              <div className="space-y-2">
                <Button
                  type="submit"
                  loading={submitting}
                  loadingText="Submitting…"
                  disabled={!confirmed}
                  aria-describedby={confirmed ? undefined : "deletion-confirm-hint"}
                  className="w-full sm:w-auto"
                >
                  Submit deletion request
                </Button>
                {!confirmed && (
                  <p id="deletion-confirm-hint" className="text-xs text-muted-foreground">Tick the confirmation above to submit.</p>
                )}
              </div>
            </form>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}
