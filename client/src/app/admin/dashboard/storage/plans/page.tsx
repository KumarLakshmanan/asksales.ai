"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { LoadingState } from "@/components/ui/loading-state";
import { Tag, RefreshCw, Plus, Pencil, Trash2 } from "lucide-react";
import { formatBytes } from "@/lib/format-bytes";

interface StoragePlan {
  id: number;
  name: string;
  description: string | null;
  maxStorageBytes: number;
  pricePerGbCents: number;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}

function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 * 1024 * 1024);
}

export default function StoragePlansPage() {
  const { toast } = useToast();
  const [plans, setPlans] = useState<StoragePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<StoragePlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [pendingDeletePlanId, setPendingDeletePlanId] = useState<number | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formMaxGb, setFormMaxGb] = useState("1");
  const [formPricePerGb, setFormPricePerGb] = useState("0");
  const [formCurrency, setFormCurrency] = useState("USD");
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formIsActive, setFormIsActive] = useState(true);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.get<StoragePlan[]>("/api/admin/storage/plans");
      setPlans(res || []);
    } catch {
      setLoadError(true);
      toast({ title: "Error", description: "Failed to load plans", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  const openCreateDialog = () => {
    setEditingPlan(null);
    setFormName("");
    setFormDescription("");
    setFormMaxGb("1");
    setFormPricePerGb("0");
    setFormCurrency("USD");
    setFormIsDefault(false);
    setFormIsActive(true);
    setDialogOpen(true);
  };

  const openEditDialog = (plan: StoragePlan) => {
    setEditingPlan(plan);
    setFormName(plan.name);
    setFormDescription(plan.description ?? "");
    setFormMaxGb(String(bytesToGb(Number(plan.maxStorageBytes))));
    setFormPricePerGb(String(plan.pricePerGbCents));
    setFormCurrency(plan.currency || "USD");
    setFormIsDefault(plan.isDefault);
    setFormIsActive(plan.isActive);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast({ title: "Validation", description: "Plan name is required", variant: "destructive" });
      return;
    }
    const maxGb = Number(formMaxGb);
    const priceMinorUnits = Number(formPricePerGb);
    if (!Number.isFinite(maxGb) || maxGb <= 0 || maxGb > 10 * 1024) {
      toast({ title: "Validation", description: "Storage must be greater than 0 GB and no more than 10 TB", variant: "destructive" });
      return;
    }
    if (!Number.isSafeInteger(priceMinorUnits) || priceMinorUnits < 0) {
      toast({ title: "Validation", description: "Price must be a non-negative whole number in minor currency units", variant: "destructive" });
      return;
    }
    if (!/^[A-Z]{3}$/.test(formCurrency)) {
      toast({ title: "Validation", description: "Currency must be a three-letter ISO code such as USD", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        description: formDescription.trim() || null,
        maxStorageBytes: gbToBytes(maxGb),
        pricePerGbCents: priceMinorUnits,
        currency: formCurrency.toUpperCase(),
        isDefault: formIsDefault,
        isActive: formIsActive,
      };

      if (editingPlan) {
        await api.put(`/api/admin/storage/plans/${editingPlan.id}`, body);
        toast({ title: "Updated", description: `Plan "${formName}" updated` });
      } else {
        await api.post("/api/admin/storage/plans", body);
        toast({ title: "Created", description: `Plan "${formName}" created` });
      }

      setDialogOpen(false);
      await fetchPlans();
    } catch (err: unknown) {
      toast({ title: "Error", description: (err instanceof Error ? err.message : null) || "Failed to save plan", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (planId: number) => {
    setDeleting(planId);
    try {
      await api.delete(`/api/admin/storage/plans/${planId}`);
      toast({ title: "Deleted", description: "Plan deleted" });
      await fetchPlans();
    } catch (err: unknown) {
      toast({ title: "Error", description: (err instanceof Error ? err.message : null) || "Failed to delete plan", variant: "destructive" });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return <LoadingState size="page" label="Loading storage plans…" />;
  }

  if (loadError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <Tag className="h-10 w-10 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold">Storage plans could not be loaded</h1>
          <p className="mt-1 text-sm text-muted-foreground">Check the server connection and try again.</p>
        </div>
        <Button variant="outline" onClick={() => void fetchPlans()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Tag className="w-6 h-6 text-purple-600" />
            Storage Plans
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure storage plans that can be assigned to users
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchPlans}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreateDialog} className="bg-purple-600 hover:bg-purple-700">
            <Plus className="w-4 h-4 mr-2" />
            New Plan
          </Button>
        </div>
      </div>

      {/* Plans Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Plans ({plans.length})</CardTitle>
          <CardDescription>Storage allocation plans with pricing</CardDescription>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Tag className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>No plans configured yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Storage Limit</TableHead>
                  <TableHead>Price/GB</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="font-medium">{plan.name}</div>
                      {plan.description && <div className="text-xs text-muted-foreground">{plan.description}</div>}
                    </TableCell>
                    <TableCell>{formatBytes(Number(plan.maxStorageBytes))}</TableCell>
                    <TableCell>
                      {plan.pricePerGbCents > 0
                        ? `${new Intl.NumberFormat(undefined, { style: "currency", currency: plan.currency || "USD" }).format(plan.pricePerGbCents / 100)}/GB`
                        : "Free"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {plan.isDefault && <Badge className="bg-purple-100 text-purple-700">Default</Badge>}
                        <Badge variant={plan.isActive ? "default" : "secondary"}>
                          {plan.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditDialog(plan)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDeletePlanId(plan.id)}
                          loading={deleting === plan.id}
                          loadingText={<span className="sr-only">Deleting plan</span>}
                          disabled={plan.isDefault}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingPlan ? "Edit Plan" : "Create Plan"}</DialogTitle>
            <DialogDescription>
              {editingPlan ? "Update the storage plan settings" : "Create a new storage plan"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Plan Name</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Pro, Enterprise" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Optional description" rows={2} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Storage Limit (GB)</Label>
                <Input type="number" value={formMaxGb} onChange={(e) => setFormMaxGb(e.target.value)} min="0.1" step="0.1" />
              </div>
              <div className="space-y-2">
                <Label>Price per GB (minor units)</Label>
                <Input type="number" value={formPricePerGb} onChange={(e) => setFormPricePerGb(e.target.value)} min="0" />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Input value={formCurrency} onChange={(e) => setFormCurrency(e.target.value.toUpperCase())} maxLength={3} pattern="[A-Z]{3}" placeholder="USD" />
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch checked={formIsDefault} onCheckedChange={setFormIsDefault} disabled={Boolean(editingPlan?.isDefault)} />
                <Label>Default plan</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={formIsActive} onCheckedChange={setFormIsActive} disabled={Boolean(editingPlan?.isDefault)} />
                <Label>Active</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={saving} className="bg-purple-600 hover:bg-purple-700">
              {editingPlan ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDeletePlanId !== null} onOpenChange={(open) => { if (!open) setPendingDeletePlanId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this storage plan?</AlertDialogTitle>
            <AlertDialogDescription>
              The plan can only be deleted when no users are assigned. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                const planId = pendingDeletePlanId;
                setPendingDeletePlanId(null);
                if (planId !== null) void handleDelete(planId);
              }}
            >
              Delete plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
