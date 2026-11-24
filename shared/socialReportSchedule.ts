/** Report scheduling syntax only. Occurrence/DST/recovery policy stays server-owned. */
export type FriendlyReportSchedule = {
  frequency: 'daily' | 'weekly' | 'monthly';
  localTime: string;
  timezone: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
};

function cronFieldIsValid(field: string, min: number, max: number): boolean {
  return field.split(',').every(raw => {
    // Number(''), Number('1e1') and an empty range endpoint are numeric in JS,
    // but are not numeric cron tokens. Validate spelling before conversion.
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(raw)) return false;
    const [base, stepText] = raw.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return false;
    if (base === '*') return true;
    const values = base.split('-').map(Number);
    return values[0] >= min && values[0] <= max
      && (values[1] === undefined || (values[1] >= values[0] && values[1] <= max));
  });
}

export function isValidSocialReportCron(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return cronFieldIsValid(fields[0], 0, 59) && cronFieldIsValid(fields[1], 0, 23)
    && cronFieldIsValid(fields[2], 1, 31) && cronFieldIsValid(fields[3], 1, 12)
    && cronFieldIsValid(fields[4], 0, 6);
}
