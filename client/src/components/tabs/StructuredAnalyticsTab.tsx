"use client";

import { BarChart3, Database, TrendingUp } from "lucide-react";
import {OperationResultCard} from '@/components/operations/OperationResultCard';
import type {CampaignReport} from '../../../../shared/campaignReporting';
import {campaignReportCard} from '../../../../shared/campaignReporting';

interface VisualizationPoint {
  label?: string;
  metric?: string;
  value?: number | string;
  change?: number;
  trend?: string;
  currency?: string;
}

interface Visualization {
  type?: string;
  title?: string;
  data?: VisualizationPoint[];
}

interface StructuredAnalyticsTabProps {
  data?: Record<string, unknown>;
}

function displayValue(value: unknown) {
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  return "—";
}

function AnalyticsVisualization({ visualization }: { visualization: Visualization }) {
  const points = Array.isArray(visualization.data) ? visualization.data : [];
  const numericValues = points
    .map(point => typeof point.value === "number" ? point.value : 0);
  const max = Math.max(...numericValues, 1);

  return (
    <section className="rounded-xl border border-border/50 bg-card p-4 shadow-sm" aria-label={visualization.title || "Analytics visualization"}>
      <div className="mb-4 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{visualization.title || "Metrics"}</h3>
      </div>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data is available for this view.</p>
      ) : visualization.type === "kpi" ? (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {points.map((point, index) => (
            <div key={`${point.metric || point.label || "metric"}-${index}`} className="rounded-lg bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{point.metric || point.label || "Metric"}</dt>
              <dd className="mt-1 text-xl font-semibold">{displayValue(point.value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <ul className="space-y-3">
          {points.map((point, index) => {
            const numericValue = typeof point.value === "number" ? point.value : 0;
            return (
              <li key={`${point.label || "point"}-${index}`} className="space-y-1">
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="truncate text-muted-foreground">{point.label || point.metric || "Value"}</span>
                  <span className="font-medium tabular-nums">{point.currency ? `${point.currency} ` : ''}{displayValue(point.value)}</span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={point.label || point.metric || "Metric"}
                  aria-valuemin={0}
                  aria-valuemax={max}
                  aria-valuenow={numericValue}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${Math.max(0, (numericValue / max) * 100)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function StructuredAnalyticsTab({ data }: StructuredAnalyticsTabProps) {
  const visualizations = Array.isArray(data?.visualizations)
    ? data.visualizations as Visualization[]
    : [];
  const analyticsData = data?.analyticsData;
  const reportCandidate=analyticsData && typeof analyticsData==='object' && 'report' in analyticsData ? analyticsData.report as CampaignReport : undefined;
  const report=reportCandidate?.version===1 && reportCandidate.source==='canonical_outreach' ? reportCandidate : undefined;
  const queryType = typeof data?.queryType === "string" ? data.queryType : "analytics";

  if (visualizations.length === 0 && analyticsData === undefined) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center p-6 text-center">
        <div>
          <Database className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">No analytics result yet</h2>
          <p className="mt-1 text-xs text-muted-foreground">Ask the performance agent for campaign, lead, or outreach analytics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background p-3 sm:p-4">
      <header className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-sm font-semibold capitalize">{queryType} analytics</h2>
          <p className="text-xs text-muted-foreground">Structured result from this conversation</p>
          {typeof data?.scopeLabel === 'string' && <p className="text-xs text-muted-foreground">{data.scopeLabel}</p>}
        </div>
      </header>
      {report && <div className="mb-4"><OperationResultCard result={campaignReportCard(report)}/></div>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {visualizations.map((visualization, index) => (
          <AnalyticsVisualization key={`${visualization.title || visualization.type || "chart"}-${index}`} visualization={visualization} />
        ))}
      </div>
    </div>
  );
}
