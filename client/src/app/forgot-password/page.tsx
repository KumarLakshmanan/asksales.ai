"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Mail, ArrowLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from '@/lib/api';
import { SplitAuthShell } from "@/components/auth/SplitAuthShell";
import { EMAIL_ADDRESS_PATTERN as EMAIL_REGEX } from "../../../../shared/emailAddress";

export default function ForgotPassword() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [requestError, setRequestError] = useState("");

  useEffect(() => {
    if (!emailSent) return;
    const timer = window.setTimeout(() => router.push(`/reset-password?email=${encodeURIComponent(email)}`), 2000);
    return () => window.clearTimeout(timer);
  }, [email, emailSent, router]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError("");
    setRequestError("");

    if (!EMAIL_REGEX.test(email)) {
      setEmailError("Please enter a valid email address.");
      return;
    }

    setIsSubmitting(true);

    try {
      await api.post("/api/auth/forgot-password", { email }, { skipAuth: true });

      setEmailSent(true);
      toast({
        title: "Recovery request accepted",
        description: "If the account exists, the email provider will receive a recovery request.",
      });
    } catch (err) {
      const message = err instanceof ApiError && err.status === 429
        ? "Too many requests. Please wait before trying again."
        : "The recovery request could not be completed. Please try again.";
      setRequestError(message);
      toast({ title: "Recovery email was not requested", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (emailSent) {
    return (
      <SplitAuthShell
        eyebrow="Account recovery"
        title="Get back to your workspace."
        description="Recovery codes are time-limited and account existence stays private throughout the request."
        highlights={["Request a six-digit code", "Choose a strong new password", "Return to your existing workspace"]}
      >
        <div className="border border-border bg-card p-7 text-center sm:p-9">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/50">
            <Mail className="h-5 w-5 text-primary" />
          </div>
          <div className="space-y-2">
            <h2 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">Check your email</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              If the address is registered, a 6-digit OTP is on its way to
              <strong className="mt-1 block break-all text-foreground">{email}</strong>
            </p>
          </div>
          <p className="mt-5 font-mono text-xs text-muted-foreground">The code expires in 15 minutes.</p>
          <Button
            onClick={() => router.push(`/reset-password?email=${encodeURIComponent(email)}`)}
            className="mt-7 h-11 w-full"
          >
            Continue to reset password
          </Button>
        </div>
      </SplitAuthShell>
    );
  }

  return (
    <SplitAuthShell
      eyebrow="Account recovery"
      title="Get back to your workspace."
      description="Recovery codes are time-limited and account existence stays private throughout the request."
      highlights={["Request a six-digit code", "Choose a strong new password", "Return to your existing workspace"]}
    >
      <div>
          <div className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Account recovery</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Reset your password</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Enter your email to request a recovery code.
            </p>
          </div>

          <form method="post" onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(""); }}
                placeholder="name@company.com"
                required
                aria-describedby={emailError ? "email-error" : undefined}
                aria-invalid={emailError ? true : undefined}
                className={`h-11 ${emailError ? "border-destructive" : ""}`}
              />
              {emailError && <p id="email-error" role="alert" className="text-xs text-destructive mt-1">{emailError}</p>}
            </div>
            {requestError && <p role="alert" className="text-sm text-destructive">{requestError}</p>}
            <Button
              type="submit"
              disabled={isSubmitting}
              className="group flex h-11 w-full items-center justify-center gap-2"
            >
              {isSubmitting ? "Requesting…" : "Request recovery code"}
              {!isSubmitting && <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />}
            </Button>
          </form>

          <div className="mt-8 border-t border-border pt-6 text-center">
            <p className="text-sm text-muted-foreground">
              Remember your password?{' '}
              <Link href="/login" className="text-primary hover:underline underline-offset-4">Sign in</Link>
            </p>
          </div>
        <div className="mt-7 text-center">
          <Link href="/" className="group inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </div>
      </div>
    </SplitAuthShell>
  );
}
