"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Bell, CheckCheck, Trash2, Info, CheckCircle, AlertTriangle, XCircle, ArrowUpRight } from "lucide-react";
import { format } from "date-fns";
import { api } from "@/lib/api";
import { announceNotificationChange, NOTIFICATIONS_CHANGED } from "@/lib/notification-changes";
import { NotificationsSkeleton } from "@/components/skeletons";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState } from "@/components/ui/page-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWebSocket } from "@/contexts/WebSocketContext";

interface Notification {
  id: number;
  userId: number;
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  read: boolean;
  actionUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NotificationListResponse {
  items: Notification[];
  unreadCount: number;
  totalCount: number;
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean; nextCursor: string | null };
}

export default function DashboardNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationPending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const router = useRouter();
  const { subscribe } = useWebSocket();

  const fetchNotifications = useCallback(async (pageToLoad = 1, append = false, cursor?: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      if (pageToLoad === 1) setFetchError(false);
      else setLoadingMore(true);
      const params = new URLSearchParams({ page: String(pageToLoad), limit: "20" });
      if (cursor) params.set("cursor", cursor);
      if (activeTab === "unread") params.set("unread", "true");
      else if (["info", "success", "warning", "error"].includes(activeTab)) params.set("type", activeTab);
      const data = await api.get<NotificationListResponse>(`/api/notifications?${params.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setNotifications(current => append
        ? [...current, ...data.items.filter(item => !current.some(existing => existing.id === item.id))]
        : data.items);
      setPage(data.pagination.page);
      setTotal(data.pagination.total);
      setAllTotal(data.totalCount);
      setUnreadCount(data.unreadCount);
      setHasMore(data.pagination.hasMore);
      setNextCursor(data.pagination.nextCursor);
    } catch (_error) {
      if (controller.signal.aborted) return;
      if (pageToLoad === 1) setFetchError(true);
      toast({ title: "Failed to load notifications", description: "Please try again.", variant: "destructive" });
    } finally {
      if (!controller.signal.aborted) {
        if (pageToLoad === 1) setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [activeTab, toast]);

  useEffect(() => {
    setLoading(true);
    void fetchNotifications(1, false);
    return () => request.current?.abort();
  }, [fetchNotifications]);

  useEffect(() => {
    const refresh = () => void fetchNotifications(1, false);
    const visibleRefresh = () => { if (document.visibilityState === 'visible') refresh(); };
    const storageRefresh = (event: StorageEvent) => { if (event.key === NOTIFICATIONS_CHANGED) refresh(); };
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    window.addEventListener('storage', storageRefresh);
    const unsubscribeNotification = subscribe("events:notification", refresh);
    const unsubscribeReconnect = subscribe("websocket_connected", refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
      window.removeEventListener('storage', storageRefresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      unsubscribeNotification();
      unsubscribeReconnect();
    };
  }, [fetchNotifications, subscribe]);

  const mutateInbox = async (operation: () => Promise<unknown>, failureTitle: string) => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setMutating(true);
    // An older read must not replace the state after the mutation commits.
    request.current?.abort();
    try {
      await operation();
    } catch (_error) {
      toast({ title: failureTitle, variant: "destructive" });
    } finally {
      // Reconcile both success and failure: another tab may have deleted the row.
      mutationPending.current = false;
      setMutating(false);
      announceNotificationChange();
    }
  };

  const markAsRead = (id: number) => mutateInbox(
    () => api.put(`/api/notifications/${id}/read`), "Unable to mark as read",
  );
  const markAllAsRead = () => mutateInbox(
    () => api.put("/api/notifications/read-all"), "Unable to mark all as read",
  );
  const deleteNotification = async (id: number) => {
    await mutateInbox(() => api.delete(`/api/notifications/${id}`), "Unable to delete notification");
    setDeleteConfirm(null);
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "success":
        return <CheckCircle className="h-5 w-5 shrink-0 text-green-500" />;
      case "warning":
        return <AlertTriangle className="h-5 w-5 shrink-0 text-yellow-500" />;
      case "error":
        return <XCircle className="h-5 w-5 shrink-0 text-red-500" />;
      default:
        return <Info className="h-5 w-5 shrink-0 text-blue-500" />;
    }
  };

  const openNotification = (notification: Notification) => {
    if (!notification.actionUrl || !/^\/dashboard(?:\/|$)/.test(notification.actionUrl) || notification.actionUrl.includes("\\")) return;
    if (!notification.read) void markAsRead(notification.id);
    router.push(notification.actionUrl);
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
        <PageHeader icon={Bell} title="Notifications" subtitle="Stay updated with your latest activity" />
        <NotificationsSkeleton count={8} />
      </div>
    );
  }

  if (fetchError) {
    return <PageErrorState title="Notifications unavailable" description="We could not load your notification inbox." reset={() => void fetchNotifications(1, false)} />;
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <PageHeader icon={Bell} title="Notifications" subtitle="Stay updated with your latest activity" />
        {unreadCount > 0 && (
          <Button disabled={mutating} onClick={markAllAsRead} variant="outline" aria-label="Mark all notifications as read" className="h-9 gap-2 rounded-lg px-4 text-sm">
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all as read
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="pb-1">
          <TabsList className="grid h-auto w-full min-w-0 grid-cols-3 gap-1 rounded-xl border border-border/40 bg-muted/40 p-1 sm:h-10 sm:grid-cols-6">
            <TabsTrigger value="all" className="rounded-lg text-xs font-medium">
              All {allTotal > 0 && `(${allTotal})`}
            </TabsTrigger>
            <TabsTrigger value="unread" className="rounded-lg text-xs font-medium">
              Unread {unreadCount > 0 && `(${unreadCount})`}
            </TabsTrigger>
            <TabsTrigger value="info" className="rounded-lg text-xs font-medium">Info</TabsTrigger>
            <TabsTrigger value="success" className="rounded-lg text-xs font-medium">Success</TabsTrigger>
            <TabsTrigger value="warning" className="rounded-lg text-xs font-medium">Warning</TabsTrigger>
            <TabsTrigger value="error" className="rounded-lg text-xs font-medium">Error</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value={activeTab} className="space-y-4 mt-4">
          {notifications.length === 0 ? (
            <Card className="rounded-xl border border-border/60 shadow-none">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Bell className="w-12 h-12 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground text-sm">No notifications found</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {notifications.map((notification) => (
              <Card 
                key={notification.id} 
                className={`rounded-xl border-border/60 shadow-none transition-colors ${!notification.read ? "border-l-4 border-l-primary bg-primary/[0.03]" : ""}`}
              >
                <CardHeader className="pb-3">
                  <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
                    <div className="flex w-full min-w-0 flex-1 items-start gap-3">
                      {getNotificationIcon(notification.type)}
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <CardTitle className="text-base [overflow-wrap:anywhere]">{notification.title}</CardTitle>
                          <StatusBadge status={notification.type} toneOverrides={{ info: "info", warning: "warning" }} />
                          {!notification.read && (
                            <Badge variant="default">New</Badge>
                          )}
                        </div>
                        <CardDescription className="text-xs">
                          {format(new Date(notification.createdAt), "PPpp")}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:ml-4 sm:self-start">
                      {notification.actionUrl && /^\/dashboard(?:\/|$)/.test(notification.actionUrl) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutating}
                          onClick={() => openNotification(notification)}
                          aria-label={`Open ${notification.title}`}
                          className="gap-1.5"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                          <span className="hidden sm:inline">Open</span>
                        </Button>
                      )}
                      {!notification.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutating}
                          onClick={() => markAsRead(notification.id)}
                          title="Mark as read"
                          aria-label={`Mark ${notification.title} as read`}
                        >
                          <CheckCheck className="w-4 h-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mutating}
                        onClick={() => setDeleteConfirm(notification.id)}
                        title="Delete notification"
                        aria-label={`Delete ${notification.title}`}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground break-words">{notification.message}</p>
                </CardContent>
              </Card>
              ))}
              {hasMore && (
                <div className="flex justify-center pt-2">
                  <Button variant="outline" size="sm" className="h-9 gap-2 px-6 rounded-xl text-xs" loading={loadingMore} disabled={mutating} onClick={() => void fetchNotifications(page + 1, true, nextCursor)}>
                    Load more ({Math.max(0, total - notifications.length)} remaining)
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={deleteConfirm !== null} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete notification?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutating} onClick={() => deleteConfirm !== null && deleteNotification(deleteConfirm)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
