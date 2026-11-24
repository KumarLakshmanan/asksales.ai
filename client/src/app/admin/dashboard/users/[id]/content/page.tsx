"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ArrowLeft,
  FileText,
  Image,
  Video,
  Mail,
  MessageSquare,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface ContentAsset {
  id: number;
  title?: string;
  type?: string;
  contentType?: string;
  content_type?: string;
  content?: string;
  channel?: string;
  status?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  createdAt?: string;
  created_at?: string;
}

const typeIconMap: Record<string, React.ElementType> = {
  email: Mail,
  social: MessageSquare,
  image: Image,
  video: Video,
  blog: FileText,
  ad: FileText,
  ad_copy: FileText,
  sms: MessageSquare,
  landing_page: FileText,
};

const typeColorMap: Record<string, string> = {
  email: "bg-blue-50 text-blue-600",
  social: "bg-pink-50 text-pink-600",
  image: "bg-emerald-50 text-emerald-600",
  video: "bg-purple-50 text-purple-600",
  blog: "bg-orange-50 text-orange-600",
  ad: "bg-amber-50 text-amber-600",
  ad_copy: "bg-amber-50 text-amber-600",
  sms: "bg-green-50 text-green-600",
  landing_page: "bg-indigo-50 text-indigo-600",
};

export default function UserContentPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [content, setContent] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedContent, setSelectedContent] = useState<ContentAsset | null>(null);
  const [filterType, setFilterType] = useState<string>("all");

  const fetchContent = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<ContentAsset[] | { content?: ContentAsset[]; assets?: ContentAsset[]; data?: ContentAsset[] }>(`/api/admin/users/${id}/content`);
      setContent(
        Array.isArray(data) ? data : data.content || data.assets || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load content";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  const getTypeKey = (item: ContentAsset) => {
    return (item.type || item.contentType || item.content_type || "").toLowerCase();
  };

  const getTypeIcon = (type?: string) => {
    const key = (type || "").toLowerCase();
    return typeIconMap[key] || FileText;
  };

  const getTypeColor = (type?: string) => {
    const key = (type || "").toLowerCase();
    return typeColorMap[key] || "bg-muted text-muted-foreground";
  };

  // Get unique types for filter
  const uniqueTypes = Array.from(new Set(content.map(getTypeKey).filter(Boolean)));

  const filteredContent = content.filter((c) => {
    const matchesSearch = (c.title || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.content || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === "all" || getTypeKey(c) === filterType;
    return matchesSearch && matchesType;
  });

  if (loading) {
    return <LoadingState size="page" label="Loading content…" />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/dashboard/users/${id}/view`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-black tracking-tighter">User Content</h1>
          <p className="text-muted-foreground mt-1">
            Content assets created by this user
          </p>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Content could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchContent()}>Try again</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <SearchInput
          aria-label="Search content"
          placeholder="Search content..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="flex-1 max-w-md"
        />
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={filterType === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("all")}
            className={filterType === "all" ? "bg-purple-600 hover:bg-purple-700" : ""}
          >
            All ({content.length})
          </Button>
          {uniqueTypes.map((type) => (
            <Button
              key={type}
              variant={filterType === type ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterType(type)}
              className={filterType === type ? "bg-purple-600 hover:bg-purple-700" : ""}
            >
              <span className="capitalize">{type}</span>
              <span className="ml-1 text-xs">({content.filter(c => getTypeKey(c) === type).length})</span>
            </Button>
          ))}
        </div>
      </div>

      {!loadError && (filteredContent.length === 0 ? (
        <div className="text-center py-12">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No content assets found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredContent.map((item) => {
            const typeKey = getTypeKey(item);
            const TypeIcon = getTypeIcon(typeKey);
            const colorClass = getTypeColor(typeKey);
            return (
              <Card
                key={item.id}
                className="hover:border-purple-300 hover:shadow-md transition-all cursor-pointer group"
                onClick={() => setSelectedContent(item)}
              >
                {/* Image preview if available */}
                {item.imageUrl && (
                  <div className="h-32 overflow-hidden rounded-t-lg bg-muted">
                    <img
                      src={item.imageUrl}
                      alt={item.title || "Content"}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${colorClass}`}>
                      <TypeIcon className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-sm line-clamp-1 group-hover:text-purple-700 transition-colors">
                      {item.title || `Content #${item.id}`}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {item.content && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {item.content.slice(0, 120)}
                    </p>
                  )}
                  <div className="flex items-center justify-between">
                    <StatusBadge status={item.status || "draft"} />
                    <span className="text-xs text-muted-foreground capitalize">
                      {item.channel || typeKey || "—"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(item.createdAt || item.created_at)}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ))}

      {!loadError && <div className="text-sm text-muted-foreground">
        Showing {filteredContent.length} of {content.length} assets
      </div>}

      {/* Content Preview Dialog */}
      <Dialog open={!!selectedContent} onOpenChange={(open) => !open && setSelectedContent(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedContent && (() => {
                const Icon = getTypeIcon(getTypeKey(selectedContent));
                return <Icon className="h-5 w-5 text-purple-600" />;
              })()}
              {selectedContent?.title || `Content #${selectedContent?.id}`}
            </DialogTitle>
          </DialogHeader>
          {selectedContent && (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-4">
                {/* Metadata */}
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status={selectedContent.status || "draft"} />
                  <Badge variant="outline" className="capitalize">
                    {getTypeKey(selectedContent) || "unknown"}
                  </Badge>
                  {selectedContent.channel && (
                    <Badge variant="outline" className="capitalize">
                      {selectedContent.channel}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {formatDate(selectedContent.createdAt || selectedContent.created_at)}
                  </span>
                </div>

                {/* Image preview */}
                {(selectedContent.imageUrl || (selectedContent.imageUrls && selectedContent.imageUrls.length > 0)) && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Images</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {selectedContent.imageUrl && (
                        <img
                          src={selectedContent.imageUrl}
                          alt="Content"
                          className="rounded-lg border max-h-48 object-cover w-full"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      {selectedContent.imageUrls?.map((url, i) => (
                        <img
                          key={i}
                          src={url}
                          alt={`Image ${i + 1}`}
                          className="rounded-lg border max-h-48 object-cover w-full"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Video preview */}
                {(selectedContent.videoUrl || (selectedContent.videoUrls && selectedContent.videoUrls.length > 0)) && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Videos</h4>
                    {selectedContent.videoUrl && (
                      <a href={selectedContent.videoUrl} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-purple-600 hover:underline">
                        <ExternalLink className="h-4 w-4" />
                        View Video
                      </a>
                    )}
                    {selectedContent.videoUrls?.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-purple-600 hover:underline">
                        <ExternalLink className="h-4 w-4" />
                        Video {i + 1}
                      </a>
                    ))}
                  </div>
                )}

                {/* Content body */}
                {selectedContent.content && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium">Content</h4>
                      <CopyButton
                        variant="ghost"
                        size="sm"
                        value={selectedContent.content || ""}
                      />
                    </div>
                    <div className="rounded-lg border bg-muted/50 p-4 text-sm whitespace-pre-wrap text-foreground">
                      {selectedContent.content}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
