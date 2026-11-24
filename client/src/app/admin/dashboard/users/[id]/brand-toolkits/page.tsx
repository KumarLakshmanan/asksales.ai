"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { normalizeUploadUrl } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Palette } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { PageErrorState } from "@/components/ui/page-state";

interface BrandToolkit {
  id: number;
  name?: string;
  logo?: string;
  logoUrl?: string;
  logo_url?: string;
  primaryColor?: string;
  primary_color?: string;
  secondaryColor?: string;
  secondary_color?: string;
  brandColors?: string[];
  brand_colors?: string[];
  voice?: string;
  brandVoice?: string;
  brand_voice?: string;
  createdAt?: string;
  created_at?: string;
}

export default function UserBrandToolkitsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [toolkits, setToolkits] = useState<BrandToolkit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchToolkits = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<BrandToolkit[] | { toolkits?: BrandToolkit[]; brandToolkits?: BrandToolkit[]; data?: BrandToolkit[] }>(`/api/admin/users/${id}/brand-toolkits`);
      setToolkits(
        Array.isArray(data)
          ? data
          : data.toolkits || data.brandToolkits || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load brand toolkits";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchToolkits();
  }, [fetchToolkits]);

  if (loading) {
    return <LoadingState size="page" label="Loading brand toolkits…" />;
  }


  if (loadError) {
    return <PageErrorState title="Brand toolkits could not be loaded" description={loadError} reset={() => void fetchToolkits()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:items-center sm:gap-4">
        <Link href={`/admin/dashboard/users/${id}/view`} className="shrink-0">
          <Button variant="ghost" size="icon" aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">Brand Toolkits</h1>
          <p className="text-muted-foreground mt-1">
            Brand toolkits created by this user
          </p>
        </div>
      </div>

      {toolkits.length === 0 ? (
        <div className="text-center py-12">
          <Palette className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No brand toolkits found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {toolkits.map((toolkit) => {
            const colors = toolkit.brandColors ||
              toolkit.brand_colors ||
              [
                toolkit.primaryColor || toolkit.primary_color,
                toolkit.secondaryColor || toolkit.secondary_color,
              ].filter(Boolean);
            const voice =
              toolkit.voice || toolkit.brandVoice || toolkit.brand_voice;
            const logoSrc =
              toolkit.logo || toolkit.logoUrl || toolkit.logo_url;

            return (
              <Card
                key={toolkit.id}
                className="hover:border-purple-300 transition-colors"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    {logoSrc ? (
                      <img
                        src={normalizeUploadUrl(logoSrc)}
                        alt={toolkit.name || "Logo"}
                        className="h-10 w-10 rounded-lg object-contain border"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-fuchsia-50 dark:bg-fuchsia-900/20 flex items-center justify-center">
                        <Palette className="h-5 w-5 text-fuchsia-500" />
                      </div>
                    )}
                    <CardTitle className="text-base">
                      {toolkit.name || `Toolkit #${toolkit.id}`}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {colors.length > 0 && (
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5">
                        Colors
                      </span>
                      <div className="flex gap-1.5">
                        {(colors as string[]).slice(0, 6).map((color, i) => (
                          <div
                            key={i}
                            className="h-6 w-6 rounded-full border shadow-sm"
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {voice && (
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1">
                        Brand Voice
                      </span>
                      <p className="text-sm line-clamp-2">{voice}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        {toolkits.length} toolkit{toolkits.length !== 1 ? "s" : ""} total
      </div>
    </div>
  );
}
