"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Ad {
  id: number;
  platform?: string;
  campaign?: string;
  campaignName?: string;
  campaign_name?: string;
  status?: string;
  impressions?: number;
  clicks?: number;
  ctr?: number | string;
  spend?: number | string;
  currency?: string | null;
  source?: "legacy_ad" | "performance_campaign";
  createdAt?: string;
  created_at?: string;
}

export default function UserAdsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchAds = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<Ad[] | { ads?: Ad[]; data?: Ad[] }>(`/api/admin/users/${id}/ads`);
      setAds(
        Array.isArray(data) ? data : data.ads || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load ads";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchAds();
  }, [fetchAds]);

  const filteredAds = ads.filter((a) => {
    const q = searchQuery.toLowerCase();
    return (
      (a.platform || "").toLowerCase().includes(q) ||
      (a.campaign || a.campaignName || a.campaign_name || "")
        .toLowerCase()
        .includes(q)
    );
  });

  if (loading) {
    return <LoadingState size="page" label="Loading ads…" />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">User Ads</h1>
          <p className="text-muted-foreground mt-1">
            Ad campaigns managed by this user
          </p>
        </div>
      </div>

      <SearchInput
        aria-label="Search ads by platform or campaign"
        placeholder="Search ads by platform or campaign..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="sm:max-w-md"
      />

      {loadError ? (
        <Alert variant="destructive">
          <BarChart3 className="h-4 w-4" />
          <AlertTitle>Ads could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchAds()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : filteredAds.length === 0 ? (
        <div className="text-center py-12">
          <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No ads found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAds.map((ad) => {
                const campaignName =
                  ad.campaign || ad.campaignName || ad.campaign_name;
                const numericCtr = ad.ctr == null ? null : Number(ad.ctr);
                const ctr =
                  numericCtr != null && Number.isFinite(numericCtr)
                    ? numericCtr
                    : ad.impressions && ad.clicks
                    ? ((ad.clicks / ad.impressions) * 100)
                    : null;
                const numericSpend = ad.spend == null ? null : Number(ad.spend);

                return (
                  <TableRow key={ad.id}>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {ad.platform || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {campaignName || "—"}
                    </TableCell>
                    <TableCell><StatusBadge status={ad.status} toneOverrides={{ running: "success", completed: "info", ended: "info" }} /></TableCell>
                    <TableCell className="text-right">
                      {ad.impressions != null
                        ? ad.impressions.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {ad.clicks != null
                        ? ad.clicks.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {ctr != null ? `${ctr.toFixed(2)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {numericSpend != null && Number.isFinite(numericSpend) ? (
                        ad.currency && /^[A-Z]{3}$/.test(ad.currency) ? new Intl.NumberFormat(undefined, {
                          style: "currency",
                          currency: ad.currency,
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        }).format(numericSpend) : (
                          <span title="This legacy record did not store a currency">
                            {numericSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs text-muted-foreground">currency unspecified</span>
                          </span>
                        )
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredAds.length} of {ads.length} ads
      </div>
    </div>
  );
}
