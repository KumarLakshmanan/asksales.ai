"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { CopyButton } from "@/components/ui/copy-button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  MessageCircle,
  Plus,
  Eye,
  Pencil,
  Trash2,
} from "lucide-react";

interface DmTemplate {
  id: number;
  name: string;
  type: string;
  content: string;
  description?: string;
  category?: string;
  isPredefined: boolean;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

const LEGACY_DM_TYPES = ["instagram_dm", "linkedin_dm", "twitter_dm", "facebook_dm"] as const;
const DM_PLATFORMS = ["instagram", "linkedin", "twitter", "facebook"] as const;

export default function AdminDmTemplatesPage() {
  const [templates, setTemplates] = useState<DmTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [partialLoadError, setPartialLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<DmTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formPlatform, setFormPlatform] = useState("instagram");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");

  const { toast } = useToast();

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      setPartialLoadError(null);
      const results = await Promise.allSettled(
        ["social_message", ...LEGACY_DM_TYPES].map((dmType) => api.get<DmTemplate[]>(`/api/admin/predefined-templates?type=${dmType}`))
      );
      const successful = results.filter((result): result is PromiseFulfilledResult<DmTemplate[]> => result.status === "fulfilled");
      if (successful.length === 0) throw new Error("No direct-message template category could be loaded.");
      const allTemplates = successful.flatMap((result) => Array.isArray(result.value) ? result.value : []);
      if (successful.length < results.length) setPartialLoadError(`${results.length - successful.length} template category requests failed. The list below may be incomplete.`);
      setTemplates(allTemplates);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load templates";
      setLoadError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const resetForm = () => {
    setFormName("");
    setFormPlatform("instagram");
    setFormDescription("");
    setFormContent("");
  };

  const openCreate = () => {
    resetForm();
    setEditId(null);
    setCreateOpen(true);
  };

  const openEdit = (template: DmTemplate) => {
    setFormName(template.name);
    setFormPlatform(template.category || template.type.replace(/_dm$/, "") || "instagram");
    setFormDescription(template.description || "");
    setFormContent(template.content);
    setEditId(template.id);
    setCreateOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formContent.trim()) {
      toast({ title: "Error", description: "Name and content are required", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        type: "social_message",
        category: formPlatform,
        description: formDescription.trim() || null,
        content: formContent.trim(),
      };

      if (editId) {
        await api.put(`/api/admin/predefined-templates/${editId}`, body);
      } else {
        await api.post("/api/admin/predefined-templates", body);
      }

      toast({ title: "Success", description: editId ? "Template updated" : "Template created" });
      setCreateOpen(false);
      resetForm();
      setEditId(null);
      fetchTemplates();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await api.delete(`/api/admin/predefined-templates/${id}`);
      toast({ title: "Deleted", description: "Template removed" });
      fetchTemplates();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const filteredTemplates = templates.filter((t) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      t.name.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q) ||
      t.content.toLowerCase().includes(q);
    return matchesSearch;
  });

  if (loading) {
    return (
      <LoadingState size="page" label="Loading DM templates…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="DM templates could not be loaded" description={loadError} reset={() => void fetchTemplates()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {partialLoadError && <Alert variant="destructive"><AlertTitle>Some template categories are unavailable</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{partialLoadError}</span><Button variant="outline" size="sm" onClick={() => void fetchTemplates()}>Try again</Button></AlertDescription></Alert>}
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <MessageCircle className="h-8 w-8 text-purple-600" />
            Predefined DM Templates
          </h1>
          <p className="text-muted-foreground mt-1">
            Create social media DM templates that all users can use for follow-ups
          </p>
        </div>
        <Button onClick={openCreate} className="w-fit shrink-0 gap-2">
          <Plus className="h-4 w-4" />
          New Template
        </Button>
      </div>

      {/* Search */}
      <div className="flex gap-4 items-center">
        <SearchInput
          aria-label="Search DM templates"
          placeholder="Search templates..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="max-w-md flex-1"
        />
      </div>

      {/* Stats */}
      <div className="flex gap-4 flex-wrap">
        <Badge variant="secondary" className="text-sm py-1 px-3">
          {templates.length} total template{templates.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Template Grid */}
      {filteredTemplates.length === 0 ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? "No templates match your search" : "No predefined DM templates yet"}
            </p>
            {!searchQuery && (
              <Button onClick={openCreate} variant="outline" className="mt-4 gap-2">
                <Plus className="h-4 w-4" />
                Create First Template
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredTemplates.map((template) => (
            <Card key={template.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base font-semibold line-clamp-2">
                    {template.name}
                  </CardTitle>

                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {template.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {template.description}
                  </p>
                )}
                <p className="text-sm line-clamp-3 bg-muted/30 p-2 rounded text-foreground">
                  {template.content}
                </p>
                <div className="text-xs text-muted-foreground">
                  Used {template.usageCount || 0} times
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setPreviewTemplate(template)}
                  >
                    <Eye className="h-3 w-3 mr-1" />
                    Preview
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openEdit(template)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <CopyButton size="sm" iconOnly value={template.content} label={`Copy ${template.name}`} />
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(template.id)}
                    loading={deletingId === template.id}
                    loadingText={null}
                    aria-label={`Delete ${template.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit" : "Create"} DM Template</DialogTitle>
            <DialogDescription>
              This template will be available for all users to use in follow-up settings
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Template Name *</Label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Instagram Follow-up #1"
                />
              </div>
              <div className="space-y-2">
                <Label>Platform *</Label>
                <Select value={formPlatform} onValueChange={setFormPlatform}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DM_PLATFORMS.map((platform) => (
                      <SelectItem key={platform} value={platform} className="capitalize">{platform}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Brief description of this template's purpose"
              />
            </div>


            {/* Content Editor */}
            <div className="space-y-2">
              <Label>Message Content *</Label>
              <Textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder={"Write your DM message here...\n\nUse {{first_name}}, {{last_name}}, {{company_name}} for variables"}
                rows={8}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Available variables: {"{{first_name}}"}, {"{{last_name}}"}, {"{{company_name}}"}, {"{{lead_source}}"}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editId ? "Update" : "Create"} Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-purple-600" />
              {previewTemplate?.name}
            </DialogTitle>
            <DialogDescription>
              {previewTemplate?.description || "DM template preview"}
            </DialogDescription>
          </DialogHeader>
          <div className="whitespace-pre-wrap p-4 bg-muted rounded-lg text-sm">
            {previewTemplate?.content}
          </div>
          {previewTemplate?.description && (
            <p className="text-sm text-muted-foreground">
              {previewTemplate.description}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
