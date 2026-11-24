"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { SplitAuthShell } from "@/components/auth/SplitAuthShell";

export default function ResetPassword() {
  const router = useRouter();
  const { toast } = useToast();
  const [formData, setFormData] = useState({ email: "", otp: "", newPassword: "", confirmPassword: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReset, setIsReset] = useState(false);

  useEffect(() => {
    if (!isReset) return;
    const timer = window.setTimeout(() => router.push("/login"), 2000);
    return () => window.clearTimeout(timer);
  }, [isReset, router]);

  useEffect(() => {
    const email = new URLSearchParams(window.location.search).get("email");
    if (email) setFormData((current) => ({ ...current, email }));
  }, []);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => setFormData((current) => ({ ...current, [event.target.name]: event.target.value }));
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(formData.otp)) return void toast({ title: "Enter the six-digit recovery code", variant: "destructive" });
    if (formData.newPassword !== formData.confirmPassword) return void toast({ title: "Passwords do not match", description: "Enter the same password in both fields.", variant: "destructive" });
    if (!isStrongPassword(formData.newPassword)) return void toast({ title: "Password does not meet the policy", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
    setIsSubmitting(true);
    try {
      await api.post("/api/auth/reset-password", { email: formData.email, otp: formData.otp, newPassword: formData.newPassword }, { skipAuth: true });
      setIsReset(true);
    } catch (error) {
      const rejected = error instanceof ApiError && error.status && error.status >= 400 && error.status < 500;
      toast({
        title: rejected ? "Password was not reset" : "Password reset could not be confirmed",
        description: rejected ? error.message || "The code or email is invalid." : "Try signing in with the new password. If it does not work, request another code.",
        variant: "destructive",
      });
    } finally { setIsSubmitting(false); }
  };

  return (
    <SplitAuthShell
      eyebrow="Account recovery"
      title="Replace the credential without losing your work."
      description="The recovery code confirms the request before a new password is stored for the account."
      highlights={["Confirm the recovery email", "Enter the time-limited code", "Set a new password"]}
      formWidth="md"
    >
        <section>
          {isReset ? (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-success/30 bg-success/10"><CheckCircle className="h-5 w-5 text-success" /></div>
              <h1 className="mt-6 text-2xl font-semibold tracking-tight">Password reset</h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">The new password is stored. Redirecting to sign in…</p>
              <Link href="/login" className="mt-7 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground">Continue to sign in</Link>
            </div>
          ) : (
            <>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Account recovery</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">Choose a new password</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Enter the email and six-digit code from the recovery message.</p>
              <form method="post" onSubmit={handleSubmit} className="mt-8 space-y-5">
                <div className="space-y-2"><Label htmlFor="email">Email address</Label><Input id="email" name="email" type="email" value={formData.email} onChange={handleChange} autoComplete="email" required /></div>
                <div className="space-y-2"><Label htmlFor="otp">Recovery code</Label><Input id="otp" name="otp" value={formData.otp} onChange={handleChange} maxLength={6} inputMode="numeric" minLength={6} pattern="[0-9]{6}" autoComplete="one-time-code" className="font-mono tracking-[0.25em]" required /></div>
                <div className="space-y-2"><Label htmlFor="newPassword">New password</Label><PasswordInput id="newPassword" name="newPassword" value={formData.newPassword} onChange={handleChange} autoComplete="new-password" required /></div>
                <div className="space-y-2"><Label htmlFor="confirmPassword">Confirm password</Label><PasswordInput id="confirmPassword" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} autoComplete="new-password" required /></div>
                <p className="text-xs leading-5 text-muted-foreground">{PASSWORD_POLICY_MESSAGE}</p>
                <Button type="submit" disabled={isSubmitting} className="h-11 w-full gap-2">{isSubmitting ? "Resetting…" : "Reset password"}{!isSubmitting && <ChevronRight className="h-4 w-4" />}</Button>
              </form>
              <div className="mt-8 flex items-center justify-between border-t border-border pt-6 text-sm"><Link href="/login" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Sign in</Link><Link href="/forgot-password" className="text-primary hover:underline">Request another code</Link></div>
            </>
          )}
        </section>
    </SplitAuthShell>
  );
}
