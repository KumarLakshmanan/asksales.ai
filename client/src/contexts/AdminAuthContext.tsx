"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/admin-api";
import { sessionCheckRetryDelays, withSessionCheckRetry } from "@/lib/sessionCheckRetry";

interface Admin {
  id: number;
  email: string;
  name: string;
  role: string;
}

interface AuthContextType {
  admin: Admin | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Set when the session could not be checked (network failure, timeout,
   * 5xx). The admin is not signed out; AdminProtectedRoute shows an error card
   * and re-checks. Only a 401/403 leaves `admin` null with no error. */
  error: string | null;
  login: (admin: Admin) => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AdminAuthContext = createContext<AuthContextType | undefined>(undefined);

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Each check, login and logout takes a new version so a slow check started
  // earlier can never overwrite a newer session decision.
  const version = useRef(0);
  const adminRef = useRef<Admin | null>(null);
  useEffect(() => { adminRef.current = admin; }, [admin]);

  const checkAuth = useCallback(async () => {
    const current = ++version.current;
    const isCurrent = () => current === version.current;
    // Always verify token with API - don't trust stale localStorage
    try {
      // A transient failure (network, timeout, 5xx) would otherwise drop the
      // admin to the login page; retry it first. 401/403 are never retried.
      const result = await withSessionCheckRetry(
        () => api.get<{ admin: Admin }>("/api/admin/me", { suppressUnauthorizedEvent: true, retryTransient: false }),
        sessionCheckRetryDelays(),
        isCurrent,
      );
      if (!result || !isCurrent()) return;
      localStorage.removeItem("admin_token");
      setAdmin(result.value.admin);
      setError(null);
      localStorage.setItem("admin", JSON.stringify(result.value.admin));
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
        // A real rejection: the api wrapper already cleared stored tokens.
        setAdmin(null);
        setError(null);
      } else if (!adminRef.current) {
        // Cached profile data never proves a session, but an outage is not a
        // sign-out either: show the error card (which keeps re-checking).
        setError("We could not check your admin session. Please try again.");
      }
      // An admin verified earlier in this page stays signed in when a later
      // re-check (for example after a profile edit) hits an outage; any real
      // 401 on another request still fires admin:unauthorized.
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Listen for 401 unauthorized events from admin-api.ts
  useEffect(() => {
    const handleUnauthorized = () => {
      ++version.current;
      setAdmin(null);
      setError(null);
      setIsLoading(false);
      router.replace("/admin/login");
    };
    window.addEventListener("admin:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("admin:unauthorized", handleUnauthorized);
  }, [router]);

  const login = (adminData: Admin) => {
    ++version.current;
    setError(null);
    setIsLoading(false);
    localStorage.removeItem("admin_token");
    localStorage.setItem("admin", JSON.stringify(adminData));
    setAdmin(adminData);
  };

  const logout = async () => {
    await api.post("/api/admin/logout", undefined, { suppressUnauthorizedEvent: true }).catch(() => undefined);
    localStorage.removeItem("admin_token");
    localStorage.removeItem("admin");
    ++version.current;
    setAdmin(null);
    setError(null);
    setIsLoading(false);
    router.replace("/admin/login");
  };

  return (
    <AdminAuthContext.Provider
      value={{ admin, isAuthenticated: !!admin, isLoading, error, login, logout, checkAuth }}
    >
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (context === undefined) {
    throw new Error("useAdminAuth must be used within an AdminAuthProvider");
  }
  return context;
}

export type { Admin };
