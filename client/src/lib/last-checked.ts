const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Health-check timestamps are only useful if people can tell how old they are.
 * Returns the absolute time, a relative age, and whether the check is stale.
 */
export function describeLastChecked(value: string | number | Date, now: number = Date.now()) {
  const checkedAt = new Date(value);
  const time = checkedAt.getTime();
  if (Number.isNaN(time)) return { text: "Last check time unknown", stale: true };
  const ageMs = Math.max(0, now - time);
  const days = Math.floor(ageMs / DAY_MS);
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const age = days >= 1 ? `${days} day${days === 1 ? "" : "s"} ago` : hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : "less than an hour ago";
  return { text: `Last checked ${checkedAt.toLocaleString()} (${age})`, stale: ageMs > DAY_MS };
}
