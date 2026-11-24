import { scheduleToISOString } from './socialPublishing';

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

export function dateInTimezone(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  // Noon avoids browser-local DST transitions while this Date acts as a logical calendar day.
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
}

export function dateKeyInTimezone(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zonedDateTimeToUtc(dateOnly: string, timeOnly: string, timezone: string): Date {
  return new Date(scheduleToISOString(`${dateOnly}T${timeOnly}`, timezone));
}
