import Image from "next/image";
import Link from "next/link";
import { Bell, User, Lock, LogOut, CheckCircle, AlertCircle, Info, MessageSquare, Search, Command, Settings, Menu, Coins, BookOpen } from "lucide-react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { announceNotificationChange, NOTIFICATIONS_CHANGED } from "@/lib/notification-changes";
import { useAuth } from "@/contexts/AuthContext";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useWebSocket } from "@/contexts/WebSocketContext";
import type { PlatformModuleKey } from "@/lib/platform-access";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";
import { selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";
import { BRAND_NAME } from "@/lib/brand";
import { DOCUMENTATION_ROOT, documentationHrefForPath } from '@/lib/documentation-navigation';

interface Notification {
  id: number;
  type: 'success' | 'warning' | 'info' | 'message';
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  actionUrl: string | null;
}

interface NotificationListResponse {
  items: Notification[];
  unreadCount: number;
}

interface HeaderProps {
  onSidebarOpen?: () => void;
  sidebarOpen?: boolean;
  enabledModules?: PlatformModuleKey[];
  workspaceName?: string;
}

export default function Header({ onSidebarOpen, sidebarOpen = true, enabledModules, workspaceName }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const organizations = useBillingOrganizations();
  const businessId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const billingView = pathname.startsWith("/dashboard/billing");
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const countRequest = useRef<AbortController | null>(null);
  const countRefresh = useRef<{ controller: AbortController; promise: Promise<void>; refreshAgain: boolean } | null>(null);
  const streamInterrupted = useRef(false);
  const countGeneration = useRef(0);
  const pendingReads = useRef(new Set<number>());
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { isAuthenticated, user, logout } = useAuth();
  const { subscribe } = useWebSocket();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const pageSearchTrigger = useRef<HTMLButtonElement>(null);
  const { data: balanceData } = useQuery({
    queryKey: ["wallet-balance", user?.id, businessId, organizations.billingScopeKey],
    queryFn: () => api.get<{ balance: number }>("/api/wallet", { headers: businessId ? { "X-Business-Profile-Id": String(businessId) } : {} }),
    enabled: isAuthenticated && Boolean(enabledModules?.includes("billing")) && (!billingView || organizations.ready),
    staleTime: 30_000,
    // Agent work spends credits on the server with no push event, so keep the
    // badge current while the user stays on one page.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const fetchUnreadCount = useCallback((freshAfterCurrent = true): Promise<void> => {
    const active = countRefresh.current;
    if (active && !active.controller.signal.aborted) {
      // Initial socket open can share the mount read. Later invalidations need
      // a read started after the event, without cancelling the current body.
      if (freshAfterCurrent) active.refreshAgain = true;
      return active.promise;
    }
    const controller = new AbortController();
    countRequest.current = controller;
    const generation = ++countGeneration.current;
    const pending = { controller, promise: Promise.resolve(), refreshAgain: false };
    countRefresh.current = pending;
    pending.promise = (async () => {
      do {
        pending.refreshAgain = false;
        try {
          const data = await api.get<{ count: number }>("/api/notifications/unread/count", { signal: controller.signal });
          if (!controller.signal.aborted && generation === countGeneration.current) setUnreadCount(data.count || 0);
        } catch {
          // Preserve the last known count; queued refreshes and retries survive.
        }
      } while (pending.refreshAgain && !controller.signal.aborted);
    })().finally(() => {
      if (countRefresh.current === pending) countRefresh.current = null;
      if (countRequest.current === controller) countRequest.current = null;
    });
    return pending.promise;
  }, []);

  const fetchNotifications = useCallback(async () => {
    listRequest.current?.abort();
    countRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const generation = ++countGeneration.current;
    setNotificationsLoading(true);
    setNotificationsError(false);
    try {
      const data = await api.get<NotificationListResponse>("/api/notifications?limit=5", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setNotifications(data.items || []);
      setNotificationsLoaded(true);
      if (generation === countGeneration.current) setUnreadCount(data.unreadCount || 0);
    } catch {
      if (!controller.signal.aborted) setNotificationsError(true);
    } finally {
      if (!controller.signal.aborted) setNotificationsLoading(false);
    }
  }, []);

  useEffect(() => {
    streamInterrupted.current = false;
    setNotifications([]);
    setNotificationsLoaded(false);
    setNotificationsLoading(false);
    setNotificationsError(false);
    setUnreadCount(0);
    if (isAuthenticated) {
      void fetchUnreadCount();
    }
    return () => { listRequest.current?.abort(); countRequest.current?.abort(); };
  }, [isAuthenticated, user?.id, businessId, fetchUnreadCount]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () => { void (notificationsOpen ? fetchNotifications() : fetchUnreadCount()); };
    const visibleRefresh = () => { if (document.visibilityState === 'visible') refresh(); };
    const storageRefresh = (event: StorageEvent) => { if (event.key === NOTIFICATIONS_CHANGED) refresh(); };
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    window.addEventListener('storage', storageRefresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const unsubscribeNotification = subscribe("events:notification", refresh);
    const unsubscribeDisconnected = subscribe("websocket_disconnected", () => { streamInterrupted.current = true; });
    const unsubscribeReconnect = subscribe("websocket_connected", () => {
      const needsFreshRead = streamInterrupted.current;
      streamInterrupted.current = false;
      void (notificationsOpen ? fetchNotifications() : fetchUnreadCount(needsFreshRead));
    });
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      window.removeEventListener('storage', storageRefresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
      unsubscribeNotification();
      unsubscribeDisconnected();
      unsubscribeReconnect();
    };
  }, [fetchNotifications, fetchUnreadCount, isAuthenticated, notificationsOpen, subscribe]);

  const markAsRead = async (id: number) => {
    if (pendingReads.current.has(id)) return;
    pendingReads.current.add(id);
    try {
      await api.put(`/api/notifications/${id}/read`, {});
    } catch { /* The response may be lost after commit; always reconcile. */ }
    finally { pendingReads.current.delete(id); announceNotificationChange(); }
  };

  const openNotification = (notification: Notification) => {
    if (!notification.read) void markAsRead(notification.id);
    if (notification.actionUrl && /^\/dashboard(?:\/|$)/.test(notification.actionUrl) && !notification.actionUrl.includes("\\")) {
      setNotificationsOpen(false);
      if (confirmUnsavedNavigation()) router.push(notification.actionUrl);
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'success': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'warning': return <AlertCircle className="w-4 h-4 text-yellow-500" />;
      case 'message': return <MessageSquare className="w-4 h-4 text-blue-500" />;
      default: return <Info className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  };

  return (
    <header
      className={`fixed inset-x-0 top-0 z-[var(--layer-header)] flex h-16 items-center border-b border-border bg-background/95 backdrop-blur-md ${sidebarOpen ? "lg:left-64" : ""}`}
      data-testid="header"
    >
      <div className="flex h-full w-full min-w-0 items-center gap-1 px-2 sm:gap-2 sm:px-4">
        {/* Left Section: Apps Grid + Logo */}
        <div className="flex min-w-0 shrink items-center gap-1 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`h-11 w-11 rounded-lg ${sidebarOpen ? "lg:hidden" : ""}`}
            onClick={onSidebarOpen}
            aria-label="Show sidebar"
            title="Show sidebar"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <button
            onClick={() => { if (confirmUnsavedNavigation()) router.push("/dashboard/home"); }}
            className={`group hidden min-[400px]:flex min-w-0 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sidebarOpen ? "lg:hidden" : ""}`}
          >
            <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-border bg-card p-1.5">
              <Image src="/logos/asksales_logo.svg" alt={BRAND_NAME} width={28} height={28} priority className="relative z-10 h-full w-full object-contain" />
            </div>
            <div className="hidden min-w-0 flex-col items-start gap-1 leading-none sm:flex">
              <span className="whitespace-nowrap text-[17px] font-semibold tracking-[-0.03em] text-foreground">
                {BRAND_NAME}
              </span>
              {workspaceName && <span title={`Current workspace: ${workspaceName}`} aria-label={`Current workspace: ${workspaceName}`} className="max-w-36 truncate text-[11px] font-medium leading-3 text-muted-foreground">{workspaceName}</span>}
            </div>
          </button>
        </div>

        {/* Middle Section: Workspace navigation search */}
        <div className="ml-auto flex w-11 shrink-0 xl:ml-4 xl:w-64 xl:min-w-0 xl:shrink">
          <button
            aria-label={`Find a page in ${workspaceName || "your workspace"}`}
            ref={pageSearchTrigger}
            onClick={() => setCommandPaletteOpen(true)}
            className="group relative flex h-11 w-full items-center rounded-[10px] border border-border bg-card text-left text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground xl:h-9 xl:px-9"
          >
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
            </div>
            <span className="hidden truncate xl:inline">Find a page…</span>
            <div className="absolute inset-y-0 right-3 hidden items-center xl:flex">
              <div className="flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5">
                <Command className="w-3 h-3 text-muted-foreground" />
                <span className="text-[10px] font-bold text-muted-foreground">K</span>
              </div>
            </div>
          </button>
        </div>

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          enabledModules={enabledModules}
          workspaceName={workspaceName}
          returnFocusRef={pageSearchTrigger}
        />

        {/* Right Section: Controls + Profile */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2 xl:ml-auto">
          {isAuthenticated && (
            <>
              {enabledModules?.includes("billing") && (
                <Link
                  href="/dashboard/billing"
                  aria-label={`Available credits: ${balanceData?.balance != null ? balanceData.balance.toLocaleString() : "loading"}`}
                  className="flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-semibold tabular-nums text-foreground transition-colors hover:border-primary/40 hover:bg-muted sm:gap-2 sm:px-3"
                >
                  <Coins className="h-4 w-4 text-primary" aria-hidden="true" />
                  <span className="hidden sm:inline">{balanceData?.balance != null ? balanceData.balance.toLocaleString() : "…"}</span>
                  <span className="hidden font-medium text-muted-foreground sm:inline">credits</span>
                </Link>
              )}

              {/* Theme Toggle (Moon/Sun) */}
              <ThemeToggle className="h-11 w-11 bg-transparent" />

              {/* Notifications (Bell) */}
              <Popover open={notificationsOpen} onOpenChange={(open) => {
                setNotificationsOpen(open);
                if (open) fetchNotifications();
              }}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="button-notifications"
                    aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
                    className="relative h-11 w-11 rounded-[10px] bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground sm:mr-1"
                  >
                    <Bell className="w-4.5 h-4.5" />
                    {unreadCount > 0 && (
                      <Badge className="absolute top-2 right-2 w-2 h-2 p-0 rounded-full bg-destructive border-2 border-background ring-2 ring-background" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-[14px] border-border bg-popover p-0 shadow-lg" align="end">
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                  >
                    <div className="border-b border-border p-4">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                        Notifications
                      </h3>
                      {unreadCount > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">{unreadCount} unread</p>
                      )}
                    </div>
                    <ScrollArea
                      className="h-[300px]"
                      viewportClassName="min-w-0 pr-3 [&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full"
                    >
                      {notificationsLoading && <p role="status" className="p-3 text-xs text-muted-foreground">{notificationsLoaded ? "Refreshing notifications…" : "Loading notifications…"}</p>}
                      {notificationsError && <div role="alert" className="space-y-2 border-b p-3 text-xs">
                        <p>{notificationsLoaded ? "Notifications could not be refreshed. Showing stale notifications." : "Notifications unavailable."}</p>
                        <Button variant="outline" size="sm" onClick={() => void fetchNotifications()}>Retry notifications</Button>
                      </div>}
                      {notificationsLoaded && !notificationsLoading && !notificationsError && notifications.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground">
                          <div className="w-12 h-12 bg-primary/5 rounded-full flex items-center justify-center mx-auto mb-3">
                            <Bell className="w-6 h-6 opacity-20" />
                          </div>
                          <p className="text-xs font-medium">No new notifications</p>
                        </div>
                      ) : notifications.length > 0 ? (
                        <div className="divide-y divide-border/20">
                          {notifications.map((notification) => (
                            <button
                              type="button"
                              key={notification.id}
                              aria-label={`Notification: ${notification.title}${!notification.read ? ' (unread)' : ''}`}
                              className={`block w-full min-w-0 overflow-hidden p-3 text-left hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring transition-colors ${!notification.read ? 'bg-primary/[0.02]' : ''
                                }`}
                              onClick={() => {
                                openNotification(notification);
                              }}
                            >
                              <span className="flex min-w-0 gap-3">
                                <span className="flex-shrink-0 mt-0.5">
                                  <span className="w-8 h-8 rounded-lg bg-background flex items-center justify-center border border-border/40 shadow-sm">
                                    {getNotificationIcon(notification.type)}
                                  </span>
                                </span>
                                <span className="block min-w-0 flex-1 overflow-hidden">
                                  <span className={`block break-words [overflow-wrap:anywhere] text-xs ${!notification.read ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                    {notification.title}
                                  </span>
                                  <span className="block text-[10px] text-muted-foreground/70 truncate mt-0.5">
                                    {notification.message}
                                  </span>
                                  <span className="block text-[9px] font-bold text-primary/50 mt-1 uppercase tracking-tighter">
                                    {formatTimeAgo(notification.createdAt)}
                                  </span>
                                </span>
                                {!notification.read && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-1.5 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </ScrollArea>
                    <div className="p-2 border-t border-border/20 bg-primary/[0.02]">
                      <Button
                        variant="ghost"
                        className="w-full h-8 text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary hover:bg-primary/10 rounded-xl"
                        onClick={() => {
                          setNotificationsOpen(false);
                          if (confirmUnsavedNavigation()) router.push("/dashboard/notifications");
                        }}
                      >
                        View Workspace Inbox
                      </Button>
                    </div>
                  </motion.div>
                </PopoverContent>
              </Popover>

              {/* User Profile Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Account menu" className="group h-11 w-11 shrink-0 rounded-full p-0 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                    <Avatar className="h-9 w-9 border border-border transition-colors group-hover:border-primary/50">
                      <AvatarImage src={user?.avatar} alt={user?.name || "User profile"} />
                      <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                        {user && user.name ? user.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2) : "U"}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-60 bg-background/80 backdrop-blur-xl border-border/40 rounded-2xl shadow-2xl shadow-primary/10 overflow-hidden" align="end" forceMount>
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                  >
                    <DropdownMenuLabel className="font-normal p-3">
                      <div className="flex flex-col space-y-1">
                        <p className="text-xs font-black leading-none text-foreground uppercase tracking-wider">{user?.name}</p>
                        <p className="text-[10px] leading-none text-muted-foreground font-medium italic">
                          {user?.email}
                        </p>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator className="bg-border/20" />
                    <div className="p-1">
                      <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push(documentationHrefForPath(pathname) ?? DOCUMENTATION_ROOT); }} className="min-h-11 cursor-pointer rounded-xl py-2 text-xs">
                        <BookOpen className="mr-2 h-3.5 w-3.5" />
                        <span>Documentation for this page</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push("/dashboard/user-profile"); }} className="rounded-xl focus:bg-primary/10 focus:text-primary transition-colors cursor-pointer text-xs font-bold py-2">
                        <User className="mr-2 h-3.5 w-3.5" />
                        <span>My Profile</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push("/dashboard/change-password"); }} className="rounded-xl focus:bg-primary/10 focus:text-primary transition-colors cursor-pointer text-xs font-bold py-2">
                        <Lock className="mr-2 h-3.5 w-3.5" />
                        <span>Security & Password</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push("/dashboard/settings"); }} className="rounded-xl focus:bg-primary/10 focus:text-primary transition-colors cursor-pointer text-xs font-bold py-2">
                        <Settings className="mr-2 h-3.5 w-3.5" />
                        <span>System Settings</span>
                      </DropdownMenuItem>
                    </div>
                    <DropdownMenuSeparator className="bg-border/20" />
                    <div className="p-1">
                      <DropdownMenuItem onSelect={event => { if (!confirmUnsavedNavigation()) { event.preventDefault(); return; } void logout(); }} className="rounded-xl focus:bg-destructive/10 focus:text-destructive transition-colors cursor-pointer text-xs font-bold py-2">
                        <LogOut className="mr-2 h-3.5 w-3.5" />
                        <span>Sign Out</span>
                      </DropdownMenuItem>
                    </div>
                  </motion.div>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
