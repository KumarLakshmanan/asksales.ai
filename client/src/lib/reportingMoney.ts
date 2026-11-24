/** Keep each recorded currency visible; absence of a verified currency is not a rupee amount. */
export function formatReportingMoney(
  totals?: Record<string, number>,
  legacy?: number | null,
  currency?: string | null,
) {
  const entries = totals
    ? Object.entries(totals)
    : legacy != null && currency
      ? [[currency, legacy] as const]
      : [];
  if (!entries.length) return "—";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, value]) => {
      if (!/^[A-Z]{3}$/.test(code))
        return `${Number(value)} (currency unavailable)`;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
        currencyDisplay: "code",
      }).format(Number(value));
    })
    .join(" · ");
}
