/** Add stable identifiers only to choices whose visible labels collide. */
export function disambiguateOptionLabels<T>(
  items: readonly T[],
  label: (item: T) => string,
  distinguish: (item: T, label: string) => string,
): string[] {
  const labels = items.map(label);
  // Native options collapse whitespace, so differently spaced names can still
  // look identical to the person choosing a record.
  const visible = labels.map(value => value.replace(/\s+/g, ' ').trim());
  const counts = new Map<string, number>();
  visible.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return labels.map((value, index) => counts.get(visible[index])! > 1
    ? distinguish(items[index], value)
    : value);
}
