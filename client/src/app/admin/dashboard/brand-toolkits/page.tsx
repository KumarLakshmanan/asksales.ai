"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { normalizeUploadUrl } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
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
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Palette,
  Eye,
  Users,
  Type,
  ImageIcon,
} from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface BrandToolkit {
  id: number;
  userId?: number;
  userName?: string;
  user_name?: string;
  brandName?: string;
  brand_name?: string;
  name?: string;
  logo?: string;
  logoUrl?: string;
  logo_url?: string;
  primaryColor?: string;
  primary_color?: string;
  secondaryColor?: string;
  secondary_color?: string;
  accentColor?: string;
  accent_color?: string;
  colors?: string[];
  voiceType?: string;
  voice_type?: string;
  tone?: string;
  fonts?: string[];
  tagline?: string;
  description?: string;
  industry?: string;
  createdAt?: string;
  created_at?: string;
}

interface StatsData {
  totalToolkits: number;
  totalUsersWithToolkits: number;
}

export default function BrandToolkitsPage() {
  const [toolkits, setToolkits] = useState<BrandToolkit[]>([]);
  const [stats, setStats] = useState<StatsData>({
    totalToolkits: 0,
    totalUsersWithToolkits: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedToolkit, setSelectedToolkit] = useState<BrandToolkit | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { toast } = useToast();

  const fetchToolkits = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<unknown>("/api/admin/brand-toolkits");
      const toolkitsList: BrandToolkit[] = Array.isArray(data)
        ? (data as BrandToolkit[])
        : ((data as Record<string, unknown>).toolkits as BrandToolkit[]) || ((data as Record<string, unknown>).data as BrandToolkit[]) || [];
      setToolkits(toolkitsList);

      const statsData = !Array.isArray(data) ? (data as Record<string, unknown>)?.stats as { totalToolkits?: number; totalUsersWithToolkits?: number } | undefined : undefined;
      if (statsData) {
        setStats({ totalToolkits: statsData.totalToolkits ?? 0, totalUsersWithToolkits: statsData.totalUsersWithToolkits ?? 0 });
      } else {
        const uniqueUsers = new Set(toolkitsList.map((t: BrandToolkit) => t.userId)).size;
        setStats({
          totalToolkits: toolkitsList.length,
          totalUsersWithToolkits: uniqueUsers,
        });
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load brand toolkits";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchToolkits();
  }, [fetchToolkits]);

  const getBrandName = (toolkit: BrandToolkit) =>
    toolkit.brandName || toolkit.brand_name || toolkit.name || "Untitled Brand";

  const getColors = (toolkit: BrandToolkit): string[] => {
    if (toolkit.colors && toolkit.colors.length > 0) return toolkit.colors;
    const colors: string[] = [];
    if (toolkit.primaryColor || toolkit.primary_color)
      colors.push(toolkit.primaryColor || toolkit.primary_color || "");
    if (toolkit.secondaryColor || toolkit.secondary_color)
      colors.push(toolkit.secondaryColor || toolkit.secondary_color || "");
    if (toolkit.accentColor || toolkit.accent_color)
      colors.push(toolkit.accentColor || toolkit.accent_color || "");
    return colors.filter(Boolean);
  };

  const getVoice = (toolkit: BrandToolkit) =>
    toolkit.voiceType || toolkit.voice_type || toolkit.tone || "—";

  const getLogoUrl = (toolkit: BrandToolkit) =>
    normalizeUploadUrl(toolkit.logo || toolkit.logoUrl || toolkit.logo_url) || null;

  const filteredToolkits = toolkits.filter((t) => {
    const q = searchQuery.toLowerCase();
    return (
      getBrandName(t).toLowerCase().includes(q) ||
      (t.userName || t.user_name || "").toLowerCase().includes(q) ||
      (t.industry || "").toLowerCase().includes(q) ||
      getVoice(t).toLowerCase().includes(q)
    );
  });

  const statCards = [
    {
      title: "Total Toolkits",
      value: stats.totalToolkits.toLocaleString(),
      icon: Palette,
      gradient: "from-purple-500 to-purple-700",
      bgGradient: "from-purple-500/10 to-purple-700/10",
    },
    {
      title: "Users with Toolkits",
      value: stats.totalUsersWithToolkits.toLocaleString(),
      icon: Users,
      gradient: "from-blue-500 to-blue-700",
      bgGradient: "from-blue-500/10 to-blue-700/10",
    },
  ];

  if (loading) {
    return (
      <LoadingState size="page" label="Loading brand toolkits…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Brand toolkits could not be loaded" description={loadError} reset={() => void fetchToolkits()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <Palette className="h-8 w-8 text-purple-600" />
          Brand Toolkits
        </h1>
        <p className="text-muted-foreground mt-1">
          View and manage brand toolkit configurations across all users
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
        {statCards.map((card) => (
          <Card
            key={card.title}
            className={`relative overflow-hidden bg-gradient-to-br ${card.bgGradient} border-0`}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div
                className={`p-2 rounded-lg bg-gradient-to-br ${card.gradient}`}
              >
                <card.icon className="h-4 w-4 text-white" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Search */}
      <SearchInput
        aria-label="Search brand toolkits"
        placeholder="Search toolkits by brand name, user, industry..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="max-w-md"
      />

      {/* Toolkits Grid */}
      {filteredToolkits.length === 0 ? (
        <div className="text-center py-12">
          <Palette className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No brand toolkits found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredToolkits.map((toolkit) => {
            const colors = getColors(toolkit);
            const logoUrl = getLogoUrl(toolkit);
            return (
              <Card
                key={toolkit.id}
                className="hover:shadow-md transition-shadow"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt={getBrandName(toolkit)}
                        className="h-10 w-10 rounded-md object-contain bg-muted p-1"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-md bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                        <ImageIcon className="h-5 w-5 text-purple-600" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base font-semibold truncate">
                        {getBrandName(toolkit)}
                      </CardTitle>
                      {(toolkit.userName || toolkit.user_name) && (
                        <p className="text-xs text-muted-foreground truncate">
                          by {toolkit.userName || toolkit.user_name}
                        </p>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Color Swatches */}
                  {colors.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Colors:</span>
                      <div className="flex gap-1">
                        {colors.map((color, idx) => (
                          <div
                            key={idx}
                            className="h-6 w-6 rounded-full border border-gray-300 dark:border-gray-600"
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Voice */}
                  <div className="flex items-center gap-2">
                    <Type className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Voice:</span>
                    <Badge variant="secondary" className="text-xs">
                      {getVoice(toolkit)}
                    </Badge>
                  </div>

                  {toolkit.industry && (
                    <div className="text-xs text-muted-foreground">
                      Industry: {toolkit.industry}
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setSelectedToolkit(toolkit);
                      setDetailOpen(true);
                    }}
                  >
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
            <DialogTitle>{selectedToolkit ? getBrandName(selectedToolkit) : "Toolkit Details"}</DialogTitle>
            <DialogDescription>
              Created {formatDate(selectedToolkit?.createdAt || selectedToolkit?.created_at)}
            </DialogDescription>
          </DialogHeader>
          {selectedToolkit && (
            <div className="space-y-5">
              {/* Logo */}
              {getLogoUrl(selectedToolkit) && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Logo</h4>
                  <img
                    src={getLogoUrl(selectedToolkit)!}
                    alt={getBrandName(selectedToolkit)}
                    className="h-20 w-auto rounded-md bg-muted p-2 object-contain"
                  />
                </div>
              )}

              {/* Colors */}
              {getColors(selectedToolkit).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Brand Colors</h4>
                  <div className="flex gap-3">
                    {getColors(selectedToolkit).map((color, idx) => (
                      <div key={idx} className="flex flex-col items-center gap-1">
                        <div
                          className="h-12 w-12 rounded-lg border border-gray-300 dark:border-gray-600"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-xs text-muted-foreground font-mono">{color}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Voice / Tone */}
              <div>
                <h4 className="text-sm font-medium mb-1">Voice / Tone</h4>
                <p className="text-sm text-muted-foreground">{getVoice(selectedToolkit)}</p>
              </div>

              {/* Fonts */}
              {selectedToolkit.fonts && selectedToolkit.fonts.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Fonts</h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedToolkit.fonts.map((font, idx) => (
                      <Badge key={idx} variant="secondary">{font}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Tagline */}
              {selectedToolkit.tagline && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Tagline</h4>
                  <p className="text-sm text-muted-foreground italic">&quot;{selectedToolkit.tagline}&quot;</p>
                </div>
              )}

              {/* Description */}
              {selectedToolkit.description && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Description</h4>
                  <p className="text-sm text-muted-foreground">{selectedToolkit.description}</p>
                </div>
              )}

              {/* Industry */}
              {selectedToolkit.industry && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Industry</h4>
                  <p className="text-sm text-muted-foreground">{selectedToolkit.industry}</p>
                </div>
              )}

              {/* User */}
              {(selectedToolkit.userName || selectedToolkit.user_name) && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Owner</h4>
                  <p className="text-sm text-muted-foreground">
                    {selectedToolkit.userName || selectedToolkit.user_name}
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <div className="text-sm text-muted-foreground">
        Showing {filteredToolkits.length} of {toolkits.length} brand toolkits
      </div>
    </div>
  );
}
