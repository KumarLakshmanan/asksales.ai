"use client";

import styles from "@/components/marketing/marketing.module.css";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FriendlyReportSchedule } from "../../../../shared/socialReportSchedule";
import { api } from "@/lib/api";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import {
  isIanaTimezone,
  isOptionalEmail,
  isOptionalFiveFieldCron,
  validateAnalyticsWindow,
} from "@/lib/socialAnalyticsValidation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Eye, Pencil, MoreHorizontal, CalendarClock } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Filters = {
  platform?: string;
  accountIdentifier?: string;
  start?: string;
  end?: string;
  relativeDays?: number;
  timezone?: string;
};
type Report = {
  id: string;
  name: string;
  filters: Filters;
  paused?: boolean;
  schedule_cron?: string | null;
  schedule_definition?: FriendlyReportSchedule | null;
  delivery_channel?: string;
  delivery_target?: string | null;
};
type Payload = {
  generatedAt?: string;
  filters?: Filters;
  snapshots?: Array<Record<string, unknown>>;
  citations?: unknown[];
  csv?: string;
  truncated?: boolean;
};
type Delivery = {
  id: string;
  status: string;
  attempted_at: string;
  export_id?: string;
  error_message?: string;
  preparation_version?: number;
  dispatch_started_at?: string | null;
};
const selectClass =
  "mt-1 block min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm";
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The report request failed. Please retry.";
const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function SocialReportsPanel({
  platform,
  accountIdentifier,
  accountName,
  startDate,
  endDate,
  timezone,
  revision,
}: {
  platform: string;
  accountIdentifier?: string | null;
  accountName?: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  revision: number;
}) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [sourceReport, setSourceReport] = useState<Report | null>(null);
  const [editing, setEditing] = useState<Report | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [day, setDay] = useState("1");
  const [time, setTime] = useState("09:00");
  const [zone, setZone] = useState(timezone);
  const [period, setPeriod] = useState("30");
  const [rangeStart, setRangeStart] = useState(startDate);
  const [rangeEnd, setRangeEnd] = useState(endDate);
  const [delivery, setDelivery] = useState("in_app");
  const [recipient, setRecipient] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Report | null>(null);
  const [preview, setPreview] = useState<{
    report: Report;
    payload: Payload;
  } | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const request = useRef(0);
  useEffect(() => () => {
    historyRequest.current++;
  }, []);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const rows = await socialInsightsGet<Report[]>(
        "/api/social-analytics/reports",
      );
      if (id === request.current) {
        setReports(rows);
        setError(null);
      }
    } catch (cause) {
      if (id === request.current) setError(message(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    // Skip ticks while a read is still running so a slow read is not discarded.
    let polling = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || polling || loadingRef.current) return;
      polling = true;
      void load().finally(() => { polling = false; });
    }, 60000);
    return () => {
      clearInterval(timer);
      request.current++;
    };
  }, [load, revision]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const openEditor = (report?: Report, duplicate = false) => {
    setSourceReport(report || null);
    setEditing(duplicate ? null : report || null);
    setName(report ? `${report.name}${duplicate ? " copy" : ""}` : "");
    setCron(report?.schedule_cron || "");
    setFrequency(
      report?.schedule_definition?.frequency ||
        (report?.schedule_cron ? "custom_cron" : "on_demand"),
    );
    setDay(
      String(
        report?.schedule_definition?.dayOfWeek ??
          report?.schedule_definition?.dayOfMonth ??
          1,
      ),
    );
    setTime(report?.schedule_definition?.localTime || "09:00");
    setZone(report?.schedule_definition?.timezone || timezone);
    setPeriod(String(report?.filters.relativeDays || 30));
    setDelivery(report?.delivery_channel || "in_app");
    setRecipient(report?.delivery_target || "");
    setRangeStart(report?.filters.start?.slice(0, 10) || startDate);
    setRangeEnd(report?.filters.end?.slice(0, 10) || endDate);
    setError(null);
    setEditorOpen(true);
  };
  const save = () =>
    run(async () => {
      const filters: Filters = {
        ...(sourceReport
          ? {
              platform: sourceReport.filters.platform,
              accountIdentifier: sourceReport.filters.accountIdentifier,
            }
          : { platform, accountIdentifier: accountIdentifier || undefined }),
        ...(frequency === "on_demand"
          ? {
              start: `${rangeStart}T00:00:00.000Z`,
              end: `${rangeEnd}T23:59:59.999Z`,
            }
          : {
              relativeDays: Number(period),
              timezone: frequency === "custom_cron" ? "UTC" : zone,
            }),
      };
      const schedule = ["on_demand", "custom_cron"].includes(frequency)
        ? null
        : {
            frequency,
            localTime: time,
            timezone: zone,
            ...(frequency === "weekly"
              ? { dayOfWeek: Number(day) }
              : frequency === "monthly"
                ? { dayOfMonth: Number(day) }
                : {}),
          };
      const body = {
        name: name.trim(),
        filters,
        schedule,
        scheduleCron: frequency === "custom_cron" ? cron : null,
        deliveryChannel: delivery,
        deliveryTarget: delivery === "email" ? recipient.trim() : null,
      };
      if (editing)
        await api.patch(`/api/social-analytics/reports/${editing.id}`, body);
      else await api.post("/api/social-analytics/reports", body);
      setEditorOpen(false);
      await load();
      setNotice(editing ? "Report updated." : "Report created.");
    });
  const loadDeliveryHistory = async (reportId: string) => {
    const id = ++historyRequest.current;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    try {
      const rows = await socialInsightsGet<Delivery[]>(
        `/api/social-analytics/reports/${reportId}/deliveries`,
      );
      if (id === historyRequest.current) setDeliveries(rows);
    } catch (cause) {
      if (id === historyRequest.current) setDeliveriesError(message(cause));
    } finally {
      if (id === historyRequest.current) setDeliveriesLoading(false);
    }
  };
  const exportReport = (
    report: Report,
    format: "preview" | "csv" | "pdf" | "json",
    exportId?: string,
  ) =>
    run(async () => {
      const result = exportId
        ? await socialInsightsGet<{ payload: Payload }>(
            `/api/social-analytics/reports/${report.id}/exports/${exportId}`,
          )
        : await api.post<{ payload: Payload }>(
            `/api/social-analytics/reports/${report.id}/export`,
            { format: format === "csv" ? "csv" : "json" },
          );
      if (format === "preview") {
        setPreview({ report, payload: result.payload });
        setDeliveries([]);
        await loadDeliveryHistory(report.id);
        return;
      }
      const safeName =
        report.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "social-report";
      if (format === "csv")
        download(
          `${safeName}.csv`,
          result.payload.csv || "",
          "text/csv;charset=utf-8",
        );
      else if (format === "json")
        download(
          `${safeName}.json`,
          JSON.stringify(result.payload, null, 2),
          "application/json",
        );
      else {
        const [{ jsPDF }, { default: autoTable }] = await Promise.all([
          import("jspdf"),
          import("jspdf-autotable"),
        ]);
        const doc = new jsPDF({ orientation: "landscape" });
        doc.setFontSize(18);
        doc.text(report.name, 14, 18);
        doc.setFontSize(10);
        doc.text(
          `AskSales Social Insights | ${new Date(result.payload.generatedAt || Date.now()).toLocaleString()}`,
          14,
          26,
        );
        autoTable(doc, {
          startY: 32,
          head: [["Platform", "Account", "Period", "Metrics"]],
          body: (result.payload.snapshots || []).map((row) => [
            String(row.platform),
            String(row.account_identifier),
            `${String(row.metric_window_start)} - ${String(row.metric_window_end)}`,
            JSON.stringify(row.metrics),
          ]),
          styles: { fontSize: 7 },
          columnStyles: { 3: { cellWidth: 90 } },
        });
        if (result.payload.snapshots?.length) {
          doc.addPage();
          doc.setFontSize(18);
          doc.text("Snapshot citations", 14, 18);
          doc.setFontSize(10);
          doc.text("Metric dates use UTC. References identify the captured source evidence.", 14, 26);
          autoTable(doc, {
            startY: 32,
            head: [["Snapshot ID", "Source", "Source reference", "Captured at"]],
            body: result.payload.snapshots.map((row) => [
              String(row.id),
              String(row.source),
              String(row.source_snapshot_id),
              String(row.captured_at),
            ]),
            styles: { fontSize: 7 },
          });
        }
        doc.save(`${safeName}.pdf`);
      }
      setNotice(
        `${format.toUpperCase()} downloaded.${result.payload.truncated ? " The export reached its row limit; narrow the reporting window." : ""}`,
      );
    });
  const linkedExportOpened = useRef(false);
  useEffect(() => {
    if (linkedExportOpened.current || !reports.length) return;
    const params = new URLSearchParams(window.location.search);
    const report = reports.find((row) => row.id === params.get("report"));
    const exportId = params.get("export");
    if (report && exportId) {
      linkedExportOpened.current = true;
      void exportReport(report, "preview", exportId);
    }
  });
  const visibleReports = reports.filter(
    (report) =>
      (!report.filters?.platform || report.filters.platform === platform) &&
      (!report.filters?.accountIdentifier ||
        report.filters.accountIdentifier === accountIdentifier),
  );
  const cronValid = Boolean(cron.trim()) && isOptionalFiveFieldCron(cron);
  const valid =
    (frequency !== "custom_cron" ||
      cronValid) &&
    (frequency !== "on_demand" ||
      !validateAnalyticsWindow(rangeStart, rangeEnd, "UTC")) &&
    name.trim() &&
    name.length <= 160 &&
    accountIdentifier &&
    (frequency === "custom_cron" || isIanaTimezone(zone)) &&
    (delivery !== "email" ||
      (recipient.trim() && isOptionalEmail(recipient))) &&
    (frequency === "on_demand" || frequency === "custom_cron" || /^\d\d:\d\d$/.test(time)) &&
    (frequency !== "monthly" || (Number(day) >= 1 && Number(day) <= 28)) &&
    (frequency !== "weekly" || (Number(day) >= 0 && Number(day) <= 6));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Saved and scheduled reports</h2>
          <p className="text-sm text-muted-foreground">
            Reports for {accountName || "this account"}. Scheduled reports
            advance automatically using completed days.
          </p>
        </div>
        <Button
          disabled={!accountIdentifier || busy}
          onClick={() => openEditor()}
        >
          Create report
        </Button>
      </div>
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry reports
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading reports…</p>
      ) : !visibleReports.length ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No reports saved for this account. Create an on-demand report or a
            rolling schedule.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[720px] text-left text-sm" aria-label="Saved reports">
            <thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{['Report name', 'Schedule', 'Window', 'Delivery', 'Status', 'Actions'].map(label => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{visibleReports.map((report) => <tr key={report.id} className="border-t align-top">
              <td className="min-w-40 px-4 py-4 font-semibold">{report.name}</td>
              <td className="min-w-40 px-4 py-4 text-xs leading-5">{report.schedule_definition ? <><span className="block capitalize">{report.schedule_definition.frequency} at {report.schedule_definition.localTime}</span><span className="text-muted-foreground">{report.schedule_definition.timezone}</span></> : report.schedule_cron ? `UTC schedule: ${report.schedule_cron}` : 'On demand'}</td>
              <td className="min-w-36 px-4 py-4 text-xs leading-5">{report.filters.relativeDays ? `Last ${report.filters.relativeDays} completed days` : `${report.filters.start?.slice(0, 10) || 'All dates'} – ${report.filters.end?.slice(0, 10) || 'today'}`}</td>
              <td className="max-w-48 break-words px-4 py-4 text-xs leading-5">{report.delivery_channel === 'email' ? report.delivery_target : 'In-app'}</td>
              <td className="px-4 py-4"><span className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs ${report.paused ? 'bg-muted text-muted-foreground' : 'bg-primary/5 text-primary'}`}>{report.paused ? 'Paused' : report.schedule_definition || report.schedule_cron ? 'Scheduled' : 'On demand'}</span></td>
              <td className="w-28 px-3 py-3"><div className="flex items-center gap-1">
                <Button size="icon" variant="outline" aria-label="Preview" title="Preview report" disabled={busy} onClick={() => void exportReport(report, "preview")}><Eye className="h-3.5 w-3.5"/></Button>
                <Button size="icon" variant="ghost" aria-label="Edit" title="Edit report" disabled={busy} onClick={() => openEditor(report)}><Pencil className="h-3.5 w-3.5"/></Button>
                <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`More actions for ${report.name}`} disabled={busy}><MoreHorizontal className="h-4 w-4"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                  {(["csv", "pdf", "json"] as const).map(format => <DropdownMenuItem key={format} disabled={busy} onSelect={() => void exportReport(report, format)}>Export {format.toUpperCase()}</DropdownMenuItem>)}
                  <DropdownMenuSeparator/><DropdownMenuItem disabled={busy} onSelect={() => openEditor(report, true)}>Duplicate</DropdownMenuItem>
                  {(report.schedule_definition || report.schedule_cron) && <DropdownMenuItem disabled={busy} onSelect={() => void run(async () => { await api.patch(`/api/social-analytics/reports/${report.id}`, { paused: !report.paused }); await load(); })}>{report.paused ? "Resume" : "Pause"}</DropdownMenuItem>}
                  <DropdownMenuSeparator/><DropdownMenuItem disabled={busy} className="text-destructive" onSelect={() => setDeleteTarget(report)}>Delete</DropdownMenuItem>
                </DropdownMenuContent></DropdownMenu>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent overlayClassName={styles.drawerOverlay} className={styles.drawer}>
          <SheetHeader>
            <SheetTitle>
              {editing ? "Edit report" : "Create report"}
            </SheetTitle>
            <SheetDescription>
              Account:{" "}
              {sourceReport && !sourceReport.filters.accountIdentifier
                ? "All accounts in the saved scope"
                : accountName || platform}
              . Names must be unique. Editing saves the period shown here.
            </SheetDescription>
          </SheetHeader>
          <form
            className={styles.reportForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void save();
            }}
          >
            <label className="space-y-1 text-sm sm:col-span-2">
              Report name
              <Input
                required
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Frequency
              <select
                className={selectClass}
                value={frequency}
                onChange={(event) => {
                  setFrequency(event.target.value);
                  setDay("1");
                }}
              >
                {[
                  "on_demand",
                  "daily",
                  "weekly",
                  "monthly",
                  ...(sourceReport?.schedule_cron ? ["custom_cron"] : []),
                ].map((value) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            {frequency !== "on_demand" && frequency !== "custom_cron" && <div className="col-span-2 flex items-start gap-3 rounded-lg border border-primary/15 bg-primary/5 p-3"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary"/><div><h3 className="text-xs font-semibold">Schedule</h3><p className="mt-1 text-[11px] text-muted-foreground">Choose the local time and timezone. Each run uses completed days.</p></div></div>}
            {frequency === "custom_cron" && (
              <>
                <label className="text-sm">
                  Five-field UTC cron
                  <Input
                    required
                    value={cron}
                    aria-invalid={!cronValid}
                    onChange={(event) => setCron(event.target.value)}
                  />
                </label>
                {!cronValid && (
                  <p role="alert" className="text-sm text-destructive">
                    Enter a valid five-field UTC cron, for example 30 9 * * 1.
                  </p>
                )}
              </>
            )}
            {frequency !== "on_demand" ? (
              <>
                <label className="text-sm">
                  Rolling period
                  <select
                    className={selectClass}
                    value={period}
                    onChange={(event) => setPeriod(event.target.value)}
                  >
                    {[...new Set([Number(period), 7, 30, 90, 180, 365])]
                      .sort((a, b) => a - b)
                      .map((value) => (
                        <option key={value} value={value}>
                          Last {value} completed days
                        </option>
                      ))}
                  </select>
                </label>
                {frequency === "weekly" && (
                  <label data-report-field="day" className="text-sm">
                    Day
                    <select
                      className={selectClass}
                      value={day}
                      onChange={(event) => setDay(event.target.value)}
                    >
                      {days.map((value, index) => (
                        <option key={value} value={index}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {frequency === "monthly" && (
                  <label data-report-field="day" className="text-sm">
                    Day of month
                    <Input
                      type="number"
                      min={1}
                      max={28}
                      value={day}
                      onChange={(event) => setDay(event.target.value)}
                    />
                  </label>
                )}
                {frequency !== "custom_cron" && (
                  <>
                    <label data-report-field="time" className="text-sm">
                      Local time
                      <Input
                        required
                        type="time"
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                      />
                    </label>
                    <label className="text-sm">
                      Timezone
                      <Input
                        required
                        value={zone}
                        onChange={(event) => setZone(event.target.value)}
                        aria-invalid={!isIanaTimezone(zone)}
                      />
                      <span className="text-xs text-muted-foreground">
                        For example Asia/Kolkata
                      </span>
                    </label>
                  </>
                )}
              </>
            ) : (
              <>
                <label className="text-sm">
                  Start date (UTC)
                  <Input
                    type="date"
                    required
                    value={rangeStart}
                    onChange={(event) => setRangeStart(event.target.value)}
                  />
                </label>
                <label className="text-sm">
                  End date (UTC)
                  <Input
                    type="date"
                    required
                    value={rangeEnd}
                    onChange={(event) => setRangeEnd(event.target.value)}
                  />
                </label>
                {validateAnalyticsWindow(rangeStart, rangeEnd, "UTC") && (
                  <p role="alert" className="text-sm text-destructive">
                    {validateAnalyticsWindow(rangeStart, rangeEnd, "UTC")}
                  </p>
                )}
              </>
            )}
            <label className="text-sm">
              Delivery
              <select
                className={selectClass}
                value={delivery}
                onChange={(event) => setDelivery(event.target.value)}
              >
                <option value="in_app">In-app</option>
                <option value="email">Email</option>
              </select>
            </label>
            {delivery === "email" && (
              <label className="text-sm">
                Recipient
                <Input
                  type="email"
                  required
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  Uses your connected email provider.
                </span>
              </label>
            )}
            {error && (
              <p
                role="alert"
                className="text-sm text-destructive sm:col-span-2"
              >
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t pt-4 sm:col-span-2"><Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button
              className="sm:col-span-2"
              disabled={!valid || busy}
              type="submit"
            >
              {busy ? "Saving…" : "Save report"}
            </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This removes the report, its exports and delivery history, and
              stops its schedule.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.delete(
                  `/api/social-analytics/reports/${deleteTarget!.id}`,
                );
                setDeleteTarget(null);
                await load();
              })
            }
          >
            Delete report
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) {
            historyRequest.current++;
            setPreview(null);
            setDeliveriesLoading(false);
            setDeliveriesError(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{preview?.report.name}</DialogTitle>
            <DialogDescription>
              Generated{" "}
              {preview?.payload.generatedAt
                ? new Date(preview.payload.generatedAt).toLocaleString()
                : "now"}{" "}
              · {preview?.payload.snapshots?.length || 0} measurements ·{" "}
              {preview?.payload.citations?.length || 0} citations.
            </DialogDescription>
          </DialogHeader>
          {preview?.payload.truncated && (
            <p className="text-sm text-amber-700">
              This export reached its row limit. Narrow the date range for a
              complete report.
            </p>
          )}
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Platform</th>
                  <th>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {preview?.payload.snapshots?.map((row, index) => (
                  <tr className="border-t" key={String(row.id || index)}>
                    <td className="py-2">
                      {String(row.metric_window_start).slice(0, 10)}
                    </td>
                    <td>{String(row.platform)}</td>
                    <td className="break-words">
                      {Object.entries(
                        (row.metrics || {}) as Record<string, unknown>,
                      )
                        .map(
                          ([key, value]) =>
                            `${key.replaceAll("_", " ")}: ${value}`,
                        )
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="font-semibold">Delivery history</h3>
          {deliveriesLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading delivery history…
            </p>
          ) : deliveriesError ? (
            <Callout
              tone="danger"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (preview) void loadDeliveryHistory(preview.report.id);
                  }}
                >
                  Retry delivery history
                </Button>
              }
            >
              {deliveriesError}
            </Callout>
          ) : deliveries.length ? (
            deliveries.map((row) => (
              <div key={row.id} className="rounded border p-3 text-sm">
                <p>
                  {new Date(row.attempted_at).toLocaleString()} · {row.status}
                </p>
                {row.error_message && (
                  <p className="text-destructive">{row.error_message}</p>
                )}
                {['pending', 'failed'].includes(row.status) &&
                  (row.preparation_version === 0 || row.dispatch_started_at) && (
                    <p className="mt-1 text-muted-foreground">
                      Delivery is unconfirmed. Check whether the report arrived
                      before sending it again.
                    </p>
                  )}
                {row.export_id && (
                  <Button
                    size="sm"
                    variant="link"
                    disabled={busy}
                    onClick={() =>
                      void exportReport(
                        preview!.report,
                        "preview",
                        row.export_id,
                      )
                    }
                  >
                    View this saved export
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No scheduled deliveries yet.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
