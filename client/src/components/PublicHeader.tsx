"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronDown, LayoutDashboard, LogOut, Menu, Moon, Settings, Sun, User, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { BRAND_NAME } from "@/lib/brand";
import { comparisonLinks } from "@/lib/comparisons";

const linksBeforeCompare = [
  ["Product", "/"],
  ["Agents", "/agents"],
  ["About", "/about"],
  ["Pricing", "/pricing"],
  ["Documentation", "/documentation"],
] as const;

export default function PublicHeader() {
  const pathname = usePathname();
  const { isAuthenticated, user, logout } = useAuth();
  const { isSetupComplete, setupRedirectPath } = useSetupComplete();
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => setCompareOpen(false), [pathname]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
      if (compareRef.current && !compareRef.current.contains(event.target as Node)) setCompareOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompareOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [mobileOpen]);

  const dashboardHref = isSetupComplete ? "/dashboard/home" : (setupRedirectPath || "/setup/business-profile");
  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");

  return (
    <header className="fixed inset-x-0 top-0 z-[var(--layer-header)] border-b border-border bg-background/95 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:h-18 sm:px-8 lg:px-12">
        <Link href="/" className="flex items-center gap-2.5" aria-label={`${BRAND_NAME} home`}>
          <img src="/logos/asksales_logo.svg" alt="" className="h-8 w-8 object-contain" />
          <span className="text-base font-semibold tracking-tight">{BRAND_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Public navigation">
          {linksBeforeCompare.map(([label, href]) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={`rounded-md px-3 py-2 text-sm transition-colors ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>
                {label}
              </Link>
            );
          })}
          <div ref={compareRef} className="relative" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setCompareOpen(false);
          }}>
            <button
              type="button"
              onClick={() => setCompareOpen((open) => !open)}
              aria-expanded={compareOpen}
              aria-controls="public-compare-menu"
              className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${pathname.startsWith("/compare") ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
            >
              Compare <ChevronDown className={`h-4 w-4 transition-transform ${compareOpen ? "rotate-180" : ""}`} />
            </button>
            {compareOpen && (
              <div id="public-compare-menu" className="absolute left-0 top-full w-60 pt-2">
                <div className="rounded-lg border border-border bg-popover p-1.5 shadow-lg">
                  <Link href="/compare" onClick={() => setCompareOpen(false)} className="block rounded-md px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">All comparisons</Link>
                  <div className="my-1 border-t border-border" />
                  {comparisonLinks.map(({ name, slug }) => (
                    <Link key={slug} href={`/compare/${slug}`} onClick={() => setCompareOpen(false)} className={`block rounded-md px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${pathname === `/compare/${slug}` ? "bg-muted font-medium" : ""}`}>vs {name}</Link>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Link href="/contact" className={`rounded-md px-3 py-2 text-sm transition-colors ${pathname.startsWith("/contact") ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>Contact</Link>
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          {mounted && (
            <button type="button" onClick={toggleTheme} className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Toggle color theme">
              {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          )}
          {isAuthenticated ? (
            <div ref={profileRef} className="relative">
              <button type="button" onClick={() => setProfileOpen((open) => !open)} className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted" aria-expanded={profileOpen}>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{user?.name?.charAt(0) || "A"}</span>
                <span className="max-w-28 truncate">{user?.name?.split(" ")[0] || "Account"}</span>
              </button>
              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <div className="border-b border-border px-4 py-3">
                    <p className="truncate text-sm font-medium">{user?.name || "Account"}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{user?.email}</p>
                  </div>
                  <div className="p-1.5">
                    <Link href={dashboardHref} onClick={() => setProfileOpen(false)} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"><LayoutDashboard className="h-4 w-4" />Workspace</Link>
                    <Link href="/dashboard/user-profile" onClick={() => setProfileOpen(false)} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"><User className="h-4 w-4" />Profile</Link>
                    <Link href="/dashboard/settings" onClick={() => setProfileOpen(false)} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"><Settings className="h-4 w-4" />Settings</Link>
                    <button type="button" onClick={() => { setProfileOpen(false); logout(); }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10"><LogOut className="h-4 w-4" />Sign out</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <Link href="/login" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
              <Link href="/login?mode=register" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Create workspace</Link>
            </>
          )}
        </div>

        <button type="button" onClick={() => setMobileOpen((open) => !open)} className="flex h-10 w-10 items-center justify-center rounded-md border border-border lg:hidden" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen}>
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-x-0 top-16 z-[var(--layer-navigation)] min-h-[calc(100dvh-4rem)] border-t border-border bg-background p-5 lg:hidden">
          <nav className="divide-y divide-border border-y border-border">
            {linksBeforeCompare.map(([label, href]) => <Link key={href} href={href} className="flex min-h-12 items-center justify-between py-3 text-base font-medium">{label}<span className="font-mono text-xs text-muted-foreground">→</span></Link>)}
            <div className="py-3">
              <Link href="/compare" className="flex min-h-10 items-center justify-between text-base font-medium">Compare<span className="font-mono text-xs text-muted-foreground">→</span></Link>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 pb-1 pt-2">
                {comparisonLinks.map(({ name, slug }) => <Link key={slug} href={`/compare/${slug}`} className="min-h-11 py-2 text-sm text-muted-foreground hover:text-foreground">vs {name}</Link>)}
              </div>
            </div>
            <Link href="/contact" className="flex min-h-12 items-center justify-between py-3 text-base font-medium">Contact<span className="font-mono text-xs text-muted-foreground">→</span></Link>
          </nav>
          <div className="mt-6 grid gap-3">
            {mounted && <button type="button" onClick={toggleTheme} className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border text-sm">{resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}Change theme</button>}
            {isAuthenticated ? <Link href={dashboardHref} className="flex min-h-11 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground">Open workspace</Link> : <><Link href="/login" className="flex min-h-11 items-center justify-center rounded-md border border-border text-sm">Sign in</Link><Link href="/login?mode=register" className="flex min-h-11 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground">Create workspace</Link></>}
          </div>
        </div>
      )}
    </header>
  );
}
