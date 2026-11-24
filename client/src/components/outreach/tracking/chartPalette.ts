import { cn } from "@/lib/utils";

/**
 * One colour per thing, the same on every tracking chart: "sent" is the same
 * blue in the day-by-day lines, the breakdown bar and the template bars.
 * Light and dark steps were both checked for colour-blind separation. Three of
 * the light steps sit under 3:1 on a white card, so every chart also carries a
 * labelled legend and a table of the same numbers.
 */
export const chartColor = {
  sent: "var(--series-sent)",
  delivered: "var(--series-delivered)",
  read: "var(--series-read)",
  failed: "var(--series-failed)",
  attention: "var(--series-attention)",
  /** Not yet sent: a neutral, so it never competes with an outcome. */
  waiting: "var(--series-waiting)",
} as const;
export type ChartColorKey = keyof typeof chartColor;

/** Put on a chart's wrapper to define the colours for both themes. */
export const chartPaletteClass = cn(
  "[--series-sent:#2a78d6] [--series-delivered:#eb6834] [--series-read:#1baf7a] [--series-failed:#eda100] [--series-attention:#e87ba4] [--series-waiting:#9a9a94]",
  "dark:[--series-sent:#3987e5] dark:[--series-delivered:#d95926] dark:[--series-read:#199e70] dark:[--series-failed:#c98500] dark:[--series-attention:#d55181] dark:[--series-waiting:#6f6f6a]",
);

export const chartAxisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;
export const chartGridStroke = "hsl(var(--border))";
export const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
