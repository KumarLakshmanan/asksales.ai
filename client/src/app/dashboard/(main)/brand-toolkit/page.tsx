"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { normalizeUploadUrl } from "@/lib/utils";
import { BrandToolkitLogo } from "@/components/brand-toolkit/BrandToolkitLogo";
import {
  Plus,
  Palette,
  Star,
  Trash2,
  Pencil,
  MoreVertical,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";

interface BrandToolkitItem {
  id: number;
  name: string;
  tagline?: string;
  description?: string;
  logoUrls?: string[];
  logoUrl?: string;
  primaryColors?: string[];
  primaryBrandColor?: string;
  secondaryColors?: string[];
  isDefault?: boolean;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function BrandToolkitPage() {
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: toolkits = [], isLoading, isError, refetch } = useQuery<BrandToolkitItem[]>({
    queryKey: ["brand-toolkits"],
    queryFn: () => api.get<BrandToolkitItem[]>("/api/content/brand-toolkits"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/content/brand-toolkits/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-toolkits"] });
      toast({ title: "Deleted", description: "Brand toolkit deleted successfully" });
      setDeleteId(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete brand toolkit", variant: "destructive" });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: number) => api.post(`/api/content/brand-toolkits/${id}/default`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-toolkits"] });
      toast({ title: "Default brand updated", description: "New content and outreach without a chosen brand will use it. Existing campaigns and follow-ups keep their own brand." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to set default toolkit", variant: "destructive" });
    },
  });

  const getLogoUrl = (toolkit: BrandToolkitItem) => {
    const url = toolkit.logoUrl || toolkit.logoUrls?.[0];
    if (!url?.trim()) return null;
    return normalizeUploadUrl(url);
  };

  const getColors = (toolkit: BrandToolkitItem) => {
    const colors: string[] = [];
    if (toolkit.primaryColors?.length) colors.push(...toolkit.primaryColors);
    else if (toolkit.primaryBrandColor) colors.push(toolkit.primaryBrandColor);
    if (toolkit.secondaryColors?.length) colors.push(...toolkit.secondaryColors);
    return colors.slice(0, 5);
  };

  if (isLoading) {
    return <PageLoadingState label="Loading brand toolkits…" />;
  }

  if (isError) {
    return <PageErrorState title="Brand toolkits unavailable" description="We could not retrieve your brand assets and guidelines." reset={() => { void refetch(); }} />;
  }

  if (toolkits.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <PageHeader icon={Palette} title="Brand Toolkit" subtitle="Manage your brand assets, guidelines, and voice" />
        </div>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-8 py-20 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Palette className="h-8 w-8 text-primary" />
          </div>
          <h3 className="mb-1 text-lg font-semibold text-foreground">
            No brand toolkits yet
          </h3>
          <p className="mb-6 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Create your first brand toolkit to define your brand identity, colors, voice, and content guidelines.
          </p>
          <Button
            onClick={() => router.push("/dashboard/brand-toolkit/new")}
            className="h-10 gap-2 rounded-lg px-5 text-sm"
          >
            <Plus className="h-4 w-4" />
            Create Your First Brand
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <PageHeader icon={Palette} title="Brand Toolkit" subtitle="Manage your brand assets, guidelines, and voice" />
        <Button
          onClick={() => router.push("/dashboard/brand-toolkit/new")}
          className="h-10 gap-2 rounded-lg px-5 text-sm"
        >
          <Plus className="h-4 w-4" />
          Add Brand
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {toolkits.map((toolkit) => {
          const logoUrl = getLogoUrl(toolkit);
          const colors = getColors(toolkit);
          return (
            <Card
              key={toolkit.id}
              className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border/60 bg-card shadow-none transition-colors hover:border-primary/40"
            >
              {/* Top Area */}
              <div>
                {/* Default badge */}
                {toolkit.isDefault && (
                  <div className="absolute top-3 left-3 z-10">
                    <Badge className="bg-amber-500/95 text-white text-xs gap-1 border-none shadow-md">
                      <Star className="h-3 w-3 fill-current" />
                      Default
                    </Badge>
                  </div>
                )}

                {/* Actions Dropdown */}
                <div className="absolute top-3 right-3 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Actions for ${toolkit.name?.trim() || "Untitled Brand"}`}
                        className="h-8 w-8 rounded-lg bg-background/90 shadow-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                      >
                        <MoreVertical aria-hidden="true" className="h-4 w-4 text-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="rounded-xl font-bold p-1 shadow-xl">
                      <DropdownMenuItem
                        onClick={(event) => { event.stopPropagation(); router.push(`/dashboard/brand-toolkit/${toolkit.id}`); }}
                        className="rounded-lg h-9 text-xs gap-2"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit Brand
                      </DropdownMenuItem>
                      {!toolkit.isDefault && (
                        <DropdownMenuItem
                          onClick={(event) => { event.stopPropagation(); setDefaultMutation.mutate(toolkit.id); }}
                          className="rounded-lg h-9 text-xs gap-2"
                        >
                          <Star className="h-3.5 w-3.5" />
                          Set as Default
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="rounded-lg h-9 text-xs gap-2 text-destructive focus:text-destructive"
                        onClick={(event) => { event.stopPropagation(); setDeleteId(toolkit.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Decorative Header (Logo/Icon area) */}
                <div className="h-32 bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-950/20 dark:to-pink-950/20 flex items-center justify-center">
                  <BrandToolkitLogo src={logoUrl} name={toolkit.name} />
                </div>

                <CardContent className="p-5 space-y-2">
                  <h3 title={toolkit.name?.trim() || "Untitled Brand"} className="truncate text-base font-semibold text-foreground">
                    {toolkit.name?.trim() || "Untitled Brand"}
                  </h3>
                  
                  {toolkit.tagline && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1 font-semibold leading-relaxed">
                      {toolkit.tagline}
                    </p>
                  )}

                  {!toolkit.tagline && toolkit.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed font-medium">
                      {toolkit.description}
                    </p>
                  )}

                  {/* Brand colors */}
                  {colors.length > 0 && (
                    <div className="flex items-center gap-1.5 pt-2">
                      {colors.map((color, idx) => (
                        <div
                          key={idx}
                          role="img"
                          aria-label={`Brand color ${color}`}
                          className="w-5 h-5 rounded-full border border-gray-300 shadow-sm ring-1 ring-black/5 dark:border-gray-400/70 dark:ring-white/20"
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </div>

              {/* Bottom Actions */}
              <div className="flex gap-2 px-5 pb-5 pt-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 flex-1 rounded-lg text-xs"
                  onClick={() => router.push(`/dashboard/brand-toolkit/${toolkit.id}`)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                {!toolkit.isDefault && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 flex-1 gap-1.5 rounded-lg text-xs"
                    onClick={() => setDefaultMutation.mutate(toolkit.id)}
                  >
                    <Star className="h-3 w-3" />
                    Set as Default
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Delete Confirmation Alert Dialog */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent className="rounded-2xl p-6">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">Delete brand toolkit?</AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              This action cannot be undone. This will permanently delete this brand toolkit and all its associated data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 mt-4">
            <AlertDialogCancel className="h-10 px-4 rounded-xl font-bold text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-10 px-4 rounded-xl font-bold text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Brand"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
