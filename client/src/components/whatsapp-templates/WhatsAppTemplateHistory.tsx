"use client";

import { useState } from "react";

export interface TemplateSnapshot {
  name?: string;
  language?: string;
  category?: string;
  body?: string;
  header?: string | null;
  headerType?: string | null;
  headerMediaUrl?: string | null;
  footer?: string | null;
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
  }> | null;
  examples?: Record<string, string> | null;
  authConfig?: unknown;
  variableLabels?: Record<string, string> | null;
}
export interface TemplateActivity {
  at: string;
  action: string;
  status?: string;
  snapshot?: TemplateSnapshot;
}
const actionNames: Record<string, string> = {
  created: "Draft created",
  edited: "Draft edited",
  media_uploaded: "Attachment uploaded",
  submitted: "Submitted to Meta",
  status_refreshed: "Approval status refreshed",
  synced: "Synced from Meta",
};
const fields: Array<[keyof TemplateSnapshot, string]> = [
  ["name", "Name"],
  ["language", "Language"],
  ["category", "Category"],
  ["headerType", "Header type"],
  ["header", "Header"],
  ["headerMediaUrl", "Attachment"],
  ["body", "Body"],
  ["footer", "Footer"],
  ["buttons", "Buttons"],
  ["examples", "Variable examples"],
  ["variableLabels", "Variable labels"],
  ["authConfig", "Authentication settings"],
];
function content(value: unknown): string {
  if (value == null || value === "") return "None";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
export function WhatsAppTemplateHistory({
  current,
  approvedSnapshot,
  history = [],
}: {
  current: TemplateSnapshot;
  approvedSnapshot?: TemplateSnapshot | null;
  history?: TemplateActivity[];
}) {
  const [selected, setSelected] = useState("approved");
  const revisions = history
    .map((event, index) => ({ ...event, index }))
    .filter((event) => event.snapshot);
  const baseline =
    selected === "approved"
      ? approvedSnapshot
      : revisions.find((event) => String(event.index) === selected)?.snapshot;
  const changes = baseline
    ? fields.filter(
        ([field]) => content(baseline[field]) !== content(current[field]),
      )
    : [];
  return (
    <section className="mt-6 overflow-hidden rounded-[14px] border border-card-border bg-card shadow-sm">
      <div className="border-b px-5 py-4">
        <h2 className="font-semibold">History and versions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Compare your saved draft with an approved message or an earlier saved
          version.
        </p>
      </div>
      <div className="p-5">
        <label className="mb-3 block text-sm font-medium">
          Compare current draft with
          <select
            aria-label="Compare current draft with"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="mt-2 block w-full rounded-md border bg-card px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="approved">
              Approved Meta version{!approvedSnapshot ? " (unavailable)" : ""}
            </option>
            {revisions.map((event) => (
              <option key={event.index} value={String(event.index)}>
                {actionNames[event.action] || event.action} ·{" "}
                {new Date(event.at).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {baseline ? (
          changes.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full table-fixed text-left text-sm">
                <caption className="sr-only">
                  Changes from selected version to current draft
                </caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th className="w-1/5 p-3">Field</th>
                    <th className="p-3">Selected version</th>
                    <th className="p-3">Current draft</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {changes.map(([field, label]) => (
                    <tr key={field}>
                      <th
                        scope="row"
                        className="p-3 align-top text-xs font-medium"
                      >
                        {label}
                      </th>
                      <td className="whitespace-pre-wrap break-words p-3 align-top text-xs text-muted-foreground">
                        {content(baseline[field])}
                      </td>
                      <td className="whitespace-pre-wrap break-words bg-primary/5 p-3 align-top text-xs">
                        {content(current[field])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-md bg-muted/30 p-3 text-sm">
              Your current draft matches this version.
            </p>
          )
        ) : (
          <p className="rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
            No approved snapshot is available yet. Submit this template and
            refresh its status after approval.
          </p>
        )}
        <h3 className="mb-3 mt-6 text-sm font-semibold">Activity</h3>
        {history.length ? (
          <ol className="space-y-3">
            {history
              .slice()
              .reverse()
              .map((event, index) => (
                <li
                  key={`${event.at}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-primary/30 pl-3 text-sm"
                >
                  <span>
                    {actionNames[event.action] ||
                      event.action.replaceAll("_", " ")}
                    {event.status ? ` · ${event.status.toLowerCase()}` : ""}
                  </span>
                  <time
                    dateTime={event.at}
                    className="text-xs text-muted-foreground"
                  >
                    {new Date(event.at).toLocaleString()}
                  </time>
                </li>
              ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            No recorded activity yet. Future saves and status checks will appear
            here.
          </p>
        )}
      </div>
    </section>
  );
}
