"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTheme } from "next-themes";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";

export type ThemePreference = "light" | "dark" | "system";

export interface UserPreferences {
  language: string;
  locale: string;
  currency: string;
  theme: ThemePreference;
  timezone: string;
  dateFormat: string;
  timeFormat: "12h" | "24h";
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  language: "en",
  locale: "en-US",
  currency: "USD",
  theme: "system",
  timezone: DEFAULT_BUSINESS_TIMEZONE,
  dateFormat: "MM/DD/YYYY",
  timeFormat: "12h",
};

interface PreferencesContextValue {
  preferences: UserPreferences;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePreferences: (updates: Partial<UserPreferences>) => Promise<UserPreferences>;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatCurrency: (value: number, currency?: string) => string;
}

const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined);

function normalizePreferences(value: Partial<UserPreferences> | null | undefined): UserPreferences {
  const merged = { ...DEFAULT_USER_PREFERENCES, ...(value ?? {}) };
  return {
    ...merged,
    theme: ["light", "dark", "system"].includes(merged.theme) ? merged.theme : "system",
    timeFormat: merged.timeFormat === "24h" ? "24h" : "12h",
  };
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { setTheme } = useTheme();
  // next-themes may replace its setter when the selected theme changes. A
  // refresh must follow the account, not that setter's identity: refetching
  // here can overwrite a local toggle while its preference save is in flight.
  const setThemeRef = useRef(setTheme);
  useLayoutEffect(() => { setThemeRef.current = setTheme; }, [setTheme]);
  const [preferences, setPreferences] = useState(DEFAULT_USER_PREFERENCES);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyPreferences = useCallback((next: UserPreferences) => {
    setPreferences(next);
    setThemeRef.current(next.theme);
    if (typeof document !== "undefined") {
      document.documentElement.lang = next.language;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      // Public pages use next-themes' local choice. Resetting to "system" here
      // races with the header toggle and makes the control appear unresponsive.
      setPreferences(DEFAULT_USER_PREFERENCES);
      if (typeof document !== "undefined") {
        document.documentElement.lang = DEFAULT_USER_PREFERENCES.language;
      }
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const response = await api.get<UserPreferences>("/api/settings/preferences");
      applyPreferences(normalizePreferences(response));
      setError(null);
    } catch {
      setError("Unable to load account preferences.");
    } finally {
      setIsLoading(false);
    }
  }, [applyPreferences, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) void refresh();
  }, [authLoading, refresh]);

  const updatePreferences = useCallback(async (updates: Partial<UserPreferences>) => {
    const payload = normalizePreferences({ ...preferences, ...updates });
    const response = await api.put<UserPreferences>("/api/settings/preferences", payload);
    const saved = normalizePreferences(response);
    applyPreferences(saved);
    setError(null);
    return saved;
  }, [applyPreferences, preferences]);

  const value = useMemo<PreferencesContextValue>(() => ({
    preferences,
    isLoading: authLoading || isLoading,
    error,
    refresh,
    updatePreferences,
    formatDate: (input, options) => {
      const date = input instanceof Date ? input : new Date(input);
      if (Number.isNaN(date.getTime())) return "";
      if (!options) {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: preferences.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(date);
        const part = (type: Intl.DateTimeFormatPartTypes) =>
          parts.find(candidate => candidate.type === type)?.value ?? "";
        const year = part("year");
        const month = part("month");
        const day = part("day");
        if (preferences.dateFormat === "DD/MM/YYYY") return `${day}/${month}/${year}`;
        if (preferences.dateFormat === "YYYY-MM-DD") return `${year}-${month}-${day}`;
        if (preferences.dateFormat === "MMM D, YYYY") {
          return new Intl.DateTimeFormat(preferences.locale, {
            timeZone: preferences.timezone,
            year: "numeric",
            month: "short",
            day: "numeric",
          }).format(date);
        }
        return `${month}/${day}/${year}`;
      }
      return new Intl.DateTimeFormat(preferences.locale, {
        timeZone: preferences.timezone,
        hour12: preferences.timeFormat === "12h",
        ...options,
      }).format(date);
    },
    formatCurrency: (amount, currency = preferences.currency) =>
      new Intl.NumberFormat(preferences.locale, {
        style: "currency",
        currency,
      }).format(amount),
  }), [authLoading, error, isLoading, preferences, refresh, updatePreferences]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used within PreferencesProvider");
  return context;
}
