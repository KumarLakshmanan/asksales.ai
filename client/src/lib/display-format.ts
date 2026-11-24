/** Display formatters shared by dashboard and admin pages. Each keeps the exact output of the copies it replaced. */

/** "Jan 5, 02:30 PM" (en-US, no year), or "—" when missing. */
export const formatShortDateTime = (dateStr?: string) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** "Jan 5, 2026, 02:30 PM" (en-US), or "—" when missing. */
export const formatDateTimeWithYear = (dateStr?: string) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** "Jan 5, 2026" (en-US), or "—" when missing. */
export const formatMediumDate = (dateStr?: string | null) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

/** "02:30 PM" (en-US), or "" when missing. */
export const formatShortTime = (dateStr?: string | null) => {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** The browser-locale date for a timestamp or date string, or "" when missing. */
export const formatLocaleDate = (date: string | number | undefined) => {
  if (!date) return '';
  return typeof date === 'number'
    ? new Date(date).toLocaleDateString()
    : new Date(date).toLocaleDateString();
};

/** Local calendar date as YYYY-MM-DD. */
export const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** File size in Bytes/KB/MB/GB with up to two decimals, or "" for 0 or missing. */
export const formatFileSize = (bytes?: number | null) => {
  if (!bytes || bytes === 0) return "";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

/** 1.2M / 3.4K / plain integer string. */
export const formatCount = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

/** Compact number (1.2K), or "—" when the value is null or undefined. */
export const compactMetric = (value?: number | null) =>
  value == null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
