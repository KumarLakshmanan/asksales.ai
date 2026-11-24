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
import { Badge } from "@/components/ui/badge";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Plus,
  Eye,
  Pencil,
  Trash2,
  Code,
  FileText,
} from "lucide-react";

interface EmailTemplate {
  id: number;
  name: string;
  type: string;
  subject?: string;
  content: string;
  htmlContent?: string;
  description?: string;
  category?: string;
  tags?: string[];
  variables?: string[];
  isPredefined: boolean;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

type EditorMode = "visual" | "html";

export default function AdminEmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<EmailTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");

  // Form state
  const [formName, setFormName] = useState("");
  const [formSubject, setFormSubject] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formHtmlContent, setFormHtmlContent] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formTags, setFormTags] = useState("");

  const { toast } = useToast();

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<EmailTemplate[]>("/api/admin/predefined-templates?type=email");
      setTemplates(Array.isArray(data) ? data : []);
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
    setFormSubject("");
    setFormDescription("");
    setFormContent("");
    setFormHtmlContent("");
    setFormCategory("");
    setFormTags("");
    setEditorMode("visual");
  };

  const openCreate = () => {
    resetForm();
    setEditId(null);
    setCreateOpen(true);
  };

  const openEdit = (template: EmailTemplate) => {
    setFormName(template.name);
    setFormSubject(template.subject || "");
    setFormDescription(template.description || "");
    setFormContent(template.content);
    setFormHtmlContent(template.htmlContent || "");
    setFormCategory(template.category || "");
    setFormTags((template.tags || []).join(", "));
    setEditorMode(template.htmlContent ? "html" : "visual");
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
        type: "email",
        subject: formSubject.trim() || null,
        description: formDescription.trim() || null,
        content: formContent.trim(),
        htmlContent: formHtmlContent.trim() || null,
        category: formCategory.trim() || null,
        tags: formTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
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
    return (
      t.name.toLowerCase().includes(q) ||
      (t.subject || "").toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return (
      <LoadingState size="page" label="Loading email templates…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Email templates could not be loaded" description={loadError} reset={() => void fetchTemplates()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <Mail className="h-8 w-8 text-blue-600" />
            Predefined Email Templates
          </h1>
          <p className="text-muted-foreground mt-1">
            Create email templates that all users can import into their accounts
          </p>
        </div>
        <Button onClick={openCreate} className="w-fit shrink-0 gap-2">
          <Plus className="h-4 w-4" />
          New Template
        </Button>
      </div>

      {/* Search */}
      <SearchInput
        aria-label="Search email templates"
        placeholder="Search templates..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="max-w-md"
      />

      {/* Stats */}
      <div className="flex gap-4">
        <Badge variant="secondary" className="text-sm py-1 px-3">
          {templates.length} template{templates.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Template Grid */}
      {filteredTemplates.length === 0 ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <Mail className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? "No templates match your search" : "No predefined email templates yet"}
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
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {template.htmlContent ? "HTML" : "Text"}
                  </Badge>
                </div>
                {template.subject && (
                  <CardDescription className="line-clamp-1">
                    Subject: {template.subject}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {template.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {template.description}
                  </p>
                )}
                {(template.tags || []).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {(template.tags || []).slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
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
                  <CopyButton
                    size="sm"
                    iconOnly
                    value={template.htmlContent || template.content}
                    label={`Copy ${template.name} HTML`}
                  />
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
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit" : "Create"} Predefined Email Template</DialogTitle>
            <DialogDescription>
              This template will be available for all users to import
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Template Name *</Label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Welcome Email"
                />
              </div>
              <div className="space-y-2">
                <Label>Subject Line</Label>
                <Input
                  value={formSubject}
                  onChange={(e) => setFormSubject(e.target.value)}
                  placeholder="e.g. Welcome to {{company_name}}!"
                />
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="welcome">Welcome</SelectItem>
                    <SelectItem value="follow-up">Follow-up</SelectItem>
                    <SelectItem value="promotional">Promotional</SelectItem>
                    <SelectItem value="newsletter">Newsletter</SelectItem>
                    <SelectItem value="transactional">Transactional</SelectItem>
                    <SelectItem value="cold-outreach">Cold Outreach</SelectItem>
                    <SelectItem value="re-engagement">Re-engagement</SelectItem>
                    <SelectItem value="event">Event</SelectItem>
                    <SelectItem value="announcement">Announcement</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Tags (comma-separated)</Label>
                <Input
                  value={formTags}
                  onChange={(e) => setFormTags(e.target.value)}
                  placeholder="e.g. onboarding, b2b, saas"
                />
              </div>
            </div>

            {/* Editor Mode Toggle */}
            <div className="flex items-center gap-3 pt-2">
              <Label>Editor Mode:</Label>
              <div className="flex gap-2">
                <Button
                  variant={editorMode === "visual" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditorMode("visual")}
                >
                  <FileText className="h-4 w-4 mr-1" />
                  Plain Text
                </Button>
                <Button
                  variant={editorMode === "html" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditorMode("html")}
                >
                  <Code className="h-4 w-4 mr-1" />
                  HTML
                </Button>
              </div>
            </div>

            {/* Content Editor */}
            <div className="space-y-2">
              <Label>Email Content *</Label>
              <Textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder={
                  editorMode === "html"
                    ? "Plain text version of the email (fallback for non-HTML clients)"
                    : "Write your email content here...\n\nUse {{first_name}}, {{last_name}}, {{company_name}} for variables"
                }
                rows={editorMode === "html" ? 4 : 12}
                className="font-mono text-sm"
              />
            </div>

            {editorMode === "html" && (
              <div className="space-y-2">
                <Label>HTML Content</Label>
                <Textarea
                  value={formHtmlContent}
                  onChange={(e) => setFormHtmlContent(e.target.value)}
                  placeholder="<!DOCTYPE html>\n<html>\n<head>...</head>\n<body>\n  <!-- Your email HTML here -->\n</body>\n</html>"
                  rows={16}
                  className="font-mono text-sm"
                />
                {formHtmlContent && (
                  <div className="border rounded-lg p-4 mt-2">
                    <Label className="text-xs text-muted-foreground mb-2 block">
                      Preview
                    </Label>
                    <iframe
                      srcDoc={formHtmlContent}
                      className="w-full h-64 border rounded"
                      sandbox="allow-same-origin"
                      title="HTML Preview"
                    />
                  </div>
                )}
              </div>
            )}
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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewTemplate?.name}</DialogTitle>
            {previewTemplate?.subject && (
              <DialogDescription>Subject: {previewTemplate.subject}</DialogDescription>
            )}
          </DialogHeader>
          {previewTemplate?.htmlContent ? (
            <iframe
              srcDoc={previewTemplate.htmlContent}
              className="w-full h-[500px] border rounded"
              sandbox="allow-same-origin"
              title="Email Preview"
            />
          ) : (
            <div className="whitespace-pre-wrap p-4 bg-muted rounded-lg text-sm">
              {previewTemplate?.content}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
