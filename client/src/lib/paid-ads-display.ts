/** Compact number (1.2K, 3.4M), or an em dash for non-finite values. */
export function compact(value: number) { if (!Number.isFinite(value)) return "—"; return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }

/** Recommendation title, with generic tracking-improvement titles shown as "Restore campaign measurement". */
export function recommendationTitle(item: { category: string; title: string }) {
  return item.category === "tracking" && /^tracking improvement\b/i.test(item.title)
    ? "Restore campaign measurement"
    : item.title;
}
