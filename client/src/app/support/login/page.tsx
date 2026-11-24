"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Headset, ChevronRight
} from "lucide-react";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi, ApiError } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { SplitAuthShell } from "@/components/auth/SplitAuthShell";

export default function SupportLoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { login, isAuthenticated } = useSupportAuth();
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isAuthenticated) router.push("/support/tickets");
  }, [isAuthenticated, router]);

  // Bootstrap CSRF token on mount
  useEffect(() => {
    void supportApi.get("/api/auth/csrf-token", { skipAuth: true }).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const data = await supportApi.post<{ member: { id: number; name: string; email: string; role: string; teamId: number; teamName: string | null; isActive: boolean; avatar?: string } }>(
        "/api/support-portal/login",
        formData,
        { skipAuth: true }
      );
      login(data.member);
      toast({ title: "Welcome Back!", description: "Support portal login successful." });
      router.push("/support/tickets");
    } catch (error) {
      if (error instanceof ApiError) {
        toast({ title: "Access Denied", description: error.message || "Invalid credentials", variant: "destructive" });
      } else {
        toast({ title: "Technical Error", description: "Failed to connect to support servers.", variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  return (
    <SplitAuthShell
      eyebrow="Support operations"
      title="Resolve the queue with context, ownership, and receipts."
      description="Claim handoffs, review customer history, and use knowledge-grounded assistance without sending anything automatically."
      highlights={["Member-scoped access", "Visible queue and SLA state", "On-demand, grounded assistance"]}
      icon={Headset}
      brandLabel="AskSales Support"
    >
          <div className="mb-8">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Member access</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="mt-2 text-sm text-muted-foreground">Continue to the support operations workspace.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="email" className="text-xs font-medium">Work email</label>
              <Input id="email" name="email" type="email" value={formData.email} onChange={handleChange} placeholder="agent@company.com" autoComplete="email" required className="h-11" />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-xs font-medium">Password</label>
              <PasswordInput id="password" name="password" value={formData.password} onChange={handleChange} autoComplete="current-password" required className="h-11" />
            </div>

            <Button type="submit" disabled={isSubmitting} className="h-11 w-full gap-2" aria-busy={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
              {!isSubmitting && <ChevronRight className="h-4 w-4" />}
            </Button>
          </form>

          <p className="mt-8 border-t border-border pt-6 text-center text-xs text-muted-foreground">Authorized support staff only</p>
    </SplitAuthShell>
  );
}
