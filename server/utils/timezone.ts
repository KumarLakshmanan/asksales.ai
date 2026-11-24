export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a wall-clock date/time in an IANA timezone to its UTC instant.
 * Repeating once handles daylight-saving offsets around most boundaries.
 */
export function zonedDateTimeToUtc(
  date: string,
  time: string,
  timezone: string,
): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)
    || !isValidIanaTimezone(timezone)
  ) {
    return null;
  }

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) {
    return null;
  }

  const requestedWallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = requestedWallClock;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const representedWallClock = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess += requestedWallClock - representedWallClock;
  }

  const result = new Date(guess);
  return Number.isNaN(result.getTime()) ? null : result;
}
