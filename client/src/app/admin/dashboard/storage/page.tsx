"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LoadingState } from "@/components/ui/loading-state";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import {
  HardDrive, RefreshCw, Users, FileText, Database, Image,
  Video, Music, PenTool, Megaphone, Bot, FileCode, FolderOpen, BarChart3,
} from "lucide-react";
import { formatBytes } from "@/lib/format-bytes";

interface StorageStats {
  totalUsedBytes: number;
  totalAllocatedBytes: number;
  totalUsers: number;
  totalFiles: number;
  topUsers: Array<{
    userId: number;
    email: string;
    userName: string;
    storageUsedBytes: number;
    fileCount: number;
    planName: string;
    maxStorageBytes: number;
  }>;
  categoryBreakdown: Array<{
    category: string;
    totalBytes: number;
    fileCount: number;
  }>;
}

const categoryMeta: Record<string, { icon: React.ReactNode; label: string }> = {
  image: { icon: <Image className="w-4 h-4" />, label: "AI Generated Images" },
  video: { icon: <Video className="w-4 h-4" />, label: "AI Generated Videos" },
  audio: { icon: <Music className="w-4 h-4" />, label: "Audio Files" },
  content_asset: { icon: <PenTool className="w-4 h-4" />, label: "Content Assets" },
  brand_asset: { icon: <Megaphone className="w-4 h-4" />, label: "Brand Assets" },
  knowledge_base: { icon: <Database className="w-4 h-4" />, label: "Knowledge Base" },
  actor_output: { icon: <Bot className="w-4 h-4" />, label: "Actor Output Data" },
  document: { icon: <FileText className="w-4 h-4" />, label: "Documents" },
  other: { icon: <FileCode className="w-4 h-4" />, label: "Other Files" },
};

function getCategoryMeta(cat: string) {
  return categoryMeta[cat] || { icon: <FolderOpen className="w-4 h-4" />, label: cat.replace(/_/g, " ") };
}

export default function StorageDashboardPage() {
  const { toast } = useToast();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.get<StorageStats>("/api/admin/storage/dashboard");
      if (res) {
        setStats(res);
      }
    } catch {
      setLoadError(true);
      toast({ title: "Error", description: "Failed to load storage stats", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (loading) {
    return <LoadingState size="page" label="Loading storage stats…" />;
  }

  if (loadError || !stats) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <HardDrive className="h-10 w-10 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold">Storage metrics could not be loaded</h1>
          <p className="mt-1 text-sm text-muted-foreground">Check the server connection and try again.</p>
        </div>
        <Button variant="outline" onClick={() => void fetchStats()}>Try again</Button>
      </div>
    );
  }

  const totalAllocated = stats?.totalAllocatedBytes ?? 0;
  const totalUsed = stats?.totalUsedBytes ?? 0;
  const remainingBytes = Math.max(totalAllocated - totalUsed, 0);
  const usagePercent = totalAllocated > 0 ? Math.round((totalUsed / totalAllocated) * 100) : 0;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HardDrive className="w-6 h-6 text-purple-600" />
            Storage Dashboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Overview of platform storage usage across all users
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <StatGrid columns={4} className="gap-4">
        <StatCard
          label="Total Used"
          icon={<Database />}
          value={formatBytes(totalUsed)}
          description={`of ${formatBytes(totalAllocated)} allocated`}
        />
        <StatCard
          label="Remaining"
          icon={<BarChart3 />}
          value={formatBytes(remainingBytes)}
          description={`${100 - usagePercent}% available`}
        />
        <StatCard
          label="Active Users"
          icon={<Users />}
          value={stats?.totalUsers ?? 0}
          description="users with storage quotas"
        />
        <StatCard
          label="Total Files"
          icon={<FileText />}
          value={(stats?.totalFiles ?? 0).toLocaleString()}
        />
      </StatGrid>

      {/* Overall Usage Bar */}
      <Card>
        <CardHeader>
          <CardTitle>Platform Utilization</CardTitle>
          <CardDescription>
            {formatBytes(totalUsed)} used of {formatBytes(totalAllocated)} total allocated capacity
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={usagePercent} className="h-3" />
          <p className="text-xs text-muted-foreground mt-2 text-right">{usagePercent}% used</p>
        </CardContent>
      </Card>

      {/* Category Breakdown */}
      {stats?.categoryBreakdown && stats.categoryBreakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Storage by Category</CardTitle>
            <CardDescription>Breakdown of storage usage across file categories</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {stats.categoryBreakdown.map((cat) => {
                const totalBytes = stats.totalUsedBytes || 1;
                const percent = Math.round((Number(cat.totalBytes) / totalBytes) * 100);
                const meta = getCategoryMeta(cat.category);
                return (
                  <div key={cat.category} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                    <div className="flex-shrink-0 w-8 h-8 rounded-md bg-purple-50 dark:bg-purple-950 flex items-center justify-center text-purple-600">
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium truncate">{meta.label}</span>
                        <span className="text-xs text-muted-foreground ml-2">{percent}%</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatBytes(Number(cat.totalBytes))} &middot; {cat.fileCount} files
                      </div>
                      <Progress value={percent} className="h-1.5 mt-1" />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Users */}
      {stats?.topUsers && stats.topUsers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top Users by Storage</CardTitle>
            <CardDescription>Users consuming the most storage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Limit</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Usage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.topUsers.map((user) => {
                  const maxBytes = Number(user.maxStorageBytes) || 1073741824;
                  const usedBytes = Number(user.storageUsedBytes);
                  const percent = Math.min(Math.round((usedBytes / maxBytes) * 100), 100);
                  return (
                    <TableRow key={user.userId}>
                      <TableCell>
                        <div className="font-medium">{user.email}</div>
                        <div className="text-xs text-muted-foreground">ID: {user.userId}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{user.planName || "Free"}</Badge>
                      </TableCell>
                      <TableCell>{formatBytes(usedBytes)}</TableCell>
                      <TableCell>{formatBytes(maxBytes)}</TableCell>
                      <TableCell>{user.fileCount}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={percent} className="h-2 w-20" />
                          <span className="text-xs text-muted-foreground">{percent}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
