"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supportApi, ApiError } from "@/lib/support-api";
import { toast } from "@/hooks/use-toast";
import { sessionCheckRetryDelays, withSessionCheckRetry } from "@/lib/sessionCheckRetry";

interface SupportMember {
  id: number;
  name: string;
  email: string;
  role: string;
  teamId: number;
  teamName: string | null;
  isActive: boolean;
  avatar?: string;
}

interface SupportAuthContextType {
  member: SupportMember | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  checkAuth: () => Promise<void>;
  login: (member: SupportMember) => void;
  logout: () => Promise<void>;
}

const SupportAuthContext = createContext<SupportAuthContextType | undefined>(undefined);

export function SupportAuthProvider({ children }: { children: React.ReactNode }) {
  const [member, setMember] = useState<SupportMember | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Transient failures (network, timeout, 5xx) are retried before the
      // "could not be checked" card; the portal stays in its loading state.
      const data = (await withSessionCheckRetry(
        () => supportApi.get<SupportMember>("/api/support-portal/me", { suppressUnauthorizedEvent: true, retryTransient: false }),
        sessionCheckRetryDelays(),
      ))!.value;
      localStorage.removeItem("support_token");
      setMember(data);
      localStorage.setItem("support_member", JSON.stringify(data));
    } catch (error) {
      // Cached member details never prove authentication. Only an explicit
      // authentication rejection should present this as a signed-out session.
      setMember(null);
      if (!(error instanceof ApiError) || ![401, 403].includes(error.status ?? 0)) {
        setError("We could not check your support session. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!member) return;
    let stopped = false;
    const heartbeat = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      await supportApi.post("/api/support-portal/presence/heartbeat", undefined, { suppressUnauthorizedEvent: true })
        .catch(() => undefined);
    };
    void heartbeat();
    const interval = window.setInterval(() => { void heartbeat(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [member]);

  // Listen for 401 unauthorized events from support-api.ts
  useEffect(() => {
    const handleUnauthorized = () => {
      setMember(null);
      router.replace("/support/login");
    };
    window.addEventListener("support:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("support:unauthorized", handleUnauthorized);
  }, [router]);

  const login = (memberData: SupportMember) => {
    setError(null);
    localStorage.removeItem("support_token");
    localStorage.setItem("support_member", JSON.stringify(memberData));
    setMember(memberData);
  };

  const logout = async () => {
    try {
      await supportApi.post("/api/support-portal/logout", undefined, { suppressUnauthorizedEvent: true });
    } catch {
      toast({ title: "Sign out was not completed", description: "The server could not confirm sign out. Please try again.", variant: "destructive" });
      return;
    }
    localStorage.removeItem("support_token");
    localStorage.removeItem("support_member");
    setMember(null);
    router.replace("/support/login");
  };

  return (
    <SupportAuthContext.Provider
      value={{ member, isAuthenticated: !!member, isLoading, error, checkAuth, login, logout }}
    >
      {children}
    </SupportAuthContext.Provider>
  );
}

export function useSupportAuth() {
  const context = useContext(SupportAuthContext);
  if (!context) {
    throw new Error("useSupportAuth must be used within SupportAuthProvider");
  }
  return context;
}
