"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, BellRing, CheckCheck, Circle, ExternalLink, RotateCcw, ShieldCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supportApi } from "@/lib/support-api";
import { createGuardedRefresh, type GuardedRefresh } from "@/lib/guardedRefresh";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface Delivery {
  id: number;
  channel: string;
  status: string;
  destinationHint?: string | null;
  attemptCount: number;
  providerStatus?: string | null;
  errorCode?: string | null;
  lastError?: string | null;
  sentAt?: string | null;
  createdAt: string;
}

interface SupportNotification {
  id: number;
  read_at: string | null;
  created_at: string;
  acknowledged_at: string | null;
  claimed_at: string | null;
  severity: string;
  safe_summary: string;
  required_action: string;
  event_type: string;
  ticket_id: number;
  payload: {
    ticketNumber: string;
    subject?: string;
    priority: string;
    sourceChannel?: string;
    ticketPath: string;
  };
  deliveries: Delivery[];
}

interface NotificationResult {
  notifications: SupportNotification[];
  unreadCount: number;
  unacknowledgedCount: number;
  total: number;
}

function deliveryVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered" || status === "read") return "default";
  if (["failed", "suppressed", "dead_letter"].includes(status)) return "destructive";
  if (status === "retry" || status === "sending") return "secondary";
  return "outline";
}

export default function SupportNotificationsPage() {
  const [result, setResult] = useState<NotificationResult>({ notifications: [], unreadCount: 0, unacknowledgedCount: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const guard = useRef<GuardedRefresh | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await supportApi.get<NotificationResult>("/api/support-portal/notifications?limit=100");
      setResult({ ...data, notifications: Array.isArray(data?.notifications) ? data.notifications : [] });
      setHasLoaded(true);
      setLoadError(null);
    } catch (failure) {
      setLoadError(failure instanceof Error && failure.message ? failure.message : "Notifications could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  // Every caller goes through the guard: timer ticks skip hidden tabs and
  // in-flight reads; socket events and actions queue one follow-up read.
  const load = useCallback(() => guard.current ? guard.current.run() : fetchNotifications(), [fetchNotifications]);

  useEffect(() => {
    const current = createGuardedRefresh(fetchNotifications);
    guard.current = current;
    void current.run();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/agents/progress?audience=support`);
    socket.onmessage = (event) => {
      try { if (JSON.parse(event.data)?.type === "support_notification") void current.run(); } catch { /* polling recovers malformed frames */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") current.poll(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(current.poll, 60_000);
    return () => {
      current.stop();
      if (guard.current === current) guard.current = null;
      socket.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [fetchNotifications]);

  const retry = () => { setLoading(true); setLoadError(null); void load(); };

  const acknowledge = async (notification: SupportNotification) => {
    if (notification.acknowledged_at) return;
    await supportApi.post(`/api/support-portal/notifications/${notification.id}/acknowledge`, {});
    setResult((current) => ({ ...current, unacknowledgedCount: Math.max(0, current.unacknowledgedCount - 1),
      notifications: current.notifications.map((item) => item.id === notification.id ? { ...item, acknowledged_at: new Date().toISOString() } : item) }));
  };

  const retryDelivery = async (deliveryId: number) => {
    await supportApi.post(`/api/support-portal/notification-deliveries/${deliveryId}/retry`, {});
    await load();
  };
  const claimTicket = async (notification: SupportNotification) => {
    await supportApi.post(`/api/support-portal/notifications/${notification.id}/claim`, {});
    await load();
  };

  const eventTitle = (eventType: string) => ({
    ticket_created_unassigned: "Unassigned ticket", ticket_assigned: "Ticket assigned", ticket_reassigned: "Ticket reassigned",
    human_handoff: "Human handoff requested", customer_replied: "Customer replied", ticket_reopened: "Ticket reopened",
    sla_at_risk: "SLA at risk", sla_breached: "SLA breached", approval_required: "Approval required",
    delivery_failed: "Customer delivery failed", ticket_resolved: "Ticket resolved",
  }[eventType] || "Support update");

  const markRead = async (notification: SupportNotification) => {
    if (notification.read_at) return;
    await supportApi.post(`/api/support-portal/notifications/${notification.id}/read`, {});
    setResult((current) => ({
      ...current,
      unreadCount: Math.max(0, current.unreadCount - 1),
      notifications: current.notifications.map((item) =>
        item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item
      ),
    }));
  };

  const markAllRead = async () => {
    await supportApi.post("/api/support-portal/notifications/read-all", {});
    setResult((current) => ({
      ...current,
      unreadCount: 0,
      notifications: current.notifications.map((item) => ({
        ...item,
        read_at: item.read_at || new Date().toISOString(),
      })),
    }));
  };

  if (loading) {
    return <LoadingState className="min-h-64" label="Loading notifications…" />;
  }

  if (loadError && !hasLoaded) {
    return (
      <div role="alert" className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Notifications could not be loaded</h1>
        <p className="text-sm text-muted-foreground">{loadError}</p>
        <Button variant="outline" onClick={retry}><RotateCcw className="mr-2 h-4 w-4" />Try again</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Notification center</h1>
            {result.unreadCount > 0 && <Badge>{result.unreadCount} unread</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Realtime ticket alerts, acknowledgement status, escalation, and provider delivery history.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={result.unreadCount === 0}>
          <CheckCheck className="mr-2 h-4 w-4" />
          Mark all read
        </Button>
      </div>

      {loadError && hasLoaded && (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          Showing the last loaded notifications; the latest could not be refreshed. <button type="button" className="underline" onClick={() => void load()}>Try again</button>
        </p>
      )}

      {result.notifications.length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
            <BellRing className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">No support alerts yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Assignments and handoffs will appear here.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {result.notifications.map((notification) => {
            const failed = notification.deliveries.some((delivery) =>
              ["failed", "suppressed"].includes(delivery.status)
            );
            return (
              <Card
                key={notification.id}
                className={notification.read_at ? "shadow-none" : "border-primary/40 bg-primary/[0.02] shadow-none"}
                onClick={() => void markRead(notification)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-1">
                      {notification.read_at
                        ? <Circle className="h-3 w-3 text-muted-foreground/40" />
                        : <span className="block h-3 w-3 rounded-full bg-primary" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">
                            {eventTitle(notification.event_type)}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {notification.payload.ticketNumber}
                            {notification.payload.subject ? ` · ${notification.payload.subject}` : ""}
                          </p>
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
                        </span>
                      </div>

                      <div className="mt-3 rounded-lg bg-muted/40 p-3 text-xs">
                        <p className="font-medium">{notification.safe_summary}</p>
                        <p className="mt-1 text-muted-foreground">{notification.required_action}</p>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{String(notification.payload.priority || "medium").toUpperCase()}</Badge>
                        {notification.payload.sourceChannel && <Badge variant="secondary">{notification.payload.sourceChannel}</Badge>}
                        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                          <Link href={`/support/tickets/${notification.ticket_id}${notification.event_type === "customer_replied" ? "?view=conversation" : "?view=summary"}`}>
                            Open ticket <ExternalLink className="ml-1.5 h-3 w-3" />
                          </Link>
                        </Button>
                        <Button size="sm" variant={notification.acknowledged_at ? "secondary" : "default"} className="h-7 text-xs"
                          disabled={Boolean(notification.acknowledged_at)} onClick={(event) => { event.stopPropagation(); void acknowledge(notification); }}>
                          <ShieldCheck className="mr-1.5 h-3 w-3" />
                          {notification.acknowledged_at ? "Acknowledged" : "Acknowledge"}
                        </Button>
                        {notification.event_type === "ticket_created_unassigned" && (
                          <Button size="sm" variant="default" className="h-7 text-xs" disabled={Boolean(notification.claimed_at)}
                            onClick={(event) => { event.stopPropagation(); void claimTicket(notification); }}>
                            {notification.claimed_at ? "Claimed" : "Claim ticket"}
                          </Button>
                        )}
                      </div>

                      <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Delivery history</p>
                          {failed && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
                        </div>
                        {notification.deliveries.length === 0 ? (
                          <p className="text-xs text-muted-foreground">In-app only — no verified external destination was enabled.</p>
                        ) : (
                          <div className="space-y-2">
                            {notification.deliveries.map((delivery) => (
                              <div key={delivery.id} className="flex flex-wrap items-center gap-2 text-xs">
                                <Badge variant={deliveryVariant(delivery.status)}>{delivery.channel} · {delivery.status}</Badge>
                                {delivery.destinationHint && <span className="text-muted-foreground">{delivery.destinationHint}</span>}
                                {delivery.attemptCount > 1 && <span className="text-muted-foreground">{delivery.attemptCount} attempts</span>}
                                {delivery.lastError && (
                                  <span className="basis-full text-[11px] text-destructive">
                                    {delivery.errorCode ? `${delivery.errorCode}: ` : ""}{delivery.lastError}
                                  </span>
                                )}
                                {["failed", "dead_letter", "uncertain", "suppressed"].includes(delivery.status) && (
                                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={(event) => {
                                    event.stopPropagation(); void retryDelivery(delivery.id);
                                  }}><RotateCcw className="mr-1 h-3 w-3" />Retry</Button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
