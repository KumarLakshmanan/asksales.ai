"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Link2, CheckCircle2, Check, Facebook, Landmark, ArrowLeftRight } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface PlatformCredential {
  id: number;
  platform: string;
  accountName?: string;
  isActive: boolean;
  connectedAt: string;
  expiresAt?: string;
  adAccountId?: string | null;
  pageId?: string | null;
  selectionRequired?: boolean;
}

interface MetaAccountStatusProps {
  isConnected: boolean;
  metaStatus: PlatformCredential | null;
  onChanged?: () => Promise<void> | void;
}

type MetaSelection = {
  adAccounts: Array<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }>;
  pages: Array<{ id: string; name?: string; pictureUrl?: string | null }>;
  selectedAdAccountId: string | null;
  selectedPageId: string | null;
};

function readableAdAccountId(value: string) {
  return value.startsWith("act_") ? value : `act_${value}`;
}

function BindingFact({ label, name, id, imageUrl, kind, meta }: {
  label: string;
  name?: string;
  id?: string;
  imageUrl?: string | null;
  kind: "ad-account" | "page";
  meta?: string;
}) {
  return <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3">
    <Avatar className="h-11 w-11 rounded-xl">
      {imageUrl && <AvatarImage src={imageUrl} alt={name || label} className="object-cover" />}
      <AvatarFallback className={cn("rounded-xl", kind === "page" ? "bg-[#1877F2]/10 text-[#1877F2]" : "bg-blue-500/10 text-blue-600")}>
        {kind === "page" ? <Facebook className="h-5 w-5"/> : <Landmark className="h-5 w-5"/>}
      </AvatarFallback>
    </Avatar>
    <div className="min-w-0 flex-1">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold">{name || `No ${label.toLocaleLowerCase()} selected`}</p>
      {id && <p className="truncate font-mono text-[11px] text-muted-foreground">ID {id}</p>}
    </div>
    {meta && <Badge variant="secondary" className="shrink-0">{meta}</Badge>}
  </div>;
}

export function MetaAccountStatus({ isConnected, metaStatus, onChanged }: MetaAccountStatusProps) {
  const { toast } = useToast();
  const [selection, setSelection] = useState<MetaSelection | null>(null);
  const [selectedAdAccountId, setSelectedAdAccountId] = useState("");
  const [selectedPageId, setSelectedPageId] = useState("");
  const [savingSelection, setSavingSelection] = useState(false);
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  

  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void api.get<MetaSelection>("/api/meta/oauth/selection").then((result) => {
      if (cancelled) return;
      setSelection(result);
      setSelectedAdAccountId(result.selectedAdAccountId || "");
      setSelectedPageId(result.selectedPageId || "");
      if (!result.selectedAdAccountId || !result.selectedPageId) setBindingDialogOpen(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isConnected]);

  const saveSelection = async () => {
    if (!selectedAdAccountId || !selectedPageId) {
      toast({ title: "Select both accounts", description: "Choose the Meta ad account and Facebook Page used for ads.", variant: "destructive" });
      return;
    }
    setSavingSelection(true);
    try {
      await api.post("/api/meta/oauth/selection", { adAccountId: selectedAdAccountId, pageId: selectedPageId });
      setSelection((current) => current ? { ...current, selectedAdAccountId, selectedPageId } : current);
      setBindingDialogOpen(false);
      toast({ title: "Meta accounts selected", description: "Future ad actions are bound to this ad account and Page." });
      await onChanged?.();
    } catch (error) {
      toast({ title: "Selection failed", description: error instanceof Error ? error.message : "Unable to save Meta account selection.", variant: "destructive" });
    } finally { setSavingSelection(false); }
  };

  const openBindingDialog = () => {
    setSelectedAdAccountId(selection?.selectedAdAccountId || "");
    setSelectedPageId(selection?.selectedPageId || "");
    setBindingDialogOpen(true);
  };


  return (
    <div className="rounded-xl border border-border/40 bg-card/30 overflow-hidden divide-y divide-border/40 w-full shadow-lg shadow-black/5">
      {/* Header Row */}
      <div className="flex items-center justify-between p-2 bg-muted/10">
        <div className="flex items-center gap-2 px-2">
          <div className="w-6 h-6 rounded bg-blue-500/10 flex items-center justify-center text-blue-600 border border-blue-500/20">
            <Link2 className="w-3 h-3" />
          </div>
          <span className="text-xs font-bold">Ad account and Page</span>
        </div>
        
      </div>

      <div className="p-0">
          {isConnected && metaStatus && (
            <motion.div key="connected" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-0 divide-y divide-border/40">
              <div className="p-3 flex items-center justify-between hover:bg-muted/5 transition-colors">
                <div className="flex items-center gap-3">
                   <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-600 border border-blue-500/20 text-xs font-bold uppercase tracking-widest">
                      {metaStatus.accountName?.charAt(0).toUpperCase()}
                   </div>
                   <div>
                      <p className="text-xs font-bold">{metaStatus.accountName || "Meta User"}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest">Connected via OAuth</p>
                   </div>
                </div>
              </div>
              {selection && (
                <div className="space-y-3 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold">Provider account binding</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Choose where AskSales.AI reads performance data and creates approved ads.</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={openBindingDialog} className="gap-2">
                      <ArrowLeftRight className="h-3.5 w-3.5"/>
                      {selection.selectedAdAccountId && selection.selectedPageId ? "Change binding" : "Choose accounts"}
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <BindingFact
                      label="Ad account"
                      kind="ad-account"
                      name={selection.adAccounts.find(account => account.id === selection.selectedAdAccountId)?.name}
                      id={selection.selectedAdAccountId ? readableAdAccountId(selection.selectedAdAccountId) : undefined}
                      meta={selection.adAccounts.find(account => account.id === selection.selectedAdAccountId)?.currency}
                    />
                    <BindingFact
                      label="Facebook Page"
                      kind="page"
                      name={selection.pages.find(page => page.id === selection.selectedPageId)?.name}
                      id={selection.selectedPageId || undefined}
                      imageUrl={selection.pages.find(page => page.id === selection.selectedPageId)?.pictureUrl}
                    />
                  </div>

                  <Dialog open={bindingDialogOpen} onOpenChange={(open) => { if (!savingSelection) setBindingDialogOpen(open); }}>
                    <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
                      <DialogHeader className="border-b border-border/60 px-5 py-5 pr-12 sm:px-6">
                        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10 text-blue-600">
                          <Link2 className="h-5 w-5"/>
                        </div>
                        <DialogTitle>Choose the Meta Ads binding</DialogTitle>
                        <DialogDescription>Select one ad account and one Facebook Page. Names and provider IDs are shown so the destination is unambiguous.</DialogDescription>
                      </DialogHeader>

                      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
                        <section aria-labelledby="meta-ad-account-heading" className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <h3 id="meta-ad-account-heading" className="text-sm font-semibold">1. Ad account</h3>
                              <p className="text-xs text-muted-foreground">Campaigns, budgets, and analytics come from this account.</p>
                            </div>
                            <Badge variant="outline">{selection.adAccounts.length} available</Badge>
                          </div>
                          <div className="space-y-2" role="radiogroup" aria-label="Meta ad account">
                            {selection.adAccounts.map((account) => {
                              const checked = selectedAdAccountId === account.id;
                              return <button
                                type="button"
                                role="radio"
                                aria-checked={checked}
                                aria-label={`${account.name || "Meta ad account"}, ID ${readableAdAccountId(account.id)}`}
                                key={account.id}
                                disabled={savingSelection}
                                onClick={() => setSelectedAdAccountId(account.id)}
                                className={cn("group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30", checked ? "border-blue-500/60 bg-blue-500/5" : "border-border/60 bg-card/40 hover:bg-muted/30")}
                              >
                                <Avatar className="h-11 w-11 rounded-xl"><AvatarFallback className="rounded-xl bg-blue-500/10 text-blue-600"><Landmark className="h-5 w-5"/></AvatarFallback></Avatar>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-semibold">{account.name || "Meta ad account"}</p>
                                  <p className="truncate font-mono text-[11px] text-muted-foreground">ID {readableAdAccountId(account.id)}</p>
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {account.currency && <Badge variant="secondary" className="h-5 text-[10px]">{account.currency}</Badge>}
                                    {account.timezone_name && <Badge variant="outline" className="h-5 max-w-[220px] truncate text-[10px]">{account.timezone_name}</Badge>}
                                  </div>
                                </div>
                                <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", checked ? "border-blue-600 bg-blue-600 text-white" : "border-border text-transparent group-hover:border-muted-foreground/50")}><Check className="h-3.5 w-3.5"/></span>
                              </button>;
                            })}
                          </div>
                        </section>

                        <section aria-labelledby="meta-page-heading" className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <h3 id="meta-page-heading" className="text-sm font-semibold">2. Facebook Page</h3>
                              <p className="text-xs text-muted-foreground">This Page supplies the advertiser identity shown on Meta placements.</p>
                            </div>
                            <Badge variant="outline">{selection.pages.length} available</Badge>
                          </div>
                          <div className="space-y-2" role="radiogroup" aria-label="Facebook Page for ads">
                            {selection.pages.map((page) => {
                              const checked = selectedPageId === page.id;
                              return <button
                                type="button"
                                role="radio"
                                aria-checked={checked}
                                aria-label={`${page.name || "Facebook Page"}, ID ${page.id}`}
                                key={page.id}
                                disabled={savingSelection}
                                onClick={() => setSelectedPageId(page.id)}
                                className={cn("group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30", checked ? "border-[#1877F2]/60 bg-[#1877F2]/5" : "border-border/60 bg-card/40 hover:bg-muted/30")}
                              >
                                <Avatar className="h-11 w-11 rounded-xl">
                                  {page.pictureUrl && <AvatarImage src={page.pictureUrl} alt={page.name || "Facebook Page"} className="object-cover"/>}
                                  <AvatarFallback className="rounded-xl bg-[#1877F2]/10 text-[#1877F2]"><Facebook className="h-5 w-5"/></AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-semibold">{page.name || "Facebook Page"}</p>
                                  <p className="truncate font-mono text-[11px] text-muted-foreground">ID {page.id}</p>
                                  <Badge className="mt-1.5 h-5 bg-[#1877F2]/10 text-[10px] text-[#1877F2] hover:bg-[#1877F2]/10">Facebook Page</Badge>
                                </div>
                                <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", checked ? "border-[#1877F2] bg-[#1877F2] text-white" : "border-border text-transparent group-hover:border-muted-foreground/50")}><Check className="h-3.5 w-3.5"/></span>
                              </button>;
                            })}
                          </div>
                        </section>
                      </div>

                      <DialogFooter className="border-t border-border/60 bg-muted/10 px-5 py-4 sm:px-6">
                        <Button type="button" variant="outline" disabled={savingSelection} onClick={() => setBindingDialogOpen(false)}>Cancel</Button>
                        <Button
                          type="button"
                          loading={savingSelection}
                          disabled={!selectedAdAccountId || !selectedPageId || (selectedAdAccountId === selection.selectedAdAccountId && selectedPageId === selection.selectedPageId)}
                          onClick={() => void saveSelection()}
                        >
                          Save binding
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
              <div className="p-2.5 flex items-center justify-between bg-blue-500/5">
                 <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3 h-3 text-blue-500" />
                    <span className="text-xs font-black uppercase tracking-widest text-blue-500">{metaStatus.selectionRequired ? "Account selection required" : "Account connected"}</span>
                 </div>
                 <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-widest italic">
                    Connected {new Date(metaStatus.connectedAt).toLocaleDateString()}
                 </p>
              </div>
            </motion.div>
          )}
      </div>
    </div>
  );
}
