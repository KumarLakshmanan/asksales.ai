"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import SupportHeader from "@/components/SupportHeader";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { supportNavSections, supportBottomNavItems, type NavItem, type NavSection } from "@/lib/supportSidebarConfig";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { cn } from "@/lib/utils";
import { supportApi } from "@/lib/support-api";
import { ResponsiveNavigation } from "@/components/ResponsiveNavigation";
import { PageLoadingState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { SESSION_CARD_RECHECK_MS } from "@/lib/sessionCheckRetry";

export function SupportDashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading, error, checkAuth } = useSupportAuth();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ tickets: true });

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (!isLoading && !isAuthenticated && !error) {
      router.push("/support/login");
    }
  }, [error, isAuthenticated, isLoading, router]);

  // Bootstrap CSRF token on mount
  useEffect(() => {
    void supportApi.get("/api/auth/csrf-token", { skipAuth: true }).catch(() => {});
  }, []);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Keep checking during a longer outage so the portal opens once the server recovers.
  useEffect(() => {
    if (!error || isLoading) return;
    const timer = window.setTimeout(() => { void checkAuth(); }, SESSION_CARD_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [error, isLoading, checkAuth]);

  if (isLoading) {
    return <main id="main-content" tabIndex={-1}><PageLoadingState label="Checking your support session…" /></main>;
  }

  if (error) return <main id="main-content" tabIndex={-1} className="flex min-h-svh items-center justify-center p-6">
    <section role="alert" className="max-w-lg space-y-4 rounded-xl border bg-card p-6 text-center">
      <h1 className="text-xl font-semibold">Support portal could not be checked</h1><p>{error}</p>
      <p className="text-sm text-muted-foreground">We will keep checking automatically.</p>
      <Button onClick={() => void checkAuth()}>Try again</Button>
    </section>
  </main>;

  if (!isAuthenticated) return null;

  const toggleSection = (sectionId: string) =>
    setExpandedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));

  const isBroadActive = (path: string) =>
    pathname === path || pathname.startsWith(path + "/");

  const isSectionActive = (section: NavSection) =>
    isBroadActive(section.activePath) || section.activeExtraPaths?.some((p: string) => isBroadActive(p)) || false;

  const renderSection = (section: NavSection) => {
    const sectionActive = isSectionActive(section);

    if (section.children.length === 0) {
      return (
        <div key={section.section}>
          <Link
            href={section.collapsedPath}
            aria-current={sectionActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              sectionActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <div className={cn("flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center",
              sectionActive ? "bg-primary/15 text-primary" : "text-muted-foreground"
            )}>
              {section.icon}
            </div>
            <span className="truncate">{section.label}</span>
          </Link>
        </div>
      );
    }

    return (
      <div key={section.section}>
        <button
          onClick={() => toggleSection(section.section)}
          aria-expanded={!!expandedSections[section.section]}
          className={cn(
            "w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
            sectionActive ? "bg-primary/5 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={cn("flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center",
              sectionActive ? "bg-primary/15 text-primary" : "text-muted-foreground"
            )}>
              {section.icon}
            </div>
            <span className="truncate">{section.label}</span>
          </div>
          <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground/50 transition-transform flex-shrink-0",
            expandedSections[section.section] && "rotate-180"
          )} />
        </button>
        {expandedSections[section.section] && (
          <div className="mt-0.5 ml-4 pl-4 border-l border-border/40 space-y-0.5 py-0.5">
            {section.children.map((item: NavItem) => {
              const itemActive = isBroadActive(item.path);
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  aria-current={pathname === item.path ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                    itemActive ? "text-primary font-medium bg-primary/5" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  <div className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0",
                    itemActive ? "bg-primary" : "bg-muted-foreground/30"
                  )} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen max-w-full flex-col overflow-x-clip bg-background text-foreground" data-dashboard-shell="support">
      <SupportHeader
        onSidebarOpen={() => {
          setSidebarOpen(true);
          setMobileSidebarOpen(true);
        }}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden bg-background pt-[72px]">
        {/* Sidebar */}
        <ResponsiveNavigation open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen} title="Support navigation"
          desktopClassName={cn("relative z-[var(--layer-navigation)] h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground", sidebarOpen ? "w-[240px]" : "w-[52px]")}>
          {sidebarOpen ? (
            <>
              <nav aria-label="Primary navigation" className="flex-1 min-h-0 p-3 space-y-0.5 text-sm overflow-y-auto overflow-x-hidden">
                {supportNavSections.map((section) => renderSection(section))}
                <div className="pt-3 mt-2 border-t border-border/30 space-y-0.5">
                  {supportBottomNavItems.map((item) => (
                    <div key={item.path}>
                      <Link
                        href={item.path}
                  aria-current={pathname === item.path ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                          isBroadActive(item.path)
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <div className={cn("flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center",
                          isBroadActive(item.path) ? "bg-primary/15 text-primary" : "text-muted-foreground"
                        )}>
                          {item.icon}
                        </div>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </div>
                  ))}
                </div>
              </nav>
              <div className="flex-shrink-0 border-t border-border/30 p-2">
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <PanelLeftClose className="w-4 h-4 flex-shrink-0" />
                  <span>Collapse</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <nav aria-label="Primary navigation" className="flex-1 min-h-0 p-2 space-y-0.5 overflow-y-auto overflow-x-hidden">
                {supportNavSections.map((section) => (
                  <Link
                    key={section.section}
                    href={section.collapsedPath}
                    className={cn(
                      "flex items-center justify-center p-2 rounded-lg transition-colors",
                      isSectionActive(section)
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    title={section.label}
                  >
                    {section.collapsedIcon}
                  </Link>
                ))}
              </nav>
              <div className="flex-shrink-0 border-t border-border/30 p-2">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="w-full flex items-center justify-center p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  title="Expand sidebar"
                >
                  <PanelLeftOpen className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </ResponsiveNavigation>

        {/* Main Content */}
        <main id="main-content" tabIndex={-1} className={cn(
          "relative min-w-0 max-w-full flex-1 self-stretch overflow-x-hidden overflow-y-auto bg-background",
          pathname === "/support/chat" ? "" : "px-4 py-5 sm:px-6 lg:px-8 lg:py-7"
        )}>
          {children}
        </main>
      </div>

    </div>
  );
}
