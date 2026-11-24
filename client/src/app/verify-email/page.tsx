"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle, Mail } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { SplitAuthShell } from "@/components/auth/SplitAuthShell";

const VERIFICATION_OTP_REGEX = /^\d{6}$/;

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [emailLoaded, setEmailLoaded] = useState(false);
  const [otp, setOtp] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [nextPath, setNextPath] = useState<string | null>(null);

  useEffect(() => {
    if (!nextPath) return;
    const timer = window.setTimeout(() => router.push(nextPath), 2000);
    return () => window.clearTimeout(timer);
  }, [nextPath, router]);

  const queryEmail = searchParams.get("email")?.trim() || "";

  useEffect(() => {
    setEmail(queryEmail || localStorage.getItem("pendingVerificationEmail") || "");
    setEmailLoaded(true);
  }, [queryEmail]);

  const handleVerify = useCallback(async (value?: string) => {
    const otpToVerify = (value || otp).replace(/\s+/g, "");
    if (!VERIFICATION_OTP_REGEX.test(otpToVerify)) return void toast({ title: "Enter the complete verification OTP", description: "The verification OTP contains six digits.", variant: "destructive" });
    setIsVerifying(true);
    try {
      const data = await api.post<{ user: { id: number; name: string; email: string; role: string; hasBusinessProfile?: boolean; hasBrandToolkit?: boolean; isSetupComplete?: boolean; isApproved?: boolean } }>("/api/auth/verify-email", { email, otp: otpToVerify }, { skipAuth: true });
      localStorage.removeItem("pendingVerificationEmail");
      login(data.user);
      setIsVerified(true);
      setOtp("");
      let next = "/setup/business-profile";
      if (data.user.hasBusinessProfile && data.user.hasBrandToolkit && data.user.isSetupComplete) next = data.user.isApproved ? "/dashboard/home" : "/setup/account-verification";
      else if (data.user.hasBusinessProfile) next = "/setup/brand-toolkit";
      setNextPath(next);
    } catch (error) {
      toast({ title: "Email was not verified", description: error instanceof ApiError && error.status ? error.message || "The verification OTP is invalid or expired." : "The server could not be reached.", variant: "destructive" });
    } finally { setIsVerifying(false); }
  }, [email, login, otp, toast]);

  const resend = async () => {
    setIsResending(true);
    try { await api.post("/api/auth/resend-verification", { email }, { skipAuth: true }); setOtp(""); toast({ title: "A new verification email was requested", description: "Check the inbox associated with this registration." }); }
    catch (error) { toast({ title: "Verification email was not requested", description: error instanceof ApiError && error.status ? error.message || "Try again." : "The server could not be reached.", variant: "destructive" }); }
    finally { setIsResending(false); }
  };

  if (!emailLoaded) return (
    <SplitAuthShell
      eyebrow="Account verification"
      title="Verify the address that owns this workspace."
      description="Email verification keeps workspace access and provider approvals tied to the correct account."
      highlights={["Open the verification message", "Enter the six-digit OTP", "Continue to business setup"]}
    >
      <div className="space-y-4" aria-label="Loading email verification">
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        <div className="h-8 w-52 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="mt-8 h-12 w-full animate-pulse rounded bg-muted" />
      </div>
    </SplitAuthShell>
  );

  return (
    <SplitAuthShell
      eyebrow="Account verification"
      title="Verify the address that owns this workspace."
      description="Email verification keeps workspace access and provider approvals tied to the correct account."
      highlights={["Open the verification message", "Enter the six-digit OTP", "Continue to business setup"]}
      formWidth="md"
    >
        <section>
          {!email ? (
            <div className="text-center"><Mail className="mx-auto h-6 w-6 text-primary" /><h1 className="mt-5 text-2xl font-semibold">Verification context is missing</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Start from registration so the OTP can be associated with an email address.</p><Link href="/login?mode=register" className="mt-7 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground">Return to registration</Link></div>
          ) : isVerified ? (
            <div className="text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-success/30 bg-success/10"><CheckCircle className="h-5 w-5 text-success" /></div><h1 className="mt-6 text-2xl font-semibold">Email verified</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Your account is verified. Opening the next setup step…</p></div>
          ) : (
            <>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Account verification</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">Verify your email</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Enter the six-digit verification OTP sent for this registration.</p>
              <p className="mt-4 truncate border-y border-border py-3 font-mono text-xs text-muted-foreground">{email}</p>
              <form method="post" onSubmit={(event) => { event.preventDefault(); void handleVerify(); }} className="mt-7">
                <label htmlFor="verification-otp" className="sr-only">Six-digit verification OTP</label>
                <InputOTP id="verification-otp" name="otp" maxLength={6} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(value) => { setOtp(value); if (value.length === 6) void handleVerify(value); }} disabled={isVerifying} className="justify-center" aria-label="Six-digit verification OTP" aria-describedby="verification-otp-help">
                  <InputOTPGroup>{[0,1,2].map((index) => <InputOTPSlot key={index} index={index} className="h-12 w-11 font-mono text-lg" />)}</InputOTPGroup><InputOTPSeparator /><InputOTPGroup>{[3,4,5].map((index) => <InputOTPSlot key={index} index={index} className="h-12 w-11 font-mono text-lg" />)}</InputOTPGroup>
                </InputOTP>
                <p id="verification-otp-help" className="mt-2 text-center text-xs text-muted-foreground">Enter the six-digit OTP from the verification email.</p>
                <Button type="submit" disabled={isVerifying || !VERIFICATION_OTP_REGEX.test(otp)} className="mt-7 h-11 w-full">{isVerifying ? "Verifying…" : "Verify email"}</Button>
              </form>
              <div className="mt-8 flex items-center justify-between border-t border-border pt-6 text-sm"><Link href="/login" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Sign in</Link><button type="button" onClick={() => void resend()} disabled={isResending || isVerifying} className="text-primary disabled:opacity-50">{isResending ? "Requesting…" : "Request another OTP"}</button></div>
            </>
          )}
        </section>
    </SplitAuthShell>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<main className="flex min-h-svh items-center justify-center bg-background"><Spinner size="lg" label="Loading…" className="text-primary" /></main>}><VerifyEmailContent /></Suspense>;
}
