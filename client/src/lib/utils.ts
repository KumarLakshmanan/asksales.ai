import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const IST_TIMEZONE = "Asia/Kolkata";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a date/timestamp to IST time string (e.g., "2:04 PM")
 */
export function formatTimeIST(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Format a date/timestamp to IST datetime string (e.g., "Jan 5, 2025 2:04 PM")
 */
export function formatDateTimeIST(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Format a date/timestamp to an unambiguous numeric IST datetime
 * (e.g., "13/05/2025, 06:00 pm").
 */
export function formatNumericDateTimeIST(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Format a date/timestamp to IST short time (e.g., "14:04")
 */
export function formatShortTimeIST(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Get the API base URL for production
 */
export function getApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
}

/**
 * Normalize an upload URL to ensure it works through the API proxy
 */
export function normalizeUploadUrl(url: string | undefined | null): string {
  if (!url) return "";

  if (url.startsWith("data:")) {
    return url;
  }

  if (url.startsWith("http")) {
    try {
      const parsed = new URL(url);
      const apiBase = getApiBaseUrl();
      const isConfiguredApi = apiBase && parsed.origin === new URL(apiBase).origin;
      if (isConfiguredApi && (parsed.pathname.startsWith("/api/uploads/") || parsed.pathname.startsWith("/uploads/"))) {
        const pathname = parsed.pathname.startsWith("/uploads/") ? `/api${parsed.pathname}` : parsed.pathname;
        return `${pathname}${parsed.search}`;
      }
    } catch {
      // Preserve malformed/external URLs; the media element will surface the error.
    }
    return url;
  }

  let normalized = url;
  if (normalized.startsWith("uploads/")) {
    normalized = "/" + normalized;
  } else if (normalized.startsWith("api/")) {
    normalized = "/" + normalized;
  }

  if (normalized.startsWith("/uploads/")) {
    return `/api${normalized}`;
  }

  return normalized;
}

/**
 * Safely parse a JSON string, returning a fallback value if parsing fails.
 * Prevents silent failures from bare JSON.parse calls.
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Build a URL query string for content-assets API requests.
 * Centralizes thread filtering and type parameters used across all content tabs.
 */
export function buildContentAssetsQuery(
  type: string,
  options: { threadId?: number; groupByThread?: boolean } = {}
): string {
  const params = new URLSearchParams({ type });
  if (options.threadId) params.append('threadId', options.threadId.toString());
  if (options.groupByThread) params.append('includeThread', 'true');
  return params.toString();
}

// ─── Currency formatting ──────────────────────────────────────────────────────

/**
 * Format a number as INR currency (e.g., ₹1,234 or ₹1.2k)
 */
export function formatCurrency(value: number): string {
  if (value >= 1000000) return `₹${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `₹${(value / 1000).toFixed(1)}k`;
  return `₹${value.toLocaleString("en-IN")}`;
}

export function formatCurrencyAmount(
  value: number | string,
  currency = "USD",
  options: { compact?: boolean } = {}
): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    notation: options.compact ? "compact" : "standard",
    maximumFractionDigits: options.compact ? 1 : 2,
  }).format(amount);
}

export function formatCurrencyBreakdown(
  values: Record<string, number | string> | null | undefined,
  options: { compact?: boolean } = {}
): string {
  const entries = Object.entries(values || {}).filter(([, value]) => Number(value) !== 0);
  if (entries.length === 0) return formatCurrencyAmount(0, "USD", options);
  if (entries.length > 2) return `${entries.length} currencies`;
  return entries.map(([currency, value]) => formatCurrencyAmount(value, currency, options)).join(" + ");
}

// ─── Date formatting ──────────────────────────────────────────────────────────

/**
 * Format a date to a human-readable short date (e.g., "Jan 5, 2025")
 */
export function formatDate(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: IST_TIMEZONE,
  });
}

/**
 * Format a date to relative time (e.g., "2 hours ago", "yesterday")
 */
export function formatRelativeTime(date: Date | number | string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatDate(d);
}
