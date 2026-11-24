"use client";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { cn } from "@/lib/utils";
import {
  supportNavigationHref,
  restoreSupportNavigationHref,
  supportRouteMemoryKey,
  parseSupportRouteMemory,
} from "@/lib/support-report";

const destinations = [
  ["chat", "Chat"],
  ["reports", "Reports"],
  ["quality", "Answer quality"],
  ["embed", "Embed"],
  ["widget-settings", "Widget settings"],
] as const;
export function SupportAiShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { user } = useAuth();
  const profiles = useBusinessProfiles();
  const memoryKey =
    user?.id && profiles.activeProfile?.id && !profiles.isLoading
      ? supportRouteMemoryKey(user.id, profiles.activeProfile.id)
      : "";
  const [memory, setMemory] = useState<{
    key: string;
    routes: Record<string, string>;
  }>({ key: "", routes: {} });
  const serializedParams = params.toString();
  useEffect(() => {
    if (!memoryKey) return;
    let routes: Record<string, string> = {};
    try {
      routes = parseSupportRouteMemory(sessionStorage.getItem(memoryKey));
    } catch {
      /* Storage may be unavailable in a private browser. */
    }
    if (
      destinations.some(
        ([route]) => pathname === `/dashboard/support-ai/${route}`,
      )
    )
      routes[pathname] = serializedParams;
    try {
      sessionStorage.setItem(memoryKey, JSON.stringify(routes));
    } catch {
      /* Navigation still works without persistence. */
    }
    setMemory({ key: memoryKey, routes });
  }, [memoryKey, pathname, serializedParams]);
  useEffect(() => {
    if (pathname === "/dashboard/support-ai")
      router.replace(
        supportNavigationHref(
          "/dashboard/support-ai/chat",
          new URLSearchParams(params.toString()),
        ),
      );
  }, [pathname, router, params]);
  return (
    <div className="flex h-[calc(100dvh-64px)] min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <nav
        aria-label="Support AI"
        className="shrink-0 border-b border-border bg-card"
      >
        <div className="mx-auto flex w-full max-w-[1440px] gap-1 overflow-x-auto px-4 py-2 sm:px-6 lg:px-8">
          {destinations.map(([route, label]) => {
            const href = `/dashboard/support-ai/${route}`;
            const active = pathname === href;
            return (
              <Link
                key={route}
                href={restoreSupportNavigationHref(
                  href,
                  new URLSearchParams(params.toString()),
                  memory.key === memoryKey ? memory.routes[href] : undefined,
                )}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
