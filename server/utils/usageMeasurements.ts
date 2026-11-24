type Measurement = number | string | null | undefined;

function measured(value: Measurement): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A complete sum may be zero; a sum with missing observations is unavailable. */
export function summarizeUsageMeasurements(rows: Array<{
  tokens: Measurement; costCents: Measurement; durationMs?: Measurement;
}>) {
  const tokens = rows.map(row => measured(row.tokens)).filter(value => value !== null);
  const costs = rows.map(row => measured(row.costCents)).filter(value => value !== null);
  const durations = rows.map(row => measured(row.durationMs)).filter(value => value !== null);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const totalDurationMs = sum(durations);
  return {
    calls: rows.length,
    tokens: tokens.length === rows.length ? sum(tokens) : null,
    costCents: costs.length === rows.length ? sum(costs) : null,
    measuredTokenCalls: tokens.length,
    measuredCostCalls: costs.length,
    measuredDurationCount: durations.length,
    totalDurationMs,
    avgLatency: durations.length ? totalDurationMs / durations.length : null,
  };
}
