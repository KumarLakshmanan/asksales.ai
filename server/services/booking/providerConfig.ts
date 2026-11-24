/** Until a named PMS contract exists, local inventory is the supported source. */
export function resolveBookingProviderKind(value: string | undefined = process.env.BOOKING_PROVIDER): 'local' {
  const kind = (value || 'local').trim().toLowerCase();
  if (kind !== 'local') throw new Error(
    `BOOKING_PROVIDER=${kind} is unsupported. Set BOOKING_PROVIDER=local to use managed room inventory. External PMS availability requires a named provider integration before it can be enabled.`,
  );
  return 'local';
}
