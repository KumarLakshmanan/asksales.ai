"use client";

import React, { useState, useCallback, useEffect } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Layers,
  Plus,
  Pencil,
  Trash2,
  FolderTree,
  Settings,
  GripVertical,
  RefreshCw,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Subcategory {
  id: number;
  categoryId: number;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  followUpDays: number | null;
  leadReminderDays: number | null;
  leadPriority: string | null;
  autoActions: Record<string, unknown>[];
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface Category {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
  defaultFollowUpDays: number | null;
  defaultLeadPriority: string | null;
  autoAssignSupport: boolean;
  supportAiInstructions: string | null;
  cmsTemplateInstructions: string | null;
  customFields: Record<string, unknown>[];
  settings: Record<string, unknown>;
  subcategories: Subcategory[];
  profileCount: number;
  createdAt: string;
  updatedAt: string;
}

type DialogMode = "create-category" | "edit-category" | "create-subcategory" | "edit-subcategory" | null;

interface CategoryFormData {
  name: string;
  description: string;
  icon: string;
  color: string;
  isActive: boolean;
  sortOrder: number;
  defaultFollowUpDays: number;
  defaultLeadPriority: string;
  autoAssignSupport: boolean;
  supportAiInstructions: string;
  cmsTemplateInstructions: string;
  followUpDays: string | number | null;
  leadReminderDays: number;
  leadPriority: string;
}

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"];

const COLOR_OPTIONS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#6366f1",
];

// ─── Page Component ──────────────────────────────────────────────────────────

export default function BusinessCategoriesPage() {
  const { toast } = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Dialog state
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingSubcategory, setEditingSubcategory] = useState<Subcategory | null>(null);
  const [parentCategoryId, setParentCategoryId] = useState<number | null>(null);

  // Form state
  const [formData, setFormData] = useState<CategoryFormData>({
    name: "", description: "", icon: "", color: "#3b82f6", isActive: true,
    sortOrder: 0, defaultFollowUpDays: 7, defaultLeadPriority: "normal",
    autoAssignSupport: false, supportAiInstructions: "", cmsTemplateInstructions: "",
    followUpDays: "", leadReminderDays: 3, leadPriority: "",
  });

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await api.get<{ success: boolean; data: Category[] }>("/api/admin/business-categories");
      if (res.success) setCategories(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load categories";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // ─── Dialog handlers ────────────────────────────────────────────────────────

  function openCreateCategory() {
    setFormData({
      name: "",
      description: "",
      icon: "",
      color: "#3b82f6",
      isActive: true,
      sortOrder: categories.length,
      defaultFollowUpDays: 7,
      defaultLeadPriority: "normal",
      autoAssignSupport: false,
      supportAiInstructions: "",
      cmsTemplateInstructions: "",
      followUpDays: null,
      leadReminderDays: 3,
      leadPriority: "",
    });
    setEditingCategory(null);
    setDialogMode("create-category");
  }

  function openEditCategory(cat: Category) {
    setFormData({
      name: cat.name,
      description: cat.description || "",
      icon: cat.icon || "",
      color: cat.color || "#3b82f6",
      isActive: cat.isActive,
      sortOrder: cat.sortOrder,
      defaultFollowUpDays: cat.defaultFollowUpDays ?? 7,
      defaultLeadPriority: cat.defaultLeadPriority || "normal",
      autoAssignSupport: cat.autoAssignSupport,
      supportAiInstructions: cat.supportAiInstructions || "",
      cmsTemplateInstructions: cat.cmsTemplateInstructions || "",
      followUpDays: null,
      leadReminderDays: 3,
      leadPriority: "",
    });
    setEditingCategory(cat);
    setDialogMode("edit-category");
  }

  function openCreateSubcategory(catId: number) {
    setFormData({
      name: "",
      description: "",
      icon: "",
      color: "#3b82f6",
      isActive: true,
      sortOrder: 0,
      defaultFollowUpDays: 7,
      defaultLeadPriority: "normal",
      autoAssignSupport: false,
      supportAiInstructions: "",
      cmsTemplateInstructions: "",
      followUpDays: "",
      leadReminderDays: 3,
      leadPriority: "",
    });
    setParentCategoryId(catId);
    setEditingSubcategory(null);
    setDialogMode("create-subcategory");
  }

  function openEditSubcategory(catId: number, sub: Subcategory) {
    setFormData({
      name: sub.name,
      description: sub.description || "",
      icon: "",
      color: "#3b82f6",
      isActive: sub.isActive,
      sortOrder: sub.sortOrder,
      defaultFollowUpDays: 7,
      defaultLeadPriority: "normal",
      autoAssignSupport: false,
      supportAiInstructions: "",
      cmsTemplateInstructions: "",
      followUpDays: sub.followUpDays ?? "",
      leadReminderDays: sub.leadReminderDays ?? 3,
      leadPriority: sub.leadPriority || "",
    });
    setParentCategoryId(catId);
    setEditingSubcategory(sub);
    setDialogMode("edit-subcategory");
  }

  // ─── Save handlers ──────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    try {
      if (dialogMode === "create-category") {
        await api.post("/api/admin/business-categories", formData);
        toast({ title: "Category created" });
      } else if (dialogMode === "edit-category" && editingCategory) {
        await api.put(`/api/admin/business-categories/${editingCategory.id}`, formData);
        toast({ title: "Category updated" });
      } else if (dialogMode === "create-subcategory" && parentCategoryId) {
        await api.post(`/api/admin/business-categories/${parentCategoryId}/subcategories`, formData);
        toast({ title: "Subcategory created" });
      } else if (dialogMode === "edit-subcategory" && parentCategoryId && editingSubcategory) {
        await api.put(
          `/api/admin/business-categories/${parentCategoryId}/subcategories/${editingSubcategory.id}`,
          formData
        );
        toast({ title: "Subcategory updated" });
      }
      setDialogMode(null);
      fetchCategories();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCategory(catId: number) {
    if (!confirm("Delete this category and all its subcategories?")) return;
    try {
      await api.delete(`/api/admin/business-categories/${catId}`);
      toast({ title: "Category deleted" });
      fetchCategories();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete category";
      toast({ title: "Error", description: message, variant: "destructive" });
    }
  }

  async function handleDeleteSubcategory(catId: number, subId: number) {
    if (!confirm("Delete this subcategory?")) return;
    try {
      await api.delete(`/api/admin/business-categories/${catId}/subcategories/${subId}`);
      toast({ title: "Subcategory deleted" });
      fetchCategories();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete subcategory";
      toast({ title: "Error", description: message, variant: "destructive" });
    }
  }

  async function handleToggleActive(catId: number, isActive: boolean) {
    try {
      await api.put(`/api/admin/business-categories/${catId}`, { isActive });
      fetchCategories();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to toggle status";
      toast({ title: "Error", description: message, variant: "destructive" });
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  const isCategoryDialog = dialogMode === "create-category" || dialogMode === "edit-category";
  const isSubcategoryDialog = dialogMode === "create-subcategory" || dialogMode === "edit-subcategory";

  if (!loading && loadError) {
    return <PageErrorState title="Business categories could not be loaded" description={loadError} reset={() => void fetchCategories()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Business Profile Categories</h1>
          <p className="text-muted-foreground">
            Define categories and subcategories for business profiles. These settings control lead follow-up reminders,
            Support AI behavior, and CMS templates.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchCategories} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={openCreateCategory}>
            <Plus className="h-4 w-4 mr-2" />
            Add Category
          </Button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <LoadingState size="section" label="Loading business categories…" />
      )}

      {/* Empty state */}
      {!loading && categories.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Layers className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No categories yet</h3>
            <p className="text-muted-foreground mb-4">
              Create your first business profile category to get started.
            </p>
            <Button onClick={openCreateCategory}>
              <Plus className="h-4 w-4 mr-2" />
              Add Category
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Categories list */}
      {!loading && categories.length > 0 && (
        <Accordion type="multiple" className="space-y-3">
          {categories.map((cat) => (
            <AccordionItem
              key={cat.id}
              value={`cat-${cat.id}`}
              className="border rounded-lg bg-card"
            >
              <AccordionTrigger className="px-4 py-3 hover:no-underline [&[data-state=open]>div>.chevron]:rotate-90">
                <div className="flex items-center gap-3 flex-1 text-left">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: cat.color || "#6366f1" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{cat.name}</span>
                      {!cat.isActive && (
                        <Badge variant="secondary" className="text-xs">Inactive</Badge>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {cat.subcategories.length} sub{cat.subcategories.length !== 1 ? "s" : ""}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {cat.profileCount} profile{cat.profileCount !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    {cat.description && (
                      <p className="text-sm text-muted-foreground truncate">{cat.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={cat.isActive}
                      onCheckedChange={(val) => handleToggleActive(cat.id, val)}
                    />
                    <Button variant="ghost" size="icon" onClick={() => openEditCategory(cat)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDeleteCategory(cat.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  {/* Category Settings Summary */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Follow-up Days</p>
                      <p className="font-medium">{cat.defaultFollowUpDays ?? 7}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Lead Priority</p>
                      <p className="font-medium capitalize">{cat.defaultLeadPriority || "normal"}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Auto-Assign Support</p>
                      <p className="font-medium">{cat.autoAssignSupport ? "Yes" : "No"}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Support AI</p>
                      <p className="font-medium">{cat.supportAiInstructions ? "Configured" : "Default"}</p>
                    </div>
                  </div>

                  <Separator />

                  {/* Subcategories */}
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <FolderTree className="h-4 w-4" />
                      Subcategories
                    </h4>
                    <Button size="sm" variant="outline" onClick={() => openCreateSubcategory(cat.id)}>
                      <Plus className="h-3 w-3 mr-1" />
                      Add Subcategory
                    </Button>
                  </div>

                  {cat.subcategories.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No subcategories yet. Add one to define lead-specific settings.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {cat.subcategories.map((sub) => (
                        <div
                          key={sub.id}
                          className="flex items-center gap-3 rounded-md border p-3 hover:bg-muted/50 transition-colors"
                        >
                          <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{sub.name}</span>
                              {!sub.isActive && (
                                <Badge variant="secondary" className="text-xs">Inactive</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                              {sub.leadReminderDays != null && (
                                <span>Reminder: {sub.leadReminderDays}d</span>
                              )}
                              {sub.followUpDays != null && (
                                <span>Follow-up: {sub.followUpDays}d</span>
                              )}
                              {sub.leadPriority && (
                                <span className="capitalize">Priority: {sub.leadPriority}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEditSubcategory(cat.id, sub)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => handleDeleteSubcategory(cat.id, sub.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      {/* ─── Category Dialog ─────────────────────────────────────────────────── */}
      <Dialog open={isCategoryDialog} onOpenChange={(open) => !open && setDialogMode(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "create-category" ? "Create Category" : "Edit Category"}
            </DialogTitle>
            <DialogDescription>
              Define a business profile category with its settings for lead management, Support AI, and CMS.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={formData.name || ""}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Technology"
                />
              </div>
              <div className="space-y-2">
                <Label>Icon (emoji or text)</Label>
                <Input
                  value={formData.icon || ""}
                  onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                  placeholder="e.g. 💻"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={formData.description || ""}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of this business category"
                rows={2}
              />
            </div>

            {/* Color */}
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex items-center gap-2">
                {COLOR_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`w-7 h-7 rounded-full border-2 transition-all ${
                      formData.color === c ? "border-foreground scale-110" : "border-transparent"
                    }`}
                    style={{ backgroundColor: c }}
                    onClick={() => setFormData({ ...formData, color: c })}
                  />
                ))}
              </div>
            </div>

            <Separator />

            {/* Lead settings */}
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Lead Settings
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Default Follow-up Days</Label>
                <Input
                  type="number"
                  min={1}
                  value={formData.defaultFollowUpDays ?? 7}
                  onChange={(e) =>
                    setFormData({ ...formData, defaultFollowUpDays: parseInt(e.target.value) || 7 })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Default Lead Priority</Label>
                <Select
                  value={formData.defaultLeadPriority || "normal"}
                  onValueChange={(val) => setFormData({ ...formData, defaultLeadPriority: val })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-Assign Support</Label>
                <p className="text-xs text-muted-foreground">
                  Automatically assign support tickets for leads in this category
                </p>
              </div>
              <Switch
                checked={formData.autoAssignSupport ?? false}
                onCheckedChange={(val) => setFormData({ ...formData, autoAssignSupport: val })}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive categories won&apos;t be available for selection
                </p>
              </div>
              <Switch
                checked={formData.isActive ?? true}
                onCheckedChange={(val) => setFormData({ ...formData, isActive: val })}
              />
            </div>

            <Separator />

            {/* AI & CMS */}
            <h4 className="text-sm font-medium">Support AI Instructions</h4>
            <Textarea
              value={formData.supportAiInstructions || ""}
              onChange={(e) => setFormData({ ...formData, supportAiInstructions: e.target.value })}
              placeholder="Custom instructions for Support AI when handling leads in this category..."
              rows={3}
            />

            <h4 className="text-sm font-medium">CMS Template Instructions</h4>
            <Textarea
              value={formData.cmsTemplateInstructions || ""}
              onChange={(e) => setFormData({ ...formData, cmsTemplateInstructions: e.target.value })}
              placeholder="Template instructions for content generation in this category..."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogMode(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!formData.name?.trim()}>
              {dialogMode === "create-category" ? "Create" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Subcategory Dialog ──────────────────────────────────────────────── */}
      <Dialog open={isSubcategoryDialog} onOpenChange={(open) => !open && setDialogMode(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "create-subcategory" ? "Add Subcategory" : "Edit Subcategory"}
            </DialogTitle>
            <DialogDescription>
              Define lead-specific settings for this subcategory including reminders and priority.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={formData.name || ""}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. SaaS, Enterprise, Startup"
              />
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={formData.description || ""}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description"
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Follow-up Days</Label>
                <Input
                  type="number"
                  min={1}
                  value={formData.followUpDays ?? ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      followUpDays: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  placeholder="Inherit from category"
                />
              </div>
              <div className="space-y-2">
                <Label>Lead Reminder Days</Label>
                <Input
                  type="number"
                  min={1}
                  value={formData.leadReminderDays ?? 3}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      leadReminderDays: parseInt(e.target.value) || 3,
                    })
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Lead Priority</Label>
              <Select
                value={formData.leadPriority || "__inherit__"}
                onValueChange={(val) => setFormData({
                  ...formData,
                  leadPriority: val === "__inherit__" ? "" : val,
                })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Inherit from category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit from category</SelectItem>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Label>Active</Label>
              <Switch
                checked={formData.isActive ?? true}
                onCheckedChange={(val) => setFormData({ ...formData, isActive: val })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogMode(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!formData.name?.trim()}>
              {dialogMode === "create-subcategory" ? "Create" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
