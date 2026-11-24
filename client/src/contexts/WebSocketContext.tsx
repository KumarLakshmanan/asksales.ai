"use client";

import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "./AuthContext";
import webSocketService from "@/services/WebSocketService";
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';

interface WebSocketContextType {
  isConnected: boolean;
  isConnecting: boolean;
  retryCount: number;
  maxRetriesReached: boolean;
  retryConnection: () => void;
  subscribe: (eventType: string, handler: (data: Record<string, unknown>) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const businessProfileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [maxRetriesReached, setMaxRetriesReached] = useState(false);

  const connectRef = React.useRef<(userId: number) => Promise<void>>(undefined as unknown as (userId: number) => Promise<void>);

  React.useEffect(() => {
    connectRef.current = async (userId: number) => {
      try {
        setIsConnecting(true);
        setRetryCount(0);
        setMaxRetriesReached(false);
        await webSocketService.connect(userId);
        setIsConnected(true);
        setIsConnecting(false);
      } catch {
        setIsConnecting(false);
      }
    };
  }, []);

  const prevUserRef = React.useRef(user);
  useEffect(() => {
    if (!user || !businessProfileId) {
      webSocketService.disconnect();
      prevUserRef.current = user;
      setIsConnected(false);
      setIsConnecting(false);
      return;
    }
    prevUserRef.current = user;

    const state = webSocketService.getState();
    setIsConnected(state === "CONNECTED");
    setIsConnecting(state === "CONNECTING");

    // Only reflect state changes — WebSocketService owns all reconnect logic
    const unsubConnected = webSocketService.subscribe("websocket_connected", () => {
      setIsConnected(true);
      setIsConnecting(false);
    });

    const unsubDisconnected = webSocketService.subscribe("websocket_disconnected", () => {
      setIsConnected(false);
      // Do NOT call connectWithRetry here — WebSocketService.attemptReconnect() handles it
    });

    const unsubError = webSocketService.subscribe("websocket_error", () => {
      setIsConnected(false);
      // Do NOT retry here — WebSocketService owns all reconnect attempts
    });

    const unsubMaxRetries = webSocketService.subscribe("websocket_max_retries", () => {
      setIsConnected(false);
      setIsConnecting(false);
      setMaxRetriesReached(true);
    });

    const unsubRetrying = webSocketService.subscribe("websocket_retrying", (data) => {
      setRetryCount((data as Record<string, number>).retryCount ?? 0);
    });

    connectRef.current?.(user.id);

    return () => {
      unsubConnected();
      unsubDisconnected();
      unsubError();
      unsubMaxRetries();
      unsubRetrying();
    };
  }, [user, businessProfileId]);

  const retryConnection = React.useCallback(() => {
    if (!user || !businessProfileId) return;
    setMaxRetriesReached(false);
    setRetryCount(0);
    connectRef.current?.(user.id);
  }, [user, businessProfileId]);

  const value: WebSocketContextType = {
    isConnected,
    isConnecting,
    retryCount,
    maxRetriesReached,
    retryConnection,
    subscribe: (eventType: string, handler: (data: Record<string, unknown>) => void) => {
      return webSocketService.subscribe(eventType, handler);
    },
  };

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error("useWebSocket must be used within WebSocketProvider");
  }
  return context;
}
