"use client";
import styles from "@/components/proposals/proposals.module.css";
import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
export type ProposalSource = {
  contactId?: number;
  leadId?: number;
  outreachConversationId?: number;
  supportTicketId?: number;
  chatThreadId?: number;
};
type SourceItem = { id: number; name: string; email?: string };
export function ProposalSourcePicker({
  value,
  onChange,
  onRecipient,
}: {
  value: ProposalSource;
  onChange: (value: ProposalSource) => void;
  onRecipient: (name: string, email: string) => void;
}) {
  const requestNumber = useRef(0);
  const [search, setSearch] = useState(""),
    [sources, setSources] = useState<{
      contacts: SourceItem[];
      conversations: SourceItem[];
      tickets: SourceItem[];
    }>({ contacts: [], conversations: [], tickets: [] }),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api
        .get<typeof sources>(
          `/api/proposals/sources?search=${encodeURIComponent(search)}`,
        )
        .then((data) => {
          if (active) {
            setSources(data);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Unable to load customer sources.");
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);
  return (
    <div className={`${styles.sourcePicker} space-y-3 rounded-xl border p-4`}>
      <h2 className="text-sm font-semibold">Customer and conversation</h2>
      <p className="text-xs text-muted-foreground">
        Select a contact, outreach conversation or support ticket to link the
        proposal and use its requirements.
      </p>
      <Input
        aria-label="Search proposal sources"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search customers or tickets"
      />
      <select
        aria-label="Proposal source"
        className="w-full rounded-md border bg-background p-2 text-sm"
        value={
          value.supportTicketId
            ? `supportTicketId:${value.supportTicketId}`
            : value.outreachConversationId
              ? `outreachConversationId:${value.outreachConversationId}`
              : value.contactId
                ? `contactId:${value.contactId}`
                : ""
        }
        onChange={async (e) => {
          const request = ++requestNumber.current;
          const [key, id] = e.target.value.split(":");
          if (!id) {
            onChange({});
            return;
          }
          const next = { [key]: Number(id) };
          onChange(next);
          try {
            const result = await api.get<{
              refs: ProposalSource;
              recipientName: string;
              recipientEmail: string;
            }>(`/api/proposals/resolve-source?${key}=${id}`);
            if (request !== requestNumber.current) return;
            onChange(result.refs);
            onRecipient(result.recipientName, result.recipientEmail);
            setError("");
          } catch (e) {
            if (request !== requestNumber.current) return;
            setError(e instanceof Error ? e.message : "Unable to load source");
          }
        }}
      >
        <option value="">No linked source</option>
        {value.supportTicketId &&
          !sources.tickets.some((i) => i.id === value.supportTicketId) && (
            <option value={`supportTicketId:${value.supportTicketId}`}>
              Linked ticket #{value.supportTicketId}
            </option>
          )}
        {!value.supportTicketId &&
          value.outreachConversationId &&
          !sources.conversations.some(
            (i) => i.id === value.outreachConversationId,
          ) && (
            <option
              value={`outreachConversationId:${value.outreachConversationId}`}
            >
              Linked conversation #{value.outreachConversationId}
            </option>
          )}
        {!value.supportTicketId &&
          !value.outreachConversationId &&
          value.contactId &&
          !sources.contacts.some((i) => i.id === value.contactId) && (
            <option value={`contactId:${value.contactId}`}>
              Linked contact #{value.contactId}
            </option>
          )}
        {(
          [
            ["Contacts", "contactId", sources.contacts],
            [
              "Outreach conversations",
              "outreachConversationId",
              sources.conversations,
            ],
            ["Support tickets", "supportTicketId", sources.tickets],
          ] as const
        ).map(([label, key, items]) => (
          <optgroup label={label} key={key}>
            {items.map((item) => (
              <option value={`${key}:${item.id}`} key={item.id}>
                {item.name || `#${item.id}`}
                {item.email ? ` — ${item.email}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
