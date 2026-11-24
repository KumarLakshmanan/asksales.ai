"use client";

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/contexts/WebSocketContext";

const SUPPORT_EVENT_PREFIXES = ["support_", "handoff_", "delivery_"];

export function useSupportRealtimeRefresh(refresh: () => void | Promise<void>, pollingMs = 30_000) {
  const { subscribe, isConnected } = useWebSocket();
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    let running = false;
    let pending = false;
    let disposed = false;
    const run = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      if (running) { pending = true; return; }
      running = true;
      void Promise.resolve().then(() => { if (!disposed) return refreshRef.current(); }).catch(() => undefined).finally(() => {
        running = false;
        if (pending && !disposed) { pending = false; run(); }
      });
    };
    const unsubscribeNotification = subscribe("events:notification", (data) => {
      const notification = data.notification as Record<string, unknown> | undefined;
      const eventData = data.data as Record<string, unknown> | undefined;
      const type = String(notification?.type || eventData?.type || data.type || "");
      if (!type || SUPPORT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) run();
    });
    const unsubscribeReconnect = subscribe("websocket_connected", run);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, pollingMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      unsubscribeNotification();
      unsubscribeReconnect();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollingMs, subscribe]);

  return { isRealtimeConnected: isConnected };
}
