"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BRAND_NAME } from "@/lib/brand";
import {
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  User,
  Lock,
  Shield,
  Settings,
  Bell,
  Search,
} from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { api } from "@/lib/admin-api";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ResponsiveNavigation } from "@/components/ResponsiveNavigation";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";
import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import {
  adminMainNavItems as mainNavItems,
  adminNavSections as navSections,
  type AdminNavItem as NavItem,
  type AdminNavSection as NavSection,
} from "@/lib/adminNavigation";

interface AdminNotification {
  id: number;
  title: string;
  message: string;
  type: string;
  category: string;
  read: boolean;
  createdAt: string;
}

const superAdminPathPrefixes = [
  "/admin/dashboard/integrations",
  "/admin/dashboard/credit-pricing",
  "/admin/dashboard/pricing-history",
  "/admin/dashboard/api-pricing",
  "/admin/dashboard/queues",
  "/admin/dashboard/storage/plans",
  "/admin/dashboard/storage/pricing",
  "/admin/dashboard/storage/users",
  "/admin/dashboard/settings/platform-access",
  "/admin/dashboard/settings/subscriptions",
  "/admin/dashboard/audit-logs",
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { admin, logout } = useAdminAuth();
  const isSuperAdmin = admin?.role === "super_admin";
  const isRestrictedPage = !isSuperAdmin && (
    superAdminPathPrefixes.some((path) => pathname === path || pathname.startsWith(`${path}/`))
    || /^\/admin\/dashboard\/users\/[^/]+\/modules(?:\/|$)/.test(pathname)
  );
  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const notifRef = useRef<HTMLDivElement>(null);
  const [adminSearchOpen, setAdminSearchOpen] = useState(false);

  const isLeadflowPage = pathname?.startsWith("/admin/dashboard/leadflow");

  // Bootstrap CSRF token on mount
  useEffect(() => {
    const fetchCsrf = async (retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          await api.get("/api/auth/csrf-token", { skipAuth: true });
          return;
        } catch {}
      }
    };
    fetchCsrf();
  }, []);

  // Auto-expand sections that contain the active route
  useEffect(() => {
    const activeSection = navSections.find((section) =>
      [...section.children, ...(section.groups || []).flatMap((group) => group.children)]
        .some((child) => pathname === child.path || pathname.startsWith(child.path + '/'))
    );
    if (activeSection && !expandedSections.includes(activeSection.label)) {
      setExpandedSections((prev) => [...prev, activeSection.label]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
    setProfileOpen(false);
  }, [pathname]);

  // Close notification dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setNotifOpen(false);
      }
    }
    if (notifOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [notifOpen]);

  // Fetch admin notifications
  const fetchNotifications = async () => {
    try {
      const data = await api.get<{ notifications: AdminNotification[]; unreadCount: number }>("/api/admin/notifications");
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // silently ignore
    }
  };

  useEffect(() => {
    fetchNotifications();
    // No polling — notifications are refreshed when the bell is opened
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await api.patch("/api/admin/notifications/read-all");
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // silently ignore
    }
  };

  const handleMarkRead = async (id: number) => {
    try {
      await api.patch(`/api/admin/notifications/${id}/read`);
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // silently ignore
    }
  };

  const toggleSection = (label: string) => {
    setExpandedSections((prev) =>
      prev.includes(label) ? prev.filter((s) => s !== label) : [...prev, label]
    );
  };

  const isActive = (path: string) => pathname === path || pathname.startsWith(path + '/');

  const isChildActive = (section: NavSection) =>
    [...section.children, ...(section.groups || []).flatMap((group) => group.children)]
      .some((child) => isActive(child.path));

  const renderNavItem = (item: NavItem) => {
    const locked = Boolean(item.superAdminOnly && !isSuperAdmin);
    const active = item.exact ? pathname === item.path : isActive(item.path);
    if (locked) {
      return (
        <div
          key={item.path}
          title={item.path.includes("/integrations") ? "Only super admins can manage system-wide provider credentials." : "Only super admins can manage this platform setting."}
          aria-label={`${item.label}. Only super admins can access this destination.`}
          aria-disabled="true"
          className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/70"
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <Lock size={12} /> Requires super admin
          </span>
        </div>
      );
    }
    return (
      <Link
        key={item.path}
        href={item.path}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
          active
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        {item.icon}
        <span>{item.label}</span>
      </Link>
    );
  };

  const renderNavSection = (section: NavSection) => {
    const expanded = expandedSections.includes(section.label);
    const hasActiveChild = isChildActive(section);

    return (
      <div key={section.label}>
        <button
          onClick={() => toggleSection(section.label)}
          aria-expanded={expanded}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
            hasActiveChild
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <div className="flex items-center gap-3">
            {section.icon}
            <span>{section.label}</span>
          </div>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {expanded && (
          <div className="ml-4 mt-1 space-y-2 border-l border-border pl-3">
            {section.children.length > 0 && (
              <div className="space-y-0.5">{section.children.map(renderNavItem)}</div>
            )}
            {section.groups?.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/65">
                  {group.label}
                </p>
                {group.children.map(renderNavItem)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Sidebar Header */}
      <div className="border-b border-sidebar-border p-4">
        <Link href="/admin/dashboard/home" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">AS</span>
          </div>
          <span className="text-lg font-semibold text-sidebar-foreground">Admin</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1">
        {mainNavItems.map(renderNavItem)}
        <div className="my-3 border-t border-sidebar-border" />
        {navSections.map(renderNavSection)}
      </nav>

      {/* Logout */}
      <div className="border-t border-sidebar-border p-3">
        <button
          onClick={logout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen max-w-full overflow-x-clip bg-background text-foreground" data-dashboard-shell="admin">
      <ResponsiveNavigation open={mobileOpen} onOpenChange={setMobileOpen} title="Admin navigation"
        desktopClassName="fixed inset-y-0 left-0 z-[var(--layer-navigation)] w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        {sidebarContent}
      </ResponsiveNavigation>

      {/* Main content area */}
      <div className="lg:pl-64">
        {/* Header */}
        <header className="sticky top-0 z-[var(--layer-header)] border-b border-border bg-background/95 backdrop-blur-xl">
          <div className="flex h-16 min-w-0 items-center justify-between gap-2 px-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <button
                onClick={() => setMobileOpen(true)}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
                aria-label="Open admin navigation"
              >
                <Menu size={20} />
              </button>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary lg:hidden">
                  <span className="text-sm font-bold text-primary-foreground">AS</span>
                </div>
                <p className="hidden truncate text-lg font-semibold text-foreground sm:block">
                  {BRAND_NAME} Admin
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={() => setAdminSearchOpen(true)}
                aria-label="Search admin pages and controls"
                aria-haspopup="dialog"
                aria-expanded={adminSearchOpen}
                className="flex h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:px-3"
              >
                <Search size={17} />
                <span className="hidden text-sm sm:inline">Search</span>
                <kbd className="hidden rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:inline">⌘ / Ctrl K</kbd>
              </button>
              <ThemeToggle />

              {/* Notifications Bell */}
              <div className="relative" ref={notifRef}>
                <button
                  onClick={() => { const next = !notifOpen; setNotifOpen(next); if (next) fetchNotifications(); }}
                  className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
                >
                  <Bell size={20} />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </button>

                {notifOpen && (
                  <div className="absolute right-0 top-full z-50 mt-2 min-w-[min(360px,calc(100vw-2rem))] max-w-[400px] rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <h3 className="text-sm font-semibold">Notifications</h3>
                      {unreadCount > 0 && (
                        <button
                          onClick={handleMarkAllRead}
                          className="text-xs font-medium text-primary hover:text-primary/80"
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    <div className="max-h-[400px] overflow-y-auto">
                      {notifications.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                          No notifications
                        </div>
                      ) : (
                        notifications.map((n) => (
                          <button
                            key={n.id}
                            onClick={() => !n.read && handleMarkRead(n.id)}
                            className={`w-full border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted ${
                              !n.read ? "bg-primary/5" : ""
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <div
                                className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                                  n.type === "error"
                                    ? "bg-destructive"
                                    : n.type === "warning"
                                    ? "bg-warning"
                                    : n.type === "success"
                                    ? "bg-success"
                                    : "bg-info"
                                }`}
                              />
                              <div className="flex-1 min-w-0">
                                <p className={`text-sm ${!n.read ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                                  {n.title}
                                </p>
                                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.message}</p>
                                <p className="mt-1 text-xs text-muted-foreground/70">
                                  {new Date(n.createdAt).toLocaleString("en-IN")}
                                </p>
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Vertical Divider */}
              <div className="mx-1 hidden h-8 w-px bg-border sm:block" />

              {/* User Profile Dropdown */}
              <DropdownMenu open={profileOpen} onOpenChange={setProfileOpen}>
                <DropdownMenuTrigger asChild>
                  <button aria-label="Admin account menu" className="flex items-center gap-1 rounded-lg py-1 pl-1 pr-1 transition-colors hover:bg-muted sm:gap-3 sm:pr-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-primary shadow-sm"><User className="h-4 w-4 text-primary-foreground" /></span>
                    <span className="hidden text-left md:block"><span className="mb-0.5 block text-sm font-medium leading-none text-foreground">{admin?.name || "Admin"}</span><span className="block text-xs leading-none text-muted-foreground">{admin?.email || ""}</span></span>
                    <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:block" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[220px]">
                  <DropdownMenuLabel><span className="block">{admin?.name || "Admin"}</span><span className="block text-xs font-normal text-muted-foreground">{admin?.email}</span></DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={event => { if (!confirmUnsavedNavigation()) { event.preventDefault(); return; } router.push("/admin/dashboard/profile"); }}><User className="mr-2 h-4 w-4" />Update Profile</DropdownMenuItem>
                  <DropdownMenuItem onSelect={event => { if (!confirmUnsavedNavigation()) { event.preventDefault(); return; } router.push("/admin/dashboard/change-password"); }}><Lock className="mr-2 h-4 w-4" />Change Password</DropdownMenuItem>
                  <DropdownMenuItem onSelect={event => { if (!confirmUnsavedNavigation()) { event.preventDefault(); return; } router.push("/admin/dashboard/settings"); }}><Settings className="mr-2 h-4 w-4" />Settings</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={event => { if (!confirmUnsavedNavigation()) { event.preventDefault(); return; } void logout(); }}><LogOut className="mr-2 h-4 w-4" />Sign Out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main id="main-content" tabIndex={-1} className={isLeadflowPage ? "min-w-0 max-w-full overflow-x-clip p-0" : "min-w-0 max-w-full overflow-x-clip px-4 py-5 sm:px-6 sm:py-6 lg:px-8"}>
          {isRestrictedPage ? (
            <div className="mx-auto flex min-h-[50vh] max-w-xl items-center justify-center">
              <div className="w-full rounded-xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
                <Shield className="mx-auto mb-4 h-10 w-10 text-primary" aria-hidden="true" />
                <h1 className="text-xl font-semibold text-foreground">Super admin access required</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  This area can change system credentials, pricing, queues, or tenant storage. Your administrator role remains read-only for these operations.
                </p>
                <Link
                  href="/admin/dashboard/home"
                  className="mt-5 inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Return to dashboard
                </Link>
              </div>
            </div>
          ) : children}
        </main>
      </div>
      <AdminCommandPalette open={adminSearchOpen} onOpenChange={setAdminSearchOpen} />
    </div>
  );
}
