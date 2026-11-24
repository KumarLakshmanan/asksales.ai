/** Reporting dates are inclusive UTC calendar days, independent of the host timezone. */
export function isReportingDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function assertReportingRange(
  start: unknown,
  end: unknown,
  maxDays = 366,
): asserts start is string {
  if (
    !isReportingDate(start) ||
    !isReportingDate(end) ||
    start > end ||
    Date.parse(end) - Date.parse(start) > (maxDays - 1) * 86_400_000
  ) {
    throw new RangeError(
      `Choose real YYYY-MM-DD dates in order, spanning at most ${maxDays} days.`,
    );
  }
}

export function reportingPeriod(
  period: "7d" | "30d" | "90d",
  now = new Date(),
) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Number(period.slice(0, -1)) + 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** Start of a dashboard usage window: 24h, 7d, 30d or 90d before now (any other value means 7d). */
export function getDateRange(range: string): Date {
  const now = new Date();
  switch (range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
}
