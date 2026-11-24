import { isValidSocialReportCron } from '../../../shared/socialReportSchedule';
import { isEmailAddress } from '../../../shared/emailAddress';

export const isIanaTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
};

export const isHttpsUrl = (value: string) => /^https:\/\/[^\s]+$/i.test(value.trim());

export function validateAnalyticsWindow(startDate: string, endDate: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return "Choose a valid start and end date.";
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime())
    || Number.isNaN(end.getTime())
    || start.toISOString().slice(0, 10) !== startDate
    || end.toISOString().slice(0, 10) !== endDate
  ) return "Choose a valid start and end date.";
  if (start > end) return "Start date must be on or before the end date.";
  if (endDate > new Date().toISOString().slice(0, 10)) return "Analytics cannot be synchronized for a future date.";
  if (end.getTime() - start.getTime() > 366 * 86_400_000) return "Choose a date window of 366 days or less.";
  if (!isIanaTimezone(timezone)) return "Enter an IANA timezone such as Asia/Kolkata or UTC.";
  return null;
}

export const isOptionalEmail = (value: string) => !value || isEmailAddress(value.trim());
export const isOptionalFiveFieldCron = (value: string) => !value || isValidSocialReportCron(value);

export function latestBestTimesByAccount<T extends { platform: string; account_identifier: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.platform}:${item.account_identifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
