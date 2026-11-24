"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { proposalStatusLabel } from '@/lib/proposal-status';
export function RelatedProposals({
  outreachConversationId,
  supportTicketId,
  contactId,
}: {
  outreachConversationId?: number;
  supportTicketId?: number;
  contactId?: number;
}) {
  const [rows, setRows] = useState<
      Array<{ id: number; title: string; status: string }>
    >([]),
    [error, setError] = useState("");
  const params = new URLSearchParams();
  if (outreachConversationId)
    params.set("outreachConversationId", String(outreachConversationId));
  else if (supportTicketId)
    params.set("supportTicketId", String(supportTicketId));
  else if (contactId) params.set("contactId", String(contactId));
  const query = params.toString();
  useEffect(() => {
    if (!query) return;
    let active = true;
    api
      .get<typeof rows>(`/api/proposals/related?${query}`)
      .then((data) => {
        if (active) {
          setRows(data);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [query]);
  if (!query) return null;
  return (
    <details className="shrink-0 border-b bg-card p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Proposals ({rows.length})
      </summary>
      <div className="mt-3 space-y-2">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {rows.map((p) => (
          <Link
            className="block text-primary hover:underline"
            href={`/dashboard/proposals/${p.id}`}
            key={p.id}
          >
            {p.title} · {proposalStatusLabel(p.status)}
          </Link>
        ))}
        <Link
          className="inline-block rounded-md border px-3 py-2 text-sm font-medium"
          href={`/dashboard/proposals/new?${query}`}
        >
          Create proposal from this{" "}
          {supportTicketId
            ? "ticket"
            : outreachConversationId
              ? "conversation"
              : "contact"}
        </Link>
      </div>
    </details>
  );
}
