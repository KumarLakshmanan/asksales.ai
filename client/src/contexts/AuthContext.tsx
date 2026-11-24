"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { shouldSkipOwnerAuthCheck } from "@/lib/authSurface";
import { sessionCheckRetryDelays, withSessionCheckRetry } from "@/lib/sessionCheckRetry";
import { prefetchDashboardGates } from "@/lib/startup-queries";
import { toast } from "@/hooks/use-toast";

interface User {
  id: number;
  email: string;
  name: string;
  avatar?: string;
  companyName?: string;
  isSetupComplete?: boolean;
  isApproved?: boolean;
  hasBusinessProfile?: boolean;
  hasBrandToolkit?: boolean;
  workspaceRole?: 'owner' | 'billing_admin' | 'member' | null;
  businessProfileId?: number | null;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  workspaceRole: 'owner' | 'billing_admin' | 'member' | null;
  isSetupComplete: boolean;
  isApproved: boolean;
  hasBusinessProfile: boolean;
  hasBrandToolkit: boolean;
  login: (user: User) => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  setSetupComplete: (complete: boolean) => void;
  setHasBusinessProfile: (has: boolean) => void;
  setHasBrandToolkit: (has: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authCheckGeneration = useRef(0);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  // Phase 6.8 / CLIENT-008: initial values for hasBusinessProfile /
  // hasBrandToolkit are read from localStorage so the first paint doesn't
  // flicker through the empty "false" state while /api/auth/me is in flight.
  const [hasBusinessProfile, setHasBusinessProfile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("hasBusinessProfile") === "true";
  });
  const [hasBrandToolkit, setHasBrandToolkit] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("hasBrandToolkit") === "true";
  });
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const skipOwnerAuthCheck = shouldSkipOwnerAuthCheck(pathname);

  // Phase 6.8: persist flag changes. Using a small effect with the setters
  // wrapped via the setState callback form would also work, but a direct
  // effect on the state values is simpler and avoids wrapping the public
  // setters that the rest of the app uses.
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("hasBusinessProfile", String(hasBusinessProfile));
  }, [hasBusinessProfile]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("hasBrandToolkit", String(hasBrandToolkit));
  }, [hasBrandToolkit]);

  const checkAuth = useCallback(async () => {
    const generation = ++authCheckGeneration.current;
    if (skipOwnerAuthCheck) {
      setUser(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    // Dashboard pages wait on plan access and the business profiles after
    // sign-in. Ask for both now, for the account this browser last signed in
    // as; they are only read once this check confirms that account.
    if (window.location.pathname.startsWith("/dashboard")) {
      let cachedUserId: unknown;
      try { cachedUserId = JSON.parse(localStorage.getItem("user") || "null")?.id; } catch { /* No usable cached account. */ }
      if (typeof cachedUserId === "number") prefetchDashboardGates(queryClient, cachedUserId);
    }
    try {
      // Transient failures (network, timeout, 5xx) do not decide the session,
      // so retry them before showing the error card. Loading stays on the
      // whole time: protected content never renders before a verified 200.
      const result = await withSessionCheckRetry(
        () => api.get<{ user: User }>("/api/auth/me", { suppressUnauthorizedEvent: true, retryTransient: false }),
        sessionCheckRetryDelays(),
        () => generation === authCheckGeneration.current,
      );
      if (!result || generation !== authCheckGeneration.current) return;
      const data = result.value;
      localStorage.removeItem("token");
      // A cookie session can be restored without a previous login in this tab.
      // Profile selection and request headers need the verified account first.
      let previousAccount: number | undefined;
      try { previousAccount = JSON.parse(localStorage.getItem("user") || "null")?.id; } catch { /* Discard an invalid cached account. */ }
      if (previousAccount !== data.user?.id) queryClient.clear();
      localStorage.setItem("user", JSON.stringify(data.user));
      setUser(data.user);
      setIsSetupComplete(data.user?.isSetupComplete || false);
      setIsApproved(data.user?.isApproved || false);
      setHasBusinessProfile(data.user?.hasBusinessProfile || false);
      setHasBrandToolkit(data.user?.hasBrandToolkit || false);
      setError(null);
    } catch (error: unknown) {
      if (generation !== authCheckGeneration.current) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        queryClient.clear();
        setUser(null);
        setError(null);
        setIsSetupComplete(false);
        setIsApproved(false);
        setHasBusinessProfile(false);
        setHasBrandToolkit(false);
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      } else if (error instanceof ApiError && error.status === 429) {
        setError("Too many requests. Please try again later.");
      } else {
        setError("We could not reach the server to confirm your sign-in. Nothing was lost: this page opens as soon as the server responds.");
      }
    } finally {
      if (generation === authCheckGeneration.current) setIsLoading(false);
    }
  }, [skipOwnerAuthCheck, queryClient]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Account storage is shared across tabs, while the verified React session is
  // local to this document. Recheck the cookie before using a changed account's
  // workspace selection; cached profile data is not authentication evidence.
  useEffect(() => {
    const handleAccountStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'user' || event.key === null)) void checkAuth();
    };
    window.addEventListener('storage', handleAccountStorage);
    return () => window.removeEventListener('storage', handleAccountStorage);
  }, [checkAuth]);

  // Listen for 401 unauthorized events dispatched by the API client and redirect to login
  useEffect(() => {
    const handleUnauthorized = () => {
      authCheckGeneration.current += 1;
      queryClient.clear();
      setUser(null);
      setError(null);
      setIsLoading(false);
      setIsSetupComplete(false);
      setIsApproved(false);
      setHasBusinessProfile(false);
      setHasBrandToolkit(false);
      // Phase 6.8: clear the persisted flags too.
      localStorage.removeItem("hasBusinessProfile");
      localStorage.removeItem("hasBrandToolkit");
      localStorage.removeItem("user");
      router.push("/login");
    };
    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, [queryClient, router]);

  const login = (userData: User) => {
    authCheckGeneration.current += 1;
    // Tenant-scoped query data must never survive an account transition in
    // the same browser session (for example, cached business profile IDs).
    queryClient.clear();
    localStorage.removeItem("token");
    localStorage.setItem("user", JSON.stringify(userData));
    setUser(userData);
    setError(null);
    setIsLoading(false);
    setIsSetupComplete(userData?.isSetupComplete || false);
    setIsApproved(userData?.isApproved || false);
    setHasBusinessProfile(userData?.hasBusinessProfile || false);
    setHasBrandToolkit(userData?.hasBrandToolkit || false);
  };

  const logout = async () => {
    const generation = ++authCheckGeneration.current;
    try {
      await api.post("/api/auth/logout", undefined, { suppressUnauthorizedEvent: true });
    } catch {
      if (generation === authCheckGeneration.current) toast({ title: "Sign out was not completed",
        description: "The server could not confirm sign out. Please try again.", variant: "destructive" });
      return;
    }
    if (generation !== authCheckGeneration.current) return;
    queryClient.clear();
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    // Phase 6.8: clear the persisted flags.
    localStorage.removeItem("hasBusinessProfile");
    localStorage.removeItem("hasBrandToolkit");
    setUser(null);
    setError(null);
    setIsSetupComplete(false);
    setIsApproved(false);
    setHasBusinessProfile(false);
    setHasBrandToolkit(false);
    router.replace("/");
  };

  const clearError = () => {
    setError(null);
  };

  const handleSetSetupComplete = (complete: boolean) => {
    setIsSetupComplete(complete);
    if (user) {
      const updatedUser = { ...user, isSetupComplete: complete };
      setUser(updatedUser);
      localStorage.setItem("user", JSON.stringify(updatedUser));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        error,
        workspaceRole: user?.workspaceRole ?? null,
        isSetupComplete: isSetupComplete || (!!hasBusinessProfile && ['member', 'billing_admin'].includes(user?.workspaceRole ?? '')),
        isApproved,
        hasBusinessProfile,
        hasBrandToolkit,
        login,
        logout,
        checkAuth,
        clearError,
        setSetupComplete: handleSetSetupComplete,
        setHasBusinessProfile,
        setHasBrandToolkit,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
