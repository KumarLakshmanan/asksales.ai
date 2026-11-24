"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function ProposalPerformance() {
  const [group, setGroup] = useState("template"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<
    Array<{
      label: string;
      currency: string;
      total: number;
      sent: number;
      viewed: number;
      accepted: number;
      rejected: number;
      acceptedValue: number;
    }>
  >([]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({ group });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    api
      .get<typeof rows>(`/api/proposals/performance?${params}`)
      .then((data) => {
        if (active) {
          setRows(data);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [group, from, to]);
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <h2 className="font-semibold">Conversion by source</h2>
      <div className="flex flex-wrap items-end gap-4">
        <Label>
          Group by
          <select
            className="ml-2 rounded border bg-background p-2"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="template">Template</option>
            <option value="campaign">Campaign</option>
            <option value="owner">CRM owner</option>
          </select>
        </Label>
        <Label>
          Created from
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Label>
        <Label>
          Created through
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </Label>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : loading ? (
        <p>Loading breakdown…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Source",
                  "Currency",
                  "Created",
                  "Sent",
                  "Viewed",
                  "Accepted",
                  "Declined",
                  "Win rate",
                  "Accepted value",
                ].map((label) => (
                  <th className="p-2" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="p-2">{row.label}</td>
                  <td>{row.currency}</td>
                  <td>{row.total}</td>
                  <td>{row.sent}</td>
                  <td>{row.viewed}</td>
                  <td>{row.accepted}</td>
                  <td>{row.rejected}</td>
                  <td>
                    {row.accepted + row.rejected
                      ? `${((100 * row.accepted) / (row.accepted + row.rejected)).toFixed(1)}%`
                      : "—"}
                  </td>
                  <td>{row.acceptedValue.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="py-4 text-muted-foreground">
              No proposals in this period.
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Win rate is accepted / decided. Campaign attribution uses the linked
        outreach conversation; owner is the linked CRM contact’s current
        assignee.
      </p>
    </section>
  );
}
