"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Ticket, ArrowUpRight, Bot, BookOpen,
  TrendingUp, MessageSquare, ShieldCheck, Users
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { PageErrorState } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";
import { formatSupportTicketStatus } from "@/lib/supportStatus";
import { SUPPORT_STATUS_CLASSES as STATUS_COLORS } from "@/lib/support-styles";

interface Stats { total: number; open: number; inProgress: number; waitingOnCustomer: number; resolved: number; closed: number; myActive: number; needsHuman: number; teamUnassigned: number; slaRisk: number; }
interface TicketItem { id: number; ticketNumber: string; subject: string; status: string; priority: string; createdAt: string; }

export default function SupportDashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const { member, isAuthenticated, isLoading: authLoading } = useSupportAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentTickets, setRecentTickets] = useState<TicketItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statsData, ticketsData] = await Promise.all([
        supportApi.get<Stats>("/api/support-portal/stats"),
        supportApi.get<{ tickets: TicketItem[] }>("/api/support-portal/tickets?limit=5")
      ]);
      setStats(statsData);
      setRecentTickets(Array.isArray(ticketsData?.tickets) ? ticketsData.tickets : []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      toast({ title: "Error", description: "Failed to load dashboard data", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push("/support/login");
    if (isAuthenticated) fetchData();
  }, [authLoading, isAuthenticated, router, fetchData]);

  if (authLoading || (isAuthenticated && isLoading && !stats)) {
    return (
      <LoadingState label="Loading support dashboard…" />
    );
  }
  if (!isAuthenticated) return null;
  // A failed load must not read as an empty queue with zero tickets.
  if (loadFailed && !stats) {
    return <PageErrorState title="Support dashboard could not be loaded" description="The request did not complete. Please try again." reset={() => void fetchData()} />;
  }

  const statCards = [
    { label: "My Active", value: stats?.myActive ?? 0, icon: Ticket, color: "text-info", bg: "bg-info/10", path: "/support/tickets" },
    { label: "Needs Human", value: stats?.needsHuman ?? 0, icon: Bot, color: "text-warning", bg: "bg-warning/10", path: "/support/tickets?handoff=active" },
    { label: "Team Unassigned", value: stats?.teamUnassigned ?? 0, icon: Users, color: "text-primary", bg: "bg-primary/10", path: "/support/tickets?scope=unassigned" },
    { label: "SLA Risk", value: stats?.slaRisk ?? 0, icon: TrendingUp, color: "text-destructive", bg: "bg-destructive/10", path: "/support/tickets?sla=at_risk" },
  ];

  return (
    <div className="space-y-5 max-w-screen-xl mx-auto">
      {/* Welcome */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-border/50 bg-card">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold">
              Welcome back, <span className="text-primary">{member?.name?.split(" ")[0]}</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">{member?.teamName} · Support Portal</p>
          </div>
        </div>
        <Button size="sm" className="h-8 text-xs rounded-lg px-4 gap-1.5"
          onClick={() => router.push("/support/chat")}>
          <Bot className="w-3.5 h-3.5" /> Support AI
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((s, i) => (
          <Card key={i} className="cursor-pointer border border-border/50 rounded-xl shadow-none transition hover:border-primary/30" onClick={() => router.push(s.path)}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", s.bg)}>
                <s.icon className={cn("w-4 h-4", s.color)} />
              </div>
              <div>
                <p className="text-xl font-bold leading-tight">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent Tickets */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" /> Recent Assignments
            </p>
            <button onClick={() => router.push("/support/tickets")}
              className="text-xs text-primary hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          {recentTickets.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-border/40 p-8 text-center">
              <Ticket className="w-6 h-6 mx-auto mb-2 opacity-20" />
              <p className="text-xs text-muted-foreground">No assigned tickets found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentTickets.map((t) => (
                <button key={t.id} onClick={() => router.push(`/support/tickets/${t.id}`)}
                  className="w-full text-left rounded-xl border border-border/50 bg-card px-4 py-3 hover:bg-muted/30 hover:border-border transition-colors flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono text-muted-foreground/60">{t.ticketNumber}</span>
                      <Badge className={cn("text-xs font-medium px-1.5 py-0.5 h-auto rounded-md border-none capitalize",
                        STATUS_COLORS[t.status] || "bg-muted text-muted-foreground")}>
                        {formatSupportTicketStatus(t.status)}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium truncate">{t.subject}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{new Date(t.createdAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="space-y-3">
          <p className="text-sm font-semibold px-1">Quick Access</p>
          <div className="space-y-2">
            {[
              { icon: BookOpen, label: "Knowledge Base", desc: "Browse support documents", path: "/support/knowledge-base", color: "text-primary bg-primary/10" },
              { icon: ShieldCheck, label: "Account Settings", desc: "Profile & security", path: "/support/settings", color: "text-primary bg-primary/10" },
            ].map((item, i) => (
              <button key={i} onClick={() => router.push(item.path)}
                className="w-full text-left rounded-xl border border-border/50 bg-card px-4 py-3 hover:bg-muted/30 hover:border-border transition-colors flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", item.color)}>
                    <item.icon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
