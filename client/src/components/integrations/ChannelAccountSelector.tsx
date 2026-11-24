"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeftRight, Check, Facebook, Instagram, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ChannelAccount = {
  id: number;
  accountIdentifier: string;
  accountName: string;
  isSelected: boolean;
  pageId?: string | null;
};

type SupportedPlatform = "facebook_api" | "instagram_api";

const platformDetails: Record<SupportedPlatform, {
  accountLabel: string;
  chooseLabel: string;
  accentClass: string;
  avatarClass: string;
}> = {
  facebook_api: {
    accountLabel: "Facebook Page",
    chooseLabel: "Use this Page",
    accentClass: "text-[#1877F2]",
    avatarClass: "bg-[#1877F2]/10 text-[#1877F2]",
  },
  instagram_api: {
    accountLabel: "Instagram profile",
    chooseLabel: "Use this profile",
    accentClass: "text-[#d62976]",
    avatarClass: "bg-gradient-to-br from-[#833ab4]/20 via-[#fd1d1d]/15 to-[#fcb045]/20 text-[#d62976]",
  },
};

function initials(name: string) {
  const value = name.trim();
  if (!value) return "?";
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function PlatformMark({ platform, className }: { platform: SupportedPlatform; className?: string }) {
  if (platform === "facebook_api") return <Facebook className={className} aria-hidden="true" />;
  if (platform === "instagram_api") return <Instagram className={className} aria-hidden="true" />;
  return null;
}

/** Profile-first tenant-scoped picker for OAuth connections with multiple identities. */
export function ChannelAccountSelector({
  platform,
  label,
  onChanged,
  variant = "card",
}: {
  platform: SupportedPlatform;
  label: string;
  onChanged?: () => Promise<void> | void;
  variant?: "card" | "action" | "button";
}) {
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftSelectedId, setDraftSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<ChannelAccount | null>(null);
  const details = platformDetails[platform];

  const loadAccounts = useCallback(async () => {
    try {
      const rows = await api.get<ChannelAccount[]>(`/api/channel-accounts/${platform}`);
      setAccounts(rows);
      const selected = rows.find((row) => row.isSelected)?.id || null;
      setSelectedId(selected);
      setDraftSelectedId(selected);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connected accounts could not be loaded.");
    }
  }, [platform]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const selectedAccount = accounts.find((account) => account.id === selectedId) || null;
  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return accounts;
    return accounts.filter((account) => `${account.accountName} ${account.accountIdentifier}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [accounts, query]);

  const openPicker = () => {
    setDraftSelectedId(selectedId);
    setQuery("");
    setError(null);
    setDialogOpen(true);
  };

  const saveSelection = async () => {
    if (!draftSelectedId || draftSelectedId === selectedId) {
      setDialogOpen(false);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await api.post(`/api/channel-accounts/${platform}/select`, { credentialId: draftSelectedId });
      setSelectedId(draftSelectedId);
      setDialogOpen(false);
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This account could not be selected.");
    } finally {
      setSaving(false);
    }
  };

  if (!accounts.length && !error) return null;

  return <>
    {variant !== "card" ? (
      <Button
        type="button"
        variant="ghost"
        size={variant === "button" ? "sm" : "icon"}
        className={cn("rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", variant === "button" ? "gap-2" : "h-7 w-7")}
        disabled={saving || !accounts.length}
        onClick={openPicker}
        aria-label={`${selectedAccount ? "Change" : "Choose"} ${label}`}
        title={`${selectedAccount ? "Change" : "Choose"} ${label}`}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        {variant === "button" && `${selectedAccount ? "Change" : "Choose"} account`}
      </Button>
    ) : (
      <div className="rounded-xl border border-border/60 bg-background/50 p-3 text-sm shadow-sm">
        <div className="flex items-center gap-3">
          <Avatar className="h-11 w-11 rounded-xl">
            <AvatarFallback className={cn("rounded-xl text-sm font-black", details.avatarClass)}>
              {selectedAccount ? initials(selectedAccount.accountName) : <PlatformMark platform={platform} className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
            <p className="mt-0.5 truncate font-semibold">{selectedAccount?.accountName || `No ${details.accountLabel} selected`}</p>
            {selectedAccount && <p className="truncate text-xs text-muted-foreground">ID {selectedAccount.accountIdentifier}</p>}
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" disabled={saving || !accounts.length} onClick={openPicker}>
            <ArrowLeftRight className="h-3.5 w-3.5" />
            {selectedAccount ? "Change" : "Choose"}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      </div>
    )}

    {variant !== "card" && error && <div className="mt-2 text-sm text-destructive" role="alert">{error}<Button variant="link" size="sm" onClick={() => void loadAccounts()}>Retry accounts</Button></div>}

    <Dialog open={dialogOpen} onOpenChange={(open) => { if (!saving) setDialogOpen(open); }}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-5 pr-12 sm:px-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
            <PlatformMark platform={platform} className={cn("h-5 w-5", details.accentClass)} />
          </div>
          <DialogTitle>Choose {platform === "instagram_api" ? "an" : "a"} {details.accountLabel}</DialogTitle>
          <DialogDescription>
            This profile will be used for publishing, messages, and other account-level actions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4 sm:px-6">
          {accounts.length > 4 && (
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder={`Search ${details.accountLabel.toLocaleLowerCase()}s`}
              aria-label={`Search ${details.accountLabel}s`}
            />
          )}

          <div className="max-h-[340px] overflow-y-auto overscroll-contain">
            <div className="space-y-2 pr-2" role="radiogroup" aria-label={label}>
              {filteredAccounts.map((account) => {
                const checked = account.id === draftSelectedId;
                const current = account.id === selectedId;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    key={account.id}
                    disabled={saving}
                    onClick={() => setDraftSelectedId(account.id)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                      checked ? "border-primary/60 bg-primary/5" : "border-border/60 bg-card/40 hover:border-border hover:bg-muted/30",
                    )}
                  >
                    <Avatar className="h-11 w-11 rounded-xl">
                      <AvatarFallback className={cn("rounded-xl text-sm font-black", details.avatarClass)}>{initials(account.accountName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold">{account.accountName}</p>
                        {current && <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">Current</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">ID {account.accountIdentifier}</p>
                      {platform === "instagram_api" && account.pageId && <p className="mt-1 truncate text-xs text-muted-foreground">Linked Facebook Page: {account.pageId}</p>}
                    </div>
                    <span className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent group-hover:border-muted-foreground/50",
                    )}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  </button>
                );
              })}
              {!filteredAccounts.length && (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No matching profiles.</div>
              )}
            </div>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border/60 bg-muted/10 px-5 py-4 sm:px-6">
          <div className="mr-auto">
            {selectedAccount && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={saving}
                onClick={() => { setDialogOpen(false); setPendingRemoval(selectedAccount); }}
                aria-label={`Remove current ${label}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button type="button" loading={saving} disabled={!draftSelectedId} onClick={() => void saveSelection()}>
            {details.chooseLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(pendingRemoval)} onOpenChange={(open) => { if (!open && !saving) setPendingRemoval(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove connected account?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingRemoval
              ? `${pendingRemoval.accountName} (${pendingRemoval.accountIdentifier}) will be removed from this integration. Existing content history is retained, but new publishing and account-level API actions will stop for this identity.`
              : "This connected identity will be removed."}
          </AlertDialogDescription>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving || !pendingRemoval}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              if (!pendingRemoval) return;
              const credentialId = pendingRemoval.id;
              setSaving(true);
              setError(null);
              void api.delete(`/api/channel-accounts/${platform}/${credentialId}`)
                .then(async () => {
                  setPendingRemoval(null);
                  await loadAccounts();
                  await onChanged?.();
                })
                .catch((cause: Error) => setError(cause.message))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Removing…" : "Remove account"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
