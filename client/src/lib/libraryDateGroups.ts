import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";

export interface DateGroup<T> {
  /** Calendar day (YYYY-MM-DD) in the business timezone, or "undated". */
  key: string;
  /** "Today", "Yesterday", or e.g. "Thu, Nov 12, 2026". */
  label: string;
  items: T[];
}

function dayKey(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which also sorts lexically by date.
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

function timeOf(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return new Date(value).getTime();
}

/**
 * Sort newest first and group by calendar day in the business timezone, so the
 * group headings match the dates printed on each card. Items without a valid
 * date go last, under "Undated".
 */
export function groupByDay<T>(
  items: readonly T[],
  getDate: (item: T) => string | number | Date | null | undefined,
  options: { now?: Date; timeZone?: string } = {},
): DateGroup<T>[] {
  const timeZone = options.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const now = options.now || new Date();
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000), timeZone);
  const sorted = [...items].sort((a, b) => {
    const left = timeOf(getDate(a));
    const right = timeOf(getDate(b));
    if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
  const groups: DateGroup<T>[] = [];
  for (const item of sorted) {
    const time = timeOf(getDate(item));
    const key = Number.isNaN(time) ? "undated" : dayKey(new Date(time), timeZone);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label = key === "undated"
        ? "Undated"
        : key === today
          ? "Today"
          : key === yesterday
            ? "Yesterday"
            : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(time));
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
