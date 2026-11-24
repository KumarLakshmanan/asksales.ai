"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import api from "@/lib/api";

/** Mirrors server DuplicateContactGroup (services/CRMDuplicateContactsService.ts). */
export type DuplicateContact = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  conversations: number;
};
export type DuplicateContactGroup = { matchedOn: Array<"phone" | "email">; contacts: DuplicateContact[] };

/** The record with the most history is kept by default; ties keep the oldest. */
export function defaultKeptContact(group: DuplicateContactGroup): number {
  return [...group.contacts].sort((a, b) => b.conversations - a.conversations || a.id - b.id)[0].id;
}

const matchedLabel = (matchedOn: DuplicateContactGroup["matchedOn"]) =>
  matchedOn.length === 2 ? "Same phone and email" : matchedOn[0] === "phone" ? "Same phone" : "Same email";
const formatDate = (value: string | null) => (value ? new Date(value).toLocaleDateString() : "—");

/**
 * Lists contacts that share a phone or email and merges the others into the
 * one the person keeps. Conversations, campaigns, activities and tickets move
 * to the kept contact; the merged records stop appearing in CRM.
 */
export function DuplicateContactsDialog({
  open,
  onOpenChange,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  const [groups, setGroups] = useState<DuplicateContactGroup[] | null>(null);
  const [error, setError] = useState("");
  const [kept, setKept] = useState<Record<number, number>>({});
  const [confirming, setConfirming] = useState<number | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setError("");
    try {
      const result = await api.get<{ data: DuplicateContactGroup[] }>("/api/crm/contacts/duplicates");
      if (current !== request.current) return;
      setGroups(result.data);
      setKept(Object.fromEntries(result.data.map((group, index) => [index, defaultKeptContact(group)])));
    } catch (cause) {
      if (current === request.current)
        setError(cause instanceof Error ? cause.message : "Possible duplicates could not be loaded.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setGroups(null);
    setConfirming(null);
    void load();
  }, [open, load]);

  const merge = async (index: number) => {
    const group = groups?.[index];
    const keptId = kept[index];
    if (!group || !keptId) return;
    setMerging(index);
    setError("");
    try {
      for (const contact of group.contacts.filter((item) => item.id !== keptId)) {
        await api.post(`/api/crm/contacts/${contact.id}/merge`, { intoContactId: keptId });
      }
      setConfirming(null);
      onMerged();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The contacts could not be merged.");
      await load();
    } finally {
      setMerging(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => merging === null && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Possible duplicate contacts</DialogTitle>
          <DialogDescription>
            These contacts share a phone number or email. Choose the one to keep; the others are merged into it
            with their conversations, campaigns, notes and activity.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {groups === null && !error ? (
          <div aria-label="Loading possible duplicates" className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : groups?.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No contacts share a phone number or email.</p>
        ) : (
          <div className="space-y-4">
            {groups?.map((group, index) => {
              const keptContact = group.contacts.find((contact) => contact.id === kept[index]);
              const others = group.contacts.length - 1;
              return (
                <fieldset key={group.contacts.map((contact) => contact.id).join("-")} className="rounded-lg border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">{matchedLabel(group.matchedOn)}</legend>
                  <div className="space-y-2">
                    {group.contacts.map((contact) => (
                      <label key={contact.id} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/50">
                        <input
                          type="radio"
                          className="mt-1"
                          name={`keep-${index}`}
                          checked={kept[index] === contact.id}
                          disabled={merging !== null}
                          onChange={() => {
                            setKept((current) => ({ ...current, [index]: contact.id }));
                            setConfirming(null);
                          }}
                        />
                        <span className="min-w-0 flex-1 text-sm">
                          <span className="font-medium">{contact.name}</span>
                          {kept[index] === contact.id && <span className="ml-2 text-xs text-primary">Keep</span>}
                          <span className="block break-all text-xs text-muted-foreground">
                            {[contact.email, contact.phone, contact.company].filter(Boolean).join(" · ") || "No email or phone"}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {contact.conversations} conversation{contact.conversations === 1 ? "" : "s"} · added {formatDate(contact.createdAt)}
                            {contact.source ? ` from ${contact.source}` : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {confirming === index ? (
                      <>
                        <p className="mr-auto text-xs text-muted-foreground">
                          Merge {others} contact{others === 1 ? "" : "s"} into {keptContact?.name}? This can&apos;t be undone.
                        </p>
                        <Button variant="outline" size="sm" disabled={merging !== null} onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" loading={merging === index} disabled={merging !== null} onClick={() => void merge(index)}>
                          Merge {others + 1} contacts
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" size="sm" disabled={merging !== null || !keptContact} onClick={() => setConfirming(index)}>
                        Merge into {keptContact?.name ?? "kept contact"}
                      </Button>
                    )}
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={merging !== null} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
