"use client";

import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  KeyRound,
  Lock,
  Plug,
  ScrollText,
  Settings,
  Webhook,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAdminAuth } from "@/contexts/AdminAuthContext";

const SETTINGS_AREAS = [
  { title: "Subscriptions", description: "Provision plans, verify recurring payments, monitor credit deposits and launch access requirements.", href: "/admin/dashboard/settings/subscriptions", superAdminOnly: true, icon: KeyRound, tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  {
    title: "Platform Access",
    description: "Control global maintenance, module readiness, and server-enforced customer availability.",
    href: "/admin/dashboard/settings/platform-access",
    superAdminOnly: true,
    icon: Wrench,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    title: "Provider Integrations",
    description: "Configure system-wide API providers and verify credential health.",
    href: "/admin/dashboard/integrations",
    superAdminOnly: true,
    icon: Plug,
    tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  {
    title: "Credit & API Pricing",
    description: "Set recharge rates, provider costs, and model margins used for customer credits.",
    href: "/admin/dashboard/credit-pricing#api-pricing",
    superAdminOnly: true,
    icon: KeyRound,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    title: "Webhook Delivery",
    description: "Inspect webhook delivery attempts, failures, and retained payload metadata.",
    href: "/admin/dashboard/webhook-logs",
    superAdminOnly: false,
    icon: Webhook,
    tone: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
  },
  {
    title: "Queue Operations",
    description: "Monitor background jobs and identify delayed or failed processing.",
    href: "/admin/dashboard/queues",
    superAdminOnly: true,
    icon: Activity,
    tone: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  {
    title: "System Logs",
    description: "Review operational events and errors recorded by the platform.",
    href: "/admin/dashboard/system-logs",
    superAdminOnly: false,
    icon: ScrollText,
    tone: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  },
] as const;

export default function AdminSettingsPage() {
  const router = useRouter();
  const { admin } = useAdminAuth();
  const isSuperAdmin = admin?.role === "super_admin";

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.back()}
          className="mt-0.5 shrink-0"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Settings className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Administration Settings</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Open the authoritative controls for providers, delivery, and platform operations. Personal profile and password actions are in the account menu.
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SETTINGS_AREAS.map((area) => {
          const Icon = area.icon;
          const locked = area.superAdminOnly && !isSuperAdmin;
          return (
            <Card key={area.href} className={`border-border/60 bg-card shadow-none transition-colors ${locked ? "" : "hover:border-primary/40"}`}>
              <CardContent className="flex h-full flex-col p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${area.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  {locked && <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" />Super admin</span>}
                </div>
                <h2 className="text-sm font-semibold">{area.title}</h2>
                <p className="mt-1 flex-1 text-sm leading-relaxed text-muted-foreground">{area.description}</p>
                <Button
                  variant="ghost"
                  className="mt-4 h-9 justify-between px-2 text-sm"
                  disabled={locked}
                  aria-label={locked ? `${area.title}. Super admin access required.` : `Open ${area.title} settings`}
                  onClick={() => { if (!locked) router.push(area.href); }}
                >
                  {locked ? <>Super admin access required <Lock className="h-4 w-4" /></> : <>Open settings <ArrowRight className="h-4 w-4" /></>}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
