"use client";

import { BellRing, Inbox, User, LogOut, ChevronDown, Settings, Menu } from "lucide-react";
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
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { supportApi } from "@/lib/support-api";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { ThemeToggle } from "@/components/ThemeToggle";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";
import { createGuardedRefresh } from "@/lib/guardedRefresh";

interface SupportHeaderProps {
  onSidebarOpen?: () => void;
}

export default function SupportHeader({ onSidebarOpen }: SupportHeaderProps) {
  const router = useRouter();
  const [activeTicketCount, setActiveTicketCount] = useState(0);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const { isAuthenticated, member, logout } = useSupportAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const refresh = () => supportApi
      .get<{ open: number; inProgress: number; waitingOnCustomer: number }>("/api/support-portal/stats")
      .then((stats) => {
        if (!cancelled) {
          setActiveTicketCount((stats.open ?? 0) + (stats.inProgress ?? 0) + (stats.waitingOnCustomer ?? 0));
        }
      })
      .catch(() => {
        if (!cancelled) setActiveTicketCount(0);
      });
    // Ticks skip hidden tabs and never overlap a read still running; ticket
    // events queue one follow-up read instead of starting a parallel one.
    const guard = createGuardedRefresh(refresh);
    const onTicketUpdated = () => { void guard.run(); };
    const onVisible = () => { if (document.visibilityState === "visible") guard.poll(); };
    void guard.run();
    window.addEventListener("support:ticket-updated", onTicketUpdated);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(guard.poll, 30_000);
    return () => {
      cancelled = true;
      guard.stop();
      window.removeEventListener("support:ticket-updated", onTicketUpdated);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const refresh = () => supportApi
      .get<{ unreadCount: number }>("/api/support-portal/notifications?limit=1")
      .then((data) => {
        if (!cancelled) setUnreadNotificationCount(data.unreadCount || 0);
      })
      .catch(() => {
        if (!cancelled) setUnreadNotificationCount(0);
      });
    const guard = createGuardedRefresh(refresh);
    const onVisible = () => { if (document.visibilityState === "visible") guard.poll(); };
    void guard.run();
    document.addEventListener("visibilitychange", onVisible);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/agents/progress?audience=support`);
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.type !== "support_notification") return;
        void guard.run();
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("AskSales.AI Support", { body: "A support ticket needs your attention.", tag: `support-${payload.eventId || Date.now()}` });
        }
      } catch { /* polling remains the recovery path */ }
    };
    const timer = window.setInterval(guard.poll, 60_000);
    return () => {
      cancelled = true;
      guard.stop();
      socket.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [isAuthenticated]);

  return (
    <header
      className="fixed left-0 top-0 z-[var(--layer-header)] flex h-[72px] w-full flex-col items-start border-b border-border bg-background/95 p-0 shadow-sm backdrop-blur-xl"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onSidebarOpen?.();
        }
      }}
    >
      <div className="flex h-full w-full items-center justify-between gap-2 px-3 sm:px-6">
        {/* Left Section: Apps Grid + Logo */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0 lg:hidden"
            onClick={onSidebarOpen}
            aria-label="Open support navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <button
            onClick={() => { if (confirmUnsavedNavigation()) router.push("/support/tickets"); }}
            className="group flex min-w-0 items-center gap-3 transition-opacity hover:opacity-90"
          >
            <div className="w-11 h-11 bg-transparent rounded-2xl flex items-center justify-center p-1 group-hover:scale-105 transition-all duration-300">
              <img src="/logos/asksales_logo.svg" alt="AskSales.AI" className="w-full h-full object-contain" />
            </div>
            <span className="hidden text-xl font-semibold tracking-tight text-foreground sm:inline font-heading">
              AskSales.AI <span className="text-primary">Support</span>
            </span>
          </button>
        </div>

        {/* Right Section: Controls + Profile */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        {isAuthenticated && (
          <>
            <ThemeToggle />

            <Button
              variant="ghost"
              size="icon"
              className="relative text-muted-foreground hover:bg-primary/10 hover:text-primary"
              onClick={() => { if (confirmUnsavedNavigation()) router.push("/support/notifications"); }}
              aria-label={`${unreadNotificationCount} unread support notifications`}
              title="Notification center"
            >
              <BellRing className="h-5 w-5" />
              {unreadNotificationCount > 0 && (
                <Badge className="absolute -right-1 -top-1 min-w-5 justify-center px-1 text-[10px]">
                  {unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}
                </Badge>
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="relative text-muted-foreground hover:bg-primary/10 hover:text-primary"
              onClick={() => { if (confirmUnsavedNavigation()) router.push("/support/tickets"); }}
              aria-label={`${activeTicketCount} active support tickets`}
              title="Open ticket queue"
            >
              <Inbox className="h-5 w-5" />
              {activeTicketCount > 0 && (
                <Badge className="absolute -right-1 -top-1 min-w-5 justify-center px-1 text-[10px]">
                  {activeTicketCount > 99 ? "99+" : activeTicketCount}
                </Badge>
              )}
            </Button>

            <div className="mx-1 hidden h-8 w-px bg-border sm:block" />

            {/* Support Member Profile Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" aria-label="Support account menu" className="flex items-center gap-3 pl-1 pr-2 py-1 h-auto hover:bg-secondary rounded-lg group">
                  <Avatar className="h-9 w-9 border border-border">
                    <AvatarImage src={member?.avatar} />
                    <AvatarFallback className="bg-primary/10 font-medium text-primary">
                      {member && member.name ? member.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2) : "SM"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="text-left hidden md:block">
                    <p className="text-sm font-medium text-foreground leading-none mb-0.5 group-hover:text-foreground/80">
                      {member?.name || "Support Member"}
                    </p>
                    <p className="text-xs text-muted-foreground leading-none">
                      {member?.role || "Agent"}
                    </p>
                  </div>
                  <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
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
                      <p className="text-xs font-black uppercase tracking-widest text-foreground truncate">{member?.name}</p>
                      <p className="text-[10px] font-medium text-muted-foreground italic truncate">{member?.email}</p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-border/20" />
                  <div className="p-1">
                    <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push("/support/profile"); }} className="rounded-xl focus:bg-primary/10 focus:text-primary transition-colors cursor-pointer text-xs font-bold py-2">
                      <User className="mr-2 h-3.5 w-3.5" />
                      <span>My Profile</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { if (confirmUnsavedNavigation()) router.push("/support/settings"); }} className="rounded-xl focus:bg-primary/10 focus:text-primary transition-colors cursor-pointer text-xs font-bold py-2">
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
