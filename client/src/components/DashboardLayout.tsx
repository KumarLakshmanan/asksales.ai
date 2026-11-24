"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import Header from "@/components/Header";
import {
  Plus,
  Eye,
  Home,
  PanelLeftClose,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { availableNavigationSections, bottomNavItems, activeNavigationSection, navigationItemActive, navigationItemHref, type NavSection } from "@/lib/sidebarConfig";
import { BRAND_NAME } from "@/lib/brand";
import { PageLoadingState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { type PlatformModuleKey } from "@/lib/platform-access";
import { BusinessProfileSwitcher } from "@/components/BusinessProfileSwitcher";
import { SidebarMenuGroup } from "@/components/SidebarMenuGroup";
import { SidebarWorkspaceSection } from "@/components/SidebarWorkspaceSection";
import { useAuth } from "@/contexts/AuthContext";
import { useSidebarPreferences } from "@/hooks/use-sidebar-preferences";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";

interface SidebarCampaign {
  id: number;
  title: string | null;
}

export function DashboardLayout({ children, enabledModules }: { children: React.ReactNode; enabledModules: PlatformModuleKey[] }) {
  const location = usePathname();
  const query = useSearchParams();
  const { activeProfile, isLoading: profilesLoading, isError: profilesError, refetch: refetchProfiles } = useBusinessProfiles();
  const usesPageLevelBreadcrumbs = location.startsWith("/dashboard/saved-templates/");
  const usesFixedCreatorWorkspace = /^\/dashboard\/saved-templates\/[^/]+\/generate\/?$/.test(location);
  const usesFixedOutreachWorkspace = /^\/dashboard\/outreach\/(?:inbox|email|facebook|instagram|linkedin|sms|twitter|whatsapp)\/?$/.test(location);
  const usesFixedConversationWorkspace = location.startsWith("/dashboard/conversations");
  const usesFixedWorkspace = usesFixedCreatorWorkspace || usesFixedOutreachWorkspace || usesFixedConversationWorkspace;
  const mainContentRef = useRef<HTMLElement>(null);
  const { user } = useAuth();
  const enabledModuleSet = new Set(enabledModules);
  const verifiedWorkspaceRole = !profilesLoading && !profilesError ? activeProfile?.role : undefined;
  const visibleNavSections = availableNavigationSections(enabledModules, verifiedWorkspaceRole);
  const activeSection = activeNavigationSection(location, visibleNavSections);
  const activeSectionId = activeSection?.section;
  const { sidebarOpen, setSidebarOpen, sectionOpen, setSectionOpen } = useSidebarPreferences(user?.id, location, activeSectionId);
  const sidebarRef = useRef<HTMLElement>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebar, setDesktopSidebar] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktopSidebar(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const sidebarVisible = desktopSidebar ? sidebarOpen : mobileSidebarOpen;
  const touchStartX = useRef<number | null>(null);
  // Keep operational destinations ahead of history, even for accounts that
  // previously saved an expanded Campaigns section. Leave page-finder order intact.
  const primaryWorkspaces = new Set(["lead-agent", "content-agent", "crm", "support"]);
  const sidebarSections = [
    ...visibleNavSections.filter(section => primaryWorkspaces.has(section.section)),
    ...visibleNavSections.filter(section => !primaryWorkspaces.has(section.section)),
  ];
  const visibleBottomNavItems = bottomNavItems.filter((item) =>
    item.path === "/dashboard/billing"
      ? enabledModuleSet.has("billing")
      : item.path === "/dashboard/insights"
        ? ["billing", "outreach", "support", "crm"].some((module) => enabledModuleSet.has(module as PlatformModuleKey))
      : item.path === "/dashboard/storage"
        ? enabledModuleSet.has("storage")
        : true,
  );

  // Swipe gestures: right to open, left to close (mobile only)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta > 50 && !mobileSidebarOpen) {
      setSidebarOpen(true);
      setMobileSidebarOpen(true);
    }
    if (delta < -50 && mobileSidebarOpen) setMobileSidebarOpen(false);
    touchStartX.current = null;
  }, [mobileSidebarOpen, setSidebarOpen, setMobileSidebarOpen]);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location]);

  useEffect(() => {
    if (!sidebarVisible) return;
    const navigation = sidebarRef.current?.querySelector('nav[aria-label="Primary navigation"]');
    if (!navigation) return;
    let frame: number | undefined;
    let stopped = false;
    let revealedWorkspace = false;
    const interactions = ["wheel", "touchmove", "pointerdown", "keydown", "click"] as const;

    function stop() {
      stopped = true;
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      interactions.forEach(event => navigation!.removeEventListener(event, stop));
    }
    function revealCurrent() {
      if (stopped || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const page = navigation!.querySelector<HTMLElement>('[aria-current="page"]');
        if (page && !page.closest('details:not([open]), [hidden]')) {
          page.scrollIntoView({ block: "nearest" });
          stop();
        } else if (!revealedWorkspace) {
          const workspace = navigation!.querySelector<HTMLElement>('[aria-current="location"]');
          if (workspace) {
            workspace.scrollIntoView({ block: "nearest" });
            revealedWorkspace = true;
          }
        }
      });
    }
    // Threads and role-gated links can arrive after the first frame. Reveal the
    // page once, then stop observing; user interaction cancels a pending reveal.
    const observer = new MutationObserver(revealCurrent);
    observer.observe(navigation, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current", "open", "hidden"] });
    interactions.forEach(event => navigation.addEventListener(event, stop, { passive: true }));
    revealCurrent();
    return stop;
  }, [location, sidebarVisible, user?.id]);

  useEffect(() => {
    if (!usesFixedWorkspace) return;

    const mainContent = mainContentRef.current;
    if (!mainContent) return;

    const resetWorkspaceScroll = () => {
      mainContent.scrollTop = 0;
      mainContent.scrollLeft = 0;
    };

    resetWorkspaceScroll();
    const frame = requestAnimationFrame(resetWorkspaceScroll);
    return () => cancelAnimationFrame(frame);
  }, [location, usesFixedWorkspace]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;

    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const navigation = sidebarRef.current;
    const controls = () => Array.from(navigation?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),summary,[tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!navigation?.contains(document.activeElement)) return;
      if (event.key === "Escape") { event.preventDefault(); setMobileSidebarOpen(false); }
      if (event.key === "Tab") {
        const elements = controls();
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      previousFocus?.focus();
    };
  }, [mobileSidebarOpen]);

  // Chat threads follow the selected business profile.
  const { data: threadsData, isLoading: loadingThreads, isError: threadsError, refetch: refetchThreads } = useQuery({
    queryKey: ['chat-threads', activeProfile?.id],
    queryFn: () => api.get<{ threads: SidebarCampaign[] }>(`/api/chat/threads?limit=10&view=compact&businessProfileId=${activeProfile!.id}`),
    enabled: enabledModuleSet.has("campaigns") && Boolean(activeProfile),
    staleTime: 30_000,
  });
  const chatThreads = threadsData?.threads ?? [];

  // Check if a path is active (restricted for items to avoid overlap)
  const isItemActive = (path: string) => navigationItemActive(location, path, sidebarSections);

  // Check if a path starts with (broad match for sections)
  const isBroadActive = (path: string) => {
    if (location === path) return true;
    return location.startsWith(path + "/");
  };
  const isExactActive = (path: string) => location === path;

  // Check if section is active (broad match)
  const isSectionActive = (section: NavSection) => {
    return section.section === activeSectionId;
  };

  // Render a generic collapsible section from config
  const renderSection = (section: NavSection) => {
    const sectionActive = isSectionActive(section);

    if (section.presentation === "group") {
      return <SidebarMenuGroup key={section.section} section={section} isItemActive={isItemActive} expanded={sectionOpen(section.section, true)} onExpandedChange={open => setSectionOpen(section.section, open)} itemOpen={path => sectionOpen(path, isItemActive(path))} onItemOpenChange={(path, open) => setSectionOpen(path, open)} />;
    }

    // If no children, render as a direct link
    if (section.children.length === 0) {
      return (
        <div key={section.section}>
          <Link
            href={section.collapsedPath}
            aria-current={sectionActive ? "page" : undefined}
            className={`group flex min-h-10 w-full items-center justify-between gap-3 rounded-[9px] px-2.5 py-2 text-sm font-medium transition-colors ${
              sectionActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className={`flex h-7 w-7 items-center justify-center transition-colors ${sectionActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`}>
                {section.icon && React.isValidElement(section.icon) 
                  ? React.cloneElement(section.icon as React.ReactElement<{ className?: string }>, { className: "w-3.5 h-3.5" }) 
                  : section.icon}
              </div>
              <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>
            </div>
          </Link>
        </div>
      );
    }

    return (
      <SidebarWorkspaceSection key={section.section} section={section} active={sectionActive} expanded={sectionOpen(section.section, sectionActive)} onExpandedChange={open => setSectionOpen(section.section, open)}>
          {section.children.map((item) => {
            const itemActive = isItemActive(item.path);

            return (
              <Link
                key={item.path}
                href={navigationItemHref(item, query)}
                aria-current={itemActive ? "page" : undefined}
                className={`group/item flex min-h-9 items-center gap-3 rounded-r-[8px] px-3 py-1.5 text-[13px] transition-colors ${
                  itemActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                }`}
              >
                <div aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${itemActive ? 'bg-primary' : 'bg-muted-foreground/25 group-hover/item:bg-muted-foreground/50'}`} />
                <span className="min-w-0 text-sm">{item.label}</span>
              </Link>
            );
          })}
      </SidebarWorkspaceSection>
    );
  };

  return (
    <div
      className="flex h-[100dvh] max-w-full flex-col overflow-x-clip bg-background text-foreground"
      data-dashboard-shell="user"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header */}
      <Header
        enabledModules={enabledModules}
        sidebarOpen={sidebarOpen}
        workspaceName={activeProfile ? (activeProfile.companyName || activeProfile.businessName || activeProfile.name || "Workspace") : undefined}
        onSidebarOpen={() => {
          setSidebarOpen(true);
          setMobileSidebarOpen(true);
        }}
      />

      <div className={`flex min-h-0 flex-1 overflow-hidden bg-background pt-16 ${sidebarOpen ? "lg:pl-64" : ""}`}>
        {/* Sidebar */}
        <aside
          ref={sidebarRef}
          aria-hidden={!sidebarVisible}
          inert={!sidebarVisible}
          role={mobileSidebarOpen && !desktopSidebar ? "dialog" : undefined}
          aria-modal={mobileSidebarOpen && !desktopSidebar ? true : undefined}
          aria-label="Dashboard navigation"
          data-sidebar-state={sidebarOpen ? "open" : "hidden"}
          className={`fixed inset-y-0 left-0 z-[var(--layer-navigation)] flex h-dvh w-64 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"} ${sidebarOpen ? "lg:translate-x-0" : "lg:-translate-x-full"}`}
        >
          {sidebarOpen ? (
            <>
          <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
            <Link href="/dashboard/home" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-sidebar-border bg-background p-1.5">
                <Image src="/logos/asksales_logo.svg" alt="" width={28} height={28} className="h-full w-full object-contain" />
              </span>
              <span className="text-[17px] font-semibold tracking-[-0.03em]">{BRAND_NAME}</span>
            </Link>
          </div>
          <div className="shrink-0 border-b border-sidebar-border px-3 pb-3 pt-3">
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Workspace</p>
            <BusinessProfileSwitcher />
          </div>
          {/* Navigation - Scrollable section */}
          <nav aria-label="Primary navigation" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2.5 py-3 text-sm">

            <Link href="/dashboard/home" aria-current={isExactActive("/dashboard/home") ? "page" : undefined} className={`group flex min-h-10 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isExactActive("/dashboard/home") ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}>
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center"><Home className="h-3.5 w-3.5" /></span>
              <span>Home</span>
            </Link>

            {sidebarSections.map((section) => {
              // Campaign history has special rendering (dynamic threads).
              if (section.section === "campaigns") {
                return (
                  <SidebarWorkspaceSection key="campaigns" section={section} active={isSectionActive(section)} expanded={sectionOpen("campaigns", isSectionActive(section))} onExpandedChange={open => setSectionOpen("campaigns", open)}>
                        <Link
                          href="/dashboard/conversations"
                          aria-current={isExactActive("/dashboard/conversations") || isExactActive("/dashboard/chat") ? "page" : undefined}
                          className={`group/item flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                            isExactActive("/dashboard/conversations") || isExactActive("/dashboard/chat")
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                          }`}
                        >
                          <Plus className="w-3 h-3 flex-shrink-0" />
                          <span>{section.children[0].label}</span>
                        </Link>

                        {loadingThreads ? (
                          // Text, not grey bars: placeholder bars in a nav list read as broken links.
                          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading recent campaigns…</p>
                        ) : threadsError ? (
                          <button type="button" onClick={() => void refetchThreads()} className="px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
                            Campaigns unavailable · Retry
                          </button>
                        ) : chatThreads.length > 0 ? (
                          chatThreads.map((thread) => (
                            <Link
                              key={thread.id}
                              href={`/dashboard/conversations/${thread.id}`}
                              aria-current={isBroadActive(`/dashboard/conversations/${thread.id}`) || isBroadActive(`/dashboard/chat/${thread.id}`) ? "page" : undefined}
                              title={thread.title || `Campaign ${thread.id}`}
                              className={`group/item flex min-w-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                                isBroadActive(`/dashboard/conversations/${thread.id}`) || isBroadActive(`/dashboard/chat/${thread.id}`)
                                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                              }`}
                            >
                              <div aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${isBroadActive(`/dashboard/conversations/${thread.id}`) || isBroadActive(`/dashboard/chat/${thread.id}`) ? 'bg-primary' : 'bg-muted-foreground/25 group-hover/item:bg-muted-foreground/50'}`} />
                              <span className="min-w-0 flex-1 truncate">{thread.title || `Campaign ${thread.id}`}</span>
                            </Link>
                          ))
                        ) : (
                          <p className="px-3 py-2 text-xs text-muted-foreground">No campaigns for this profile</p>
                        )}

                        <Link
                            href="/dashboard/chats"
                            aria-current={isItemActive("/dashboard/chats") ? "page" : undefined}
                            className={`group/item flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                              isItemActive("/dashboard/chats")
                                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                            }`}
                          >
                            <Eye className="w-3 h-3 flex-shrink-0" />
                            <span>{section.children[1].label}</span>
                        </Link>
                  </SidebarWorkspaceSection>
                );
              }

              // All other sections use generic config-driven rendering
              return renderSection(section);
            })}

            {/* Bottom nav items (non-collapsible flat links) */}
            <div className="mt-2 space-y-0.5 border-t border-sidebar-border pt-2">
              {visibleBottomNavItems.map((item) => (
                <div key={item.path}>
                  <Link
                    href={item.path}
                    aria-current={isBroadActive(item.path) ? "page" : undefined}
                    className={`group flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      isBroadActive(item.path)
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className={`flex h-7 w-7 items-center justify-center transition-colors ${isBroadActive(item.path) ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`}>
                        {item.icon && React.isValidElement(item.icon)
                          ? React.cloneElement(item.icon as React.ReactElement<{ className?: string }>, { className: "w-3.5 h-3.5" })
                          : item.icon}
                      </div>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </div>
                  </Link>
                </div>
              ))}
            </div>

          </nav>

          {/* Collapse toggle at bottom of sidebar - Fixed at bottom */}
          <div className="flex-shrink-0 border-t border-sidebar-border p-2.5">
            <button
              onClick={() => {
                setSidebarOpen(false);
                setMobileSidebarOpen(false);
              }}
              className="flex min-h-10 w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              <PanelLeftClose className="h-4 w-4 flex-shrink-0" />
              <span>Hide sidebar</span>
            </button>
          </div>
            </>
          ) : null}
        </aside>

        {/* Main Content */}
        <main
          ref={mainContentRef}
          id="main-content" tabIndex={-1}
          className={`relative min-w-0 max-w-full flex-1 self-stretch overflow-x-hidden bg-background ${usesFixedWorkspace ? "overflow-y-hidden" : "overflow-y-auto"}`}
        >
          {!usesPageLevelBreadcrumbs && !(location.includes("/dashboard/chat") ||
            location.includes("/dashboard/leadflow") ||
            location.startsWith("/dashboard/outreach/") ||
            location.startsWith("/dashboard/conversations") ||
            location.startsWith("/dashboard/support-ai")) && <Breadcrumbs />}
          {profilesLoading ? (
            <PageLoadingState label="Loading your business profile…" />
          ) : profilesError || !activeProfile ? (
            <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-muted-foreground">Your business profile could not be loaded.</p>
              <Button variant="outline" onClick={() => void refetchProfiles()}>Try again</Button>
            </div>
          ) : (
            <ErrorBoundary key={activeProfile.id} section="Dashboard">
              {children}
            </ErrorBoundary>
          )}
        </main>
      </div>

      {/* Overlay for mobile */}
      {mobileSidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-[var(--layer-navigation-backdrop)] cursor-default border-0 bg-foreground/40 p-0 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close dashboard navigation"
        />
      )}
    </div>
  );
}
