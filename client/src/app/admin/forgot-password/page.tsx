"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, Mail } from "lucide-react";

import { AdminAuthShell } from "@/components/admin/AdminAuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/admin-api";
import { EMAIL_ADDRESS_PATTERN as EMAIL_PATTERN } from "../../../../../shared/emailAddress";


export default function ForgotPassword() {
  const { toast } = useToast();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setEmailError("Enter a valid admin email address.");
      return;
    }

    setEmailError("");
    setIsSubmitting(true);
    try {
      await api.post("/api/admin/forgot-password", { email: normalizedEmail }, { skipAuth: true });
      setEmail(normalizedEmail);
      setIsSuccess(true);
      toast({ title: "Reset code requested", description: "Check your inbox for the six-digit code." });
    } catch (error) {
      if (error instanceof ApiError) {
        toast({
          title: "Unable to request a reset code",
          description: error.message || "Please try again shortly.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Connection error",
          description: "We could not reach the server. Check your connection and try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const continueToReset = () => {
    sessionStorage.setItem("admin_reset_email", email);
    router.push("/admin/reset-password");
  };

  return (
    <AdminAuthShell
      eyebrow="Account recovery"
      title="Recover your administrator account."
      description="Request a short-lived verification code, confirm your identity, and choose a new password."
      highlights={[
        "Request a code for your admin email",
        "Enter the six-digit code from your inbox",
        "Create a new password",
      ]}
    >
      {isSuccess ? (
        <div className="space-y-7 text-center" aria-live="polite">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
          </span>
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight">Check your email</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              If an admin account exists for <span className="font-medium text-foreground">{email}</span>, a six-digit reset code is on its way.
            </p>
          </div>
          <div className="space-y-3">
            <Button type="button" size="lg" className="w-full" onClick={continueToReset}>
              Enter code and reset password
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => setIsSuccess(false)}
            >
              Use a different email
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Link
            href="/admin/login"
            className="mb-8 inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to sign in
          </Link>

          <div className="mb-8">
            <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Mail className="h-6 w-6" aria-hidden="true" />
            </span>
            <h2 className="text-3xl font-semibold tracking-tight">Forgot your password?</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Enter the email associated with your administrator account to request a reset code.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Admin email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) setEmailError("");
                }}
                placeholder="admin@example.com"
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "admin-forgot-email-error" : undefined}
                className="h-11"
                required
              />
              {emailError && (
                <p id="admin-forgot-email-error" role="alert" className="text-sm text-destructive">
                  {emailError}
                </p>
              )}
            </div>
            <Button type="submit" size="lg" className="w-full" loading={isSubmitting} loadingText="Requesting code…">
              Request reset code
            </Button>
          </form>
        </>
      )}
    </AdminAuthShell>
  );
}
