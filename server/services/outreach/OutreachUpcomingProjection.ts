/**
 * Estimates when waiting messages will actually go out. A message is "due" on
 * the day its next attempt falls, but a daily sending limit means only so many
 * leave each day; the rest roll over, and some run out of time first.
 *
 * Days here are limit days (UTC), because that is when the allowance resets.
 */

export interface WaitingGroup {
  /** UTC day the messages are next due. Anything already overdue arrives as today. */
  dueDay: string;
  /** Last UTC day they may still be sent; null when they never expire. */
  expiresDay: string | null;
  count: number;
}

export interface ProjectedDay {
  day: string;
  /** Messages whose next attempt falls on this day. */
  due: number;
  /** How many the daily limit lets through, oldest first. */
  expectedToSend: number;
  /** Still waiting at the end of the day because the limit was used up. */
  held: number;
  /** Ran out of time before the limit had room for them. */
  willExpire: number;
}

export interface Projection {
  days: ProjectedDay[];
  /** Still waiting after the last day shown, including messages due later. */
  afterRange: number;
}

const DAY = 86_400_000;
export const utcDay = (at: number | Date) => new Date(at).toISOString().slice(0, 10);
export const addUtcDays = (day: string, days: number) => utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY);

export function projectSends(groups: readonly WaitingGroup[], options: {
  today: string;
  /** Number of days to project, starting with today. */
  days: number;
  /** Messages allowed per day; null means no limit applies. */
  dailyLimit: number | null;
  /** Already sent today, which comes out of today's allowance. */
  usedToday: number;
}): Projection {
  const last = addUtcDays(options.today, options.days - 1);
  const arriving = new Map<string, WaitingGroup[]>();
  let afterRange = 0;
  for (const group of groups) {
    if (group.count <= 0) continue;
    const day = group.dueDay < options.today ? options.today : group.dueDay;
    if (day > last) { afterRange += group.count; continue; }
    arriving.set(day, [...(arriving.get(day) || []), group]);
  }

  const backlog: Array<{ expiresDay: string | null; count: number }> = [];
  const days: ProjectedDay[] = [];
  for (let index = 0; index < options.days; index++) {
    const day = addUtcDays(options.today, index);
    const today = arriving.get(day) || [];
    for (const group of today) backlog.push({ expiresDay: group.expiresDay, count: group.count });
    const due = today.reduce((sum, group) => sum + group.count, 0);

    let capacity = options.dailyLimit === null ? Number.POSITIVE_INFINITY
      : Math.max(0, options.dailyLimit - (index === 0 ? options.usedToday : 0));
    let expectedToSend = 0, willExpire = 0;
    // Oldest first. Anything whose time already ran out is dropped before it can use the allowance.
    for (const entry of backlog) {
      if (entry.expiresDay !== null && entry.expiresDay < day) { willExpire += entry.count; entry.count = 0; continue; }
      const sending = Math.min(entry.count, capacity);
      entry.count -= sending; capacity -= sending; expectedToSend += sending;
    }
    // What the limit left behind today cannot be sent tomorrow if today was its last day.
    for (const entry of backlog) {
      if (entry.count > 0 && entry.expiresDay !== null && entry.expiresDay <= day) { willExpire += entry.count; entry.count = 0; }
    }
    for (let at = backlog.length - 1; at >= 0; at--) if (backlog[at].count === 0) backlog.splice(at, 1);
    days.push({ day, due, expectedToSend, held: backlog.reduce((sum, entry) => sum + entry.count, 0), willExpire });
  }
  return { days, afterRange: afterRange + (days[days.length - 1]?.held ?? 0) };
}
