"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, KeyRound } from "lucide-react";

import { AdminAuthShell } from "@/components/admin/AdminAuthShell";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/admin-api";
import { getPasswordChecks, isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { cn } from "@/lib/utils";
import { EMAIL_ADDRESS_PATTERN as EMAIL_PATTERN } from "../../../../../shared/emailAddress";


export default function ResetPassword() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    const storedEmail = sessionStorage.getItem("admin_reset_email");
    if (storedEmail) {
      setEmail(storedEmail);
      sessionStorage.removeItem("admin_reset_email");
    }
  }, []);

  const passwordChecks = getPasswordChecks(password);
  const checkItems = [
    ["8–128 characters", passwordChecks.length],
    ["Uppercase letter", passwordChecks.uppercase],
    ["Lowercase letter", passwordChecks.lowercase],
    ["Number", passwordChecks.number],
    ["Special character", passwordChecks.special],
  ] as const;

  const handleIdentityStep = () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setFieldError("Enter a valid admin email address.");
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      setFieldError("Enter the complete six-digit reset code.");
      return;
    }
    setEmail(normalizedEmail);
    setFieldError("");
    setStep(2);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitError("");

    if (!isStrongPassword(password)) {
      setSubmitError(PASSWORD_POLICY_MESSAGE);
      return;
    }
    if (password !== confirmPassword) {
      setSubmitError("The passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post(
        "/api/admin/reset-password",
        { email, otp, newPassword: password },
        { skipAuth: true },
      );
      setIsSuccess(true);
      toast({ title: "Password reset", description: "Your administrator password has been updated." });
    } catch (error) {
      const message = error instanceof ApiError
        ? error.message || "The reset code is invalid or has expired."
        : "We could not reach the server. Check your connection and try again.";
      setSubmitError(message);
      toast({ title: "Password reset failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminAuthShell
      eyebrow="Account recovery"
      title="Reset your password in two steps."
      description="Confirm the code sent to your administrator email, then choose credentials that meet the platform security policy."
      highlights={[
        step === 1 ? "Confirm your email and reset code" : "Identity confirmed",
        step === 2 ? "Create a strong new password" : "Create a new password",
        "Sign in with the updated credentials",
      ]}
    >
      {isSuccess ? (
        <div className="space-y-7 text-center" aria-live="polite">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </span>
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight">Password updated</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Your previous sessions have been invalidated. Sign in again with your new password.
            </p>
          </div>
          <Button type="button" size="lg" className="w-full" onClick={() => router.push("/admin/login")}>
            Continue to sign in
          </Button>
        </div>
      ) : (
        <>
          <Link
            href={step === 1 ? "/admin/forgot-password" : "#"}
            onClick={step === 2 ? (event) => { event.preventDefault(); setSubmitError(""); setStep(1); } : undefined}
            className="mb-8 inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {step === 1 ? "Request a new code" : "Back to verification"}
          </Link>

          <div className="mb-8">
            <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound className="h-6 w-6" aria-hidden="true" />
            </span>
            <p className="mb-2 text-sm font-medium text-primary">Step {step} of 2</p>
            <h2 className="text-3xl font-semibold tracking-tight">
              {step === 1 ? "Confirm your reset code" : "Create a new password"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {step === 1
                ? "Use the six-digit code sent to your administrator email."
                : "Your new password will invalidate older administrator sessions."}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2" aria-label={`Step ${step} of 2`}>
              <span className="h-1.5 rounded-full bg-primary" />
              <span className={cn("h-1.5 rounded-full", step === 2 ? "bg-primary" : "bg-muted")} />
            </div>
          </div>

          {step === 1 ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">Admin email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => { setEmail(event.target.value); setFieldError(""); }}
                  placeholder="admin@example.com"
                  className="h-11"
                  aria-invalid={Boolean(fieldError) && !EMAIL_PATTERN.test(email.trim())}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="otp">Six-digit reset code</Label>
                <Input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otp}
                  onChange={(event) => { setOtp(event.target.value.replace(/\D/g, "").slice(0, 6)); setFieldError(""); }}
                  placeholder="000000"
                  className="h-12 text-center text-xl font-semibold tracking-[0.45em]"
                  aria-describedby={fieldError ? "admin-reset-code-error" : "admin-reset-code-hint"}
                  aria-invalid={Boolean(fieldError)}
                  required
                />
                <p id="admin-reset-code-hint" className="text-xs text-muted-foreground">The code expires after 15 minutes.</p>
                {fieldError && <p id="admin-reset-code-error" role="alert" className="text-sm text-destructive">{fieldError}</p>}
              </div>
              <Button type="button" size="lg" className="w-full" onClick={handleIdentityStep} disabled={!email.trim() || otp.length !== 6}>
                Continue
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Remember your password? <Link href="/admin/login" className="font-medium text-primary hover:underline">Sign in</Link>
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <PasswordInput
                  id="password"
                  name="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); setSubmitError(""); }}
                  className="h-11"
                  required
                  autoFocus
                />
                <ul className="grid grid-cols-1 gap-1 pt-1 text-xs text-muted-foreground sm:grid-cols-2" aria-label="Password requirements">
                  {checkItems.map(([label, passed]) => (
                    <li key={label} className={cn("flex items-center gap-1.5", passed && "text-emerald-600 dark:text-emerald-400")}>
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <PasswordInput
                  id="confirm-password"
                  name="confirmPassword"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => { setConfirmPassword(event.target.value); setSubmitError(""); }}
                  className="h-11"
                  aria-invalid={Boolean(confirmPassword) && password !== confirmPassword}
                  required
                />
              </div>
              {submitError && <Callout tone="danger">{submitError}</Callout>}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={isSubmitting}
                loadingText="Updating password…"
                disabled={!isStrongPassword(password) || password !== confirmPassword}
              >
                Reset password
              </Button>
            </form>
          )}
        </>
      )}
    </AdminAuthShell>
  );
}
