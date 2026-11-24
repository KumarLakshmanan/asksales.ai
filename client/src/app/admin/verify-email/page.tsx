"use client";

import Link from "next/link";
import { CheckCircle2, LifeBuoy, LogIn } from "lucide-react";

import { AdminAuthShell } from "@/components/admin/AdminAuthShell";
import { Button } from "@/components/ui/button";

export default function VerifyEmail() {
  return (
    <AdminAuthShell
      eyebrow="Administrator provisioning"
      title="Admin access is verified when the account is created."
      description="Administrator accounts can only be provisioned by an authorized super administrator, so a separate public email-verification workflow is not required."
      highlights={[
        "A super administrator creates the account",
        "Role and access are assigned server-side",
        "Sign in with your administrator account",
      ]}
    >
      <div className="space-y-7 text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
        </span>
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight">No verification step needed</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            If your account was recently created, you can sign in now. If access is blocked, ask a super administrator to review your account.
          </p>
        </div>
        <div className="space-y-3">
          <Button asChild size="lg" className="w-full">
            <Link href="/admin/login">
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Continue to sign in
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link href="/contact">
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
              Contact support
            </Link>
          </Button>
        </div>
      </div>
    </AdminAuthShell>
  );
}
