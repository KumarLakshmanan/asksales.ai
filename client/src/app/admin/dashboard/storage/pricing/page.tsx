"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, CircleDollarSign, Pencil, Plus, RefreshCw } from "lucide-react";

interface StoragePricing {
  id: number;
  pricingKey: string;
  name: string;
  description: string | null;
  pricePerGbCents: number;
  currency: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function formatPrice(priceMinorUnits: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(priceMinorUnits / 100);
  } catch {
    return `${currency} ${(priceMinorUnits / 100).toFixed(2)}`;
  }
}

export default function StoragePricingPage() {
  const { toast } = useToast();
  const [pricing, setPricing] = useState<StoragePricing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StoragePricing | null>(null);
  const [saving, setSaving] = useState(false);
  const [pricingKey, setPricingKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceMinorUnits, setPriceMinorUnits] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [isActive, setIsActive] = useState(true);

  const loadPricing = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await api.get<StoragePricing[]>("/api/admin/storage/pricing");
      setPricing(response ?? []);
    } catch {
      setLoadError(true);
      toast({ title: "Storage pricing unavailable", description: "The pricing records could not be loaded.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void loadPricing(); }, [loadPricing]);

  const openCreate = () => {
    setEditing(null);
    setPricingKey("");
    setName("");
    setDescription("");
    setPriceMinorUnits("0");
    setCurrency("USD");
    setIsActive(true);
    setDialogOpen(true);
  };

  const openEdit = (entry: StoragePricing) => {
    setEditing(entry);
    setPricingKey(entry.pricingKey);
    setName(entry.name);
    setDescription(entry.description ?? "");
    setPriceMinorUnits(String(entry.pricePerGbCents));
    setCurrency(entry.currency);
    setIsActive(entry.isActive);
    setDialogOpen(true);
  };

  const savePricing = async () => {
    const parsedPrice = Number(priceMinorUnits);
    if (!editing && !/^[a-z][a-z0-9_]{1,99}$/.test(pricingKey)) {
      toast({ title: "Invalid pricing key", description: "Use 2–100 lowercase letters, numbers, or underscores.", variant: "destructive" });
      return;
    }
    if (!name.trim() || name.trim().length > 200) {
      toast({ title: "Invalid name", description: "Enter a name of up to 200 characters.", variant: "destructive" });
      return;
    }
    if (!Number.isSafeInteger(parsedPrice) || parsedPrice < 0 || parsedPrice > 100_000_000) {
      toast({ title: "Invalid price", description: "Enter a non-negative whole number in minor currency units.", variant: "destructive" });
      return;
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      toast({ title: "Invalid currency", description: "Use a three-letter ISO currency code such as USD or INR.", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        pricePerGbCents: parsedPrice,
        currency,
        isActive,
      };
      if (editing) {
        await api.put(`/api/admin/storage/pricing/${editing.id}`, body);
        toast({ title: "Pricing updated", description: `${name.trim()} is now ${isActive ? "active" : "inactive"}.` });
      } else {
        await api.post("/api/admin/storage/pricing", { pricingKey, ...body });
        toast({ title: "Pricing created", description: `${name.trim()} is available for storage billing.` });
      }
      setDialogOpen(false);
      await loadPricing();
    } catch (error) {
      toast({
        title: "Pricing could not be saved",
        description: error instanceof Error ? error.message : "Review the values and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingState size="page" label="Loading storage pricing…" />;
  }

  if (loadError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div>
          <h1 className="text-lg font-semibold">Storage pricing could not be loaded</h1>
          <p className="mt-1 text-sm text-muted-foreground">Check the server connection and try again.</p>
        </div>
        <Button variant="outline" onClick={() => void loadPricing()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CircleDollarSign className="h-6 w-6 text-primary" /> Storage Pricing
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage active per-GB pricing records used by storage billing.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadPricing()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
          <Button size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New pricing</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pricing records ({pricing.length})</CardTitle>
          <CardDescription>Amounts are stored in the selected currency&apos;s minor units per GB.</CardDescription>
        </CardHeader>
        <CardContent>
          {pricing.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <CircleDollarSign className="mb-3 h-10 w-10 opacity-40" />
              <p className="font-medium text-foreground">No storage pricing configured</p>
              <p className="mt-1 text-sm">Create a pricing record before enabling billable storage tiers.</p>
              <Button className="mt-4" size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Create pricing</Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Price per GB</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricing.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <div className="font-medium">{entry.name}</div>
                        {entry.description && <div className="max-w-sm truncate text-xs text-muted-foreground">{entry.description}</div>}
                      </TableCell>
                      <TableCell><code className="rounded bg-muted px-1.5 py-1 text-xs">{entry.pricingKey}</code></TableCell>
                      <TableCell className="font-medium">{formatPrice(entry.pricePerGbCents, entry.currency)} / GB</TableCell>
                      <TableCell><Badge variant={entry.isActive ? "default" : "secondary"}>{entry.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(entry.updatedAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(entry)} aria-label={`Edit ${entry.name}`}><Pencil className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit storage pricing" : "Create storage pricing"}</DialogTitle>
            <DialogDescription>{editing ? "Update the amount, currency, description, or active state." : "Add a stable pricing key for a billable storage rate."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="storage-pricing-key">Pricing key</Label>
              <Input id="storage-pricing-key" value={pricingKey} disabled={!!editing} onChange={(event) => setPricingKey(event.target.value.toLowerCase())} placeholder="standard_storage" />
              {editing && <p className="text-xs text-muted-foreground">Pricing keys are immutable after creation.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="storage-pricing-name">Name</Label>
              <Input id="storage-pricing-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Standard storage" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="storage-pricing-description">Description</Label>
              <Textarea id="storage-pricing-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Optional internal description" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="storage-price">Price per GB (minor units)</Label>
                <Input id="storage-price" type="number" min="0" step="1" value={priceMinorUnits} onChange={(event) => setPriceMinorUnits(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storage-currency">Currency</Label>
                <Input id="storage-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="USD" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="storage-active">Active pricing</Label>
                <p className="text-xs text-muted-foreground">Inactive records remain available for billing history.</p>
              </div>
              <Switch id="storage-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={() => void savePricing()}>
              {editing ? "Save changes" : "Create pricing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
