"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TemplatePerformance } from "../../../../../shared/outreachTracking";
import { chartAxisTick, chartColor, chartGridStroke, compactNumber } from "./chartPalette";
import { formatCount, formatShare } from "./status";

const MAX_TEMPLATES = 8;
const series = [["sent", "Sent", chartColor.sent], ["delivered", "Delivered", chartColor.delivered], ["read", "Read", chartColor.read]] as const;
const shorten = (name: string) => name.length > 18 ? `${name.slice(0, 17)}…` : name;

function TemplateTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: TemplatePerformance }> }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const rows: Array<[string, string, string | null]> = [
    ["Sent", formatCount(row.sent), chartColor.sent],
    ["Delivered", `${formatCount(row.delivered)} · ${formatShare(row.delivered, row.sent)} of sent`, chartColor.delivered],
    ["Read", `${formatCount(row.read)} · ${formatShare(row.read, row.delivered)} of delivered`, chartColor.read],
    ["Failed", formatCount(row.failed), null],
  ];
  return (
    <div className="max-w-xs rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 break-all font-medium">{row.templateName}{row.templateLanguage ? ` (${row.templateLanguage})` : ""}</p>
      <ul className="space-y-1">
        {rows.map(([label, value, color]) => (
          <li key={label} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color ?? "transparent" }} aria-hidden="true" />
            <span className="font-semibold tabular-nums text-foreground">{value}</span>
            <span className="text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-muted-foreground">Select to see its outreaches.</p>
    </div>
  );
}

/** Sent, delivered and read side by side for the most-used templates. Selecting a template lists its outreaches. */
export function TemplatesChart({ templates, onSelect }: { templates: readonly TemplatePerformance[]; onSelect: (templateName: string) => void }) {
  const top = templates.filter(row => row.sent > 0).slice(0, MAX_TEMPLATES);
  if (top.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Chart legend">
          {series.map(([key, label, color]) => (
            <li key={key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden="true" />
              <span className="text-muted-foreground">{label}</span>
            </li>
          ))}
        </ul>
        {templates.length > top.length ? <p className="text-xs text-muted-foreground">Showing the {top.length} most-used templates. The table has all of them.</p> : null}
      </div>
      <div style={{ height: top.length * 54 + 36 }} className="w-full" role="img"
        aria-label={`Bar chart comparing sent, delivered and read for ${top.length} templates. The table below has every number.`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top as TemplatePerformance[]} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barGap={2} barCategoryGap={10}>
            <CartesianGrid horizontal={false} stroke={chartGridStroke} />
            <XAxis type="number" allowDecimals={false} tickFormatter={value => compactNumber.format(Number(value))} tick={chartAxisTick} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="templateName" width={132} tickFormatter={shorten} tick={chartAxisTick} tickLine={false} axisLine={{ stroke: chartGridStroke }} />
            <Tooltip content={<TemplateTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} />
            {series.map(([key, label, color]) => (
              <Bar key={key} dataKey={key} name={label} fill={color} maxBarSize={10} radius={[0, 4, 4, 0]} isAnimationActive={false} className="cursor-pointer"
                onClick={(entry: { payload?: TemplatePerformance }) => { if (entry?.payload) onSelect(entry.payload.templateName); }} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
