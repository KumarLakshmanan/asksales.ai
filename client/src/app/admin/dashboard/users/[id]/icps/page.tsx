"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageErrorState } from "@/components/ui/page-state";
import { ArrowLeft, Target } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";

interface ICP {
  id: number;
  name?: string;
  industry?: string;
  companySize?: string;
  company_size?: string;
  targetRole?: string;
  target_role?: string;
  geography?: string;
  description?: string;
  createdAt?: string;
  created_at?: string;
}

export default function UserICPsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [icps, setICPs] = useState<ICP[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchICPs = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<ICP[] | { icps?: ICP[]; data?: ICP[] }>(`/api/admin/users/${id}/icps`);
      setICPs(
        Array.isArray(data) ? data : data.icps || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load ICPs";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchICPs();
  }, [fetchICPs]);

  if (loading) {
    return <LoadingState size="page" label="Loading customer profiles…" />;
  }


  if (loadError) {
    return <PageErrorState title="Customer profiles could not be loaded" description={loadError} reset={() => void fetchICPs()} />;
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
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">
            Ideal Customer Profiles
          </h1>
          <p className="text-muted-foreground mt-1">
            ICPs defined by this user
          </p>
        </div>
      </div>

      {icps.length === 0 ? (
        <div className="text-center py-12">
          <Target className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No ICPs found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {icps.map((icp) => (
            <Card
              key={icp.id}
              className="hover:border-purple-300 transition-colors"
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Target className="h-4 w-4 text-purple-500" />
                  {icp.name || `ICP #${icp.id}`}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Industry
                    </span>
                    <span className="font-medium">
                      {icp.industry || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Company Size
                    </span>
                    <span className="font-medium">
                      {icp.companySize || icp.company_size || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Target Role
                    </span>
                    <span className="font-medium">
                      {icp.targetRole || icp.target_role || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Geography
                    </span>
                    <span className="font-medium">
                      {icp.geography || "—"}
                    </span>
                  </div>
                </div>
                {icp.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {icp.description}
                  </p>
                )}
                <div className="pt-1">
                  <Badge variant="outline" className="text-xs">
                    ID: {icp.id}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        {icps.length} ICP{icps.length !== 1 ? "s" : ""} total
      </div>
    </div>
  );
}
