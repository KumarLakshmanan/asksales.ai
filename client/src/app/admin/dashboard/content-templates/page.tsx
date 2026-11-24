"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "@/components/ui/dialog";
import {
  FileText,
  Image,
  Video,
  Mail,
  MessageSquare,
  Share2,
  Megaphone,
  Eye,
  User,
  Hash,
} from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface ContentTemplate {
  id: number;
  title?: string;
  name?: string;
  type?: string;
  category?: string;
  content?: string;
  body?: string;
  subject?: string;
  creator?: string;
  creatorName?: string;
  creator_name?: string;
  usageCount?: number;
  usage_count?: number;
  preview?: string;
  createdAt?: string;
  created_at?: string;
}

type CategoryKey = "all" | "image" | "video" | "email" | "sms" | "social" | "ads" | "other";

const categoryConfig: Record<CategoryKey, { label: string; icon: React.ElementType; color: string }> = {
  all: { label: "All", icon: FileText, color: "bg-purple-100 text-purple-800" },
  image: { label: "Images", icon: Image, color: "bg-blue-100 text-blue-800" },
  video: { label: "Videos", icon: Video, color: "bg-pink-100 text-pink-800" },
  email: { label: "Emails", icon: Mail, color: "bg-green-100 text-green-800" },
  sms: { label: "SMS", icon: MessageSquare, color: "bg-yellow-100 text-yellow-800" },
  social: { label: "Social", icon: Share2, color: "bg-indigo-100 text-indigo-800" },
  ads: { label: "Ads", icon: Megaphone, color: "bg-red-100 text-red-800" },
  other: { label: "Other", icon: FileText, color: "bg-gray-100 text-gray-800" },
};

export default function ContentTemplatesPage() {
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey>("all");
  const [selectedTemplate, setSelectedTemplate] = useState<ContentTemplate | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { toast } = useToast();

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<unknown>("/api/admin/content-templates");
      const templatesList: ContentTemplate[] = Array.isArray(data)
        ? (data as ContentTemplate[])
        : ((data as Record<string, unknown>).templates as ContentTemplate[]) || ((data as Record<string, unknown>).data as ContentTemplate[]) || [];
      setTemplates(templatesList);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load templates";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const getTemplateType = (template: ContentTemplate): string => {
    return (template.type || template.category || "other").toLowerCase();
  };

  const getTypeBadge = (type: string) => {
    const lower = type.toLowerCase();
    if (lower.includes("image")) return categoryConfig.image;
    if (lower.includes("video")) return categoryConfig.video;
    if (lower.includes("email")) return categoryConfig.email;
    if (lower.includes("sms")) return categoryConfig.sms;
    if (lower.includes("social")) return categoryConfig.social;
    if (lower.includes("ad")) return categoryConfig.ads;
    return categoryConfig.all;
  };

  const filteredTemplates = templates.filter((t) => {
    const q = searchQuery.toLowerCase();
    const type = getTemplateType(t);
    const normalizedCategory = (["image", "video", "email", "sms", "social", "ads"] as const)
      .find((category) => type.includes(category === "ads" ? "ad" : category));
    const matchesCategory = categoryFilter === "all"
      || (categoryFilter === "other" ? !normalizedCategory : normalizedCategory === categoryFilter);
    return matchesCategory && (
      (t.title || t.name || "").toLowerCase().includes(q) ||
      (t.content || t.body || "").toLowerCase().includes(q) ||
      (t.creator || t.creatorName || t.creator_name || "").toLowerCase().includes(q)
    );
  });

  const typeCounts = templates.reduce<Record<string, number>>((acc, t) => {
    const type = getTemplateType(t);
    if (type.includes("image")) acc.image = (acc.image || 0) + 1;
    else if (type.includes("video")) acc.video = (acc.video || 0) + 1;
    else if (type.includes("email")) acc.email = (acc.email || 0) + 1;
    else if (type.includes("sms")) acc.sms = (acc.sms || 0) + 1;
    else if (type.includes("social")) acc.social = (acc.social || 0) + 1;
    else if (type.includes("ad")) acc.ads = (acc.ads || 0) + 1;
    else acc.other = (acc.other || 0) + 1;
    return acc;
  }, {});

  const handleViewDetails = (template: ContentTemplate) => {
    setSelectedTemplate(template);
    setDetailOpen(true);
  };

  if (loading) {
    return (
      <LoadingState size="page" label="Loading content templates…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Content templates could not be loaded" description={loadError} reset={() => void fetchTemplates()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <FileText className="h-8 w-8 text-purple-600" />
          Content Templates
        </h1>
        <p className="text-muted-foreground mt-1">
          Browse and manage all content templates across the platform
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Card className="bg-gradient-to-br from-purple-500/10 to-purple-700/10 border-0">
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{templates.length}</div>
            <div className="text-xs text-muted-foreground">Total</div>
          </CardContent>
        </Card>
        {(Object.keys(categoryConfig) as CategoryKey[])
          .filter((k) => k !== "all")
          .map((key) => {
            const config = categoryConfig[key];
            const count = typeCounts[key] || 0;
            return (
              <Card key={key} className="border-0">
                <CardContent className="p-4 text-center">
                  <div className="text-2xl font-bold">{count}</div>
                  <div className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                    <config.icon className="h-3 w-3" />
                    {config.label}
                  </div>
                </CardContent>
              </Card>
            );
          })}
      </div>

      {/* Search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          placeholder="Search templates..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="flex-1 max-w-md"
          aria-label="Search content templates by title, content, or creator"
        />
        <Select value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as CategoryKey)}>
          <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filter content templates by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {(Object.keys(categoryConfig) as CategoryKey[]).filter((key) => key !== "all").map((key) => (
              <SelectItem key={key} value={key}>{key === "other" ? "Other" : categoryConfig[key].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(searchQuery || categoryFilter !== "all") && (
          <Button variant="ghost" onClick={() => { setSearchQuery(""); setCategoryFilter("all"); }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Template Grid */}
      {filteredTemplates.length === 0 ? (
        <div className="text-center py-12">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            {searchQuery || categoryFilter !== "all" ? "No templates match these filters" : "No content templates are available yet"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredTemplates.map((template) => {
            const typeInfo = getTypeBadge(getTemplateType(template));
            return (
              <Card
                key={template.id}
                className="hover:shadow-md transition-shadow"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold line-clamp-2">
                      {template.title || template.name || "Untitled"}
                    </CardTitle>
                    <Badge className={`${typeInfo.color} shrink-0 text-xs`}>
                      <typeInfo.icon className="h-3 w-3 mr-1" />
                      {getTemplateType(template)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(template.content || template.body || template.subject) && (
                    <p className="text-sm text-muted-foreground line-clamp-3">
                      {template.subject || template.content || template.body}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {template.creator || template.creatorName || template.creator_name || "System"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Hash className="h-3 w-3" />
                      {template.usageCount ?? template.usage_count ?? 0} uses
                    </span>
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => handleViewDetails(template)}>
                    <Eye className="h-4 w-4 mr-2" />
                    View Details
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selectedTemplate?.title || selectedTemplate?.name || "Template Details"}
            </DialogTitle>
            <DialogDescription>
              Created {formatDate(selectedTemplate?.createdAt || selectedTemplate?.created_at)}
            </DialogDescription>
          </DialogHeader>
          {selectedTemplate && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge className={getTypeBadge(getTemplateType(selectedTemplate)).color}>
                  {getTemplateType(selectedTemplate)}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  by {selectedTemplate.creator || selectedTemplate.creatorName || selectedTemplate.creator_name || "System"}
                </span>
                <span className="text-sm text-muted-foreground">
                  · {selectedTemplate.usageCount ?? selectedTemplate.usage_count ?? 0} uses
                </span>
              </div>
              {selectedTemplate.subject && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Subject</h4>
                  <p className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
                    {selectedTemplate.subject}
                  </p>
                </div>
              )}
              {(selectedTemplate.content || selectedTemplate.body) && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Content</h4>
                  <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                    {selectedTemplate.content || selectedTemplate.body}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <div className="text-sm text-muted-foreground">
        Showing {filteredTemplates.length} of {templates.length} templates
      </div>
    </div>
  );
}
