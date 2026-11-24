"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { FolderOpen, RefreshCw, Trash2, HardDrive, Settings } from "lucide-react";
import { formatBytes } from "@/lib/format-bytes";

interface StorageQuota {
  id: number;
  userId: number;
  email: string;
  planId: number | null;
  planName: string;
  storageUsedBytes: number;
  maxStorageBytes: number;
  fileCount: number;
  lastCalculatedAt: string | null;
}

interface StorageFile {
  id: number;
  fileName: string;
  originalName: string;
  mimeType: string | null;
  fileSizeBytes: number;
  category: string;
  referenceType: string | null;
  url: string | null;
  createdAt: string;
}

interface StoragePlan {
  id: number;
  name: string;
  maxStorageBytes: number;
}

export default function StorageUsersPage() {
  const { toast } = useToast();
  const [quotas, setQuotas] = useState<StorageQuota[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotaLoadError, setQuotaLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [quotaTotal, setQuotaTotal] = useState(0);
  const [quotasHaveMore, setQuotasHaveMore] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // User detail state
  const [selectedUser, setSelectedUser] = useState<StorageQuota | null>(null);
  const [userFiles, setUserFiles] = useState<StorageFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoadError, setFilesLoadError] = useState(false);
  const [filesLoadingMore, setFilesLoadingMore] = useState(false);
  const [userFilesTotal, setUserFilesTotal] = useState(0);
  const [userFilesHaveMore, setUserFilesHaveMore] = useState(false);
  const [userDetailOpen, setUserDetailOpen] = useState(false);
  const [fileSelectedIds, setFileSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [fileCategoryFilter, setFileCategoryFilter] = useState<string>("all");

  // Settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsUser, setSettingsUser] = useState<StorageQuota | null>(null);
  const [plans, setPlans] = useState<StoragePlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [customLimitGb, setCustomLimitGb] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);

  const fetchQuotas = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setQuotaLoadError(false);
    }
    try {
      const res = await api.get<{
        quotas: StorageQuota[];
        total: number;
        pagination: { hasMore: boolean };
      }>(`/api/admin/storage/quotas?limit=50&offset=${offset}`);
      setQuotas(current => append ? [...current, ...(res.quotas || [])] : (res.quotas || []));
      setQuotaTotal(res.total || 0);
      setQuotasHaveMore(Boolean(res.pagination?.hasMore));
    } catch {
      if (!append) setQuotaLoadError(true);
      toast({ title: "Error", description: "Failed to load quotas", variant: "destructive" });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [toast]);

  useEffect(() => { fetchQuotas(); }, [fetchQuotas]);

  const openUserFiles = async (quota: StorageQuota) => {
    setSelectedUser(quota);
    setUserDetailOpen(true);
    setFilesLoading(true);
    setFilesLoadError(false);
    setFileSelectedIds(new Set());
    setFileCategoryFilter("all");
    try {
      const res = await api.get<{ files: StorageFile[]; total: number; pagination: { hasMore: boolean } }>(
        `/api/admin/storage/users/${quota.userId}/files?limit=50&offset=0`
      );
      setUserFiles(res?.files || []);
      setUserFilesTotal(res?.total || 0);
      setUserFilesHaveMore(Boolean(res?.pagination?.hasMore));
    } catch {
      setFilesLoadError(true);
      toast({ title: "Error", description: "Failed to load files", variant: "destructive" });
    } finally {
      setFilesLoading(false);
    }
  };

  const loadMoreUserFiles = async () => {
    if (!selectedUser || filesLoadingMore || !userFilesHaveMore) return;
    setFilesLoadingMore(true);
    try {
      const res = await api.get<{ files: StorageFile[]; total: number; pagination: { hasMore: boolean } }>(
        `/api/admin/storage/users/${selectedUser.userId}/files?limit=50&offset=${userFiles.length}`
      );
      setUserFiles(current => [...current, ...(res.files || [])]);
      setUserFilesTotal(res.total || 0);
      setUserFilesHaveMore(Boolean(res.pagination?.hasMore));
    } catch {
      toast({ title: "Error", description: "Failed to load more files", variant: "destructive" });
    } finally {
      setFilesLoadingMore(false);
    }
  };

  const openSettings = async (quota: StorageQuota) => {
    setSettingsUser(quota);
    setSelectedPlanId(quota.planId ? String(quota.planId) : "");
    setCustomLimitGb("");
    setSettingsOpen(true);

    try {
      const res = await api.get<StoragePlan[]>("/api/admin/storage/plans");
      setPlans(res || []);
    } catch {
      toast({ title: "Storage plans unavailable", description: "Plan settings cannot be changed until plans load successfully.", variant: "destructive" });
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsUser) return;
    setSavingSettings(true);
    try {
      if (selectedPlanId) {
        await api.put(`/api/admin/storage/users/${settingsUser.userId}/plan`, {
          planId: parseInt(selectedPlanId),
        });
      }
      if (customLimitGb) {
        await api.put(`/api/admin/storage/users/${settingsUser.userId}/limit`, {
          maxStorageBytes: Math.round(parseFloat(customLimitGb) * 1024 * 1024 * 1024),
        });
      }
      toast({ title: "Updated", description: "User storage settings updated" });
      setSettingsOpen(false);
      await fetchQuotas();
    } catch (err: unknown) {
      toast({ title: "Error", description: (err instanceof Error ? err.message : null) || "Failed to update", variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRecalculate = async (userId: number) => {
    try {
      await api.post(`/api/admin/storage/users/${userId}/recalculate`);
      toast({ title: "Recalculated", description: "Storage usage recalculated" });
      await fetchQuotas();
    } catch {
      toast({ title: "Error", description: "Failed to recalculate", variant: "destructive" });
    }
  };

  const handleDeleteFile = async (fileId: number) => {
    if (!selectedUser) return;
    try {
      await api.delete(`/api/admin/storage/users/${selectedUser.userId}/files/${fileId}`);
      toast({ title: "Deleted", description: "File deleted" });
      setUserFiles((prev) => prev.filter((f) => f.id !== fileId));
      setFileSelectedIds((prev) => { const n = new Set(prev); n.delete(fileId); return n; });
      setUserFilesTotal(total => Math.max(0, total - 1));
    } catch {
      toast({ title: "Error", description: "Failed to delete file", variant: "destructive" });
    }
  };

  const handleBulkDeleteFiles = async () => {
    if (!selectedUser || fileSelectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const res = await api.post<{ success: boolean; deletedCount: number }>(
        `/api/admin/storage/users/${selectedUser.userId}/files/bulk-delete`,
        { fileIds: Array.from(fileSelectedIds) }
      );
      if (res.success) {
        toast({ title: "Deleted", description: `${res.deletedCount} file(s) deleted` });
        setUserFiles((prev) => prev.filter((f) => !fileSelectedIds.has(f.id)));
        setFileSelectedIds(new Set());
        setUserFilesTotal(total => Math.max(0, total - res.deletedCount));
        fetchQuotas();
      }
    } catch {
      toast({ title: "Error", description: "Failed to delete files", variant: "destructive" });
    } finally {
      setBulkDeleting(false);
    }
  };

  const confirmDelete = async () => {
    const ids = pendingDeleteIds;
    setPendingDeleteIds([]);
    if (ids.length === 1) await handleDeleteFile(ids[0]);
    else if (ids.length > 1) await handleBulkDeleteFiles();
  };

  const displayedFiles = fileCategoryFilter === "all"
    ? userFiles
    : userFiles.filter((f) => f.category === fileCategoryFilter);

  const fileCategories = Array.from(new Set(userFiles.map((f) => f.category)));

  const toggleFileSelect = (id: number) => {
    setFileSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFileSelectAll = () => {
    if (fileSelectedIds.size === displayedFiles.length && displayedFiles.length > 0) {
      setFileSelectedIds(new Set());
    } else {
      setFileSelectedIds(new Set(displayedFiles.map((f) => f.id)));
    }
  };

  const filtered = quotas.filter((q) =>
    q.email?.toLowerCase().includes(searchTerm.toLowerCase()) || String(q.userId).includes(searchTerm)
  );

  if (loading) {
    return <LoadingState size="page" label="Loading user storage…" />;
  }

  if (quotaLoadError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <HardDrive className="h-10 w-10 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold">User storage could not be loaded</h1>
          <p className="mt-1 text-sm text-muted-foreground">Check the server connection and try again.</p>
        </div>
        <Button variant="outline" onClick={() => void fetchQuotas()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderOpen className="w-6 h-6 text-purple-600" />
            User Storage
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage storage quotas and browse user files
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchQuotas()}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Search */}
      <SearchInput
        aria-label="Search users by email or user ID"
        placeholder="Search by email or user ID..."
        value={searchTerm}
        onValueChange={setSearchTerm}
        wrapperClassName="max-w-md"
      />

      {/* Quotas Table */}
      <Card>
        <CardHeader>
          <CardTitle>User Quotas ({quotaTotal})</CardTitle>
          <CardDescription>Storage allocation and usage per user</CardDescription>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <HardDrive className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>No storage quotas found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Used / Limit</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((q) => {
                  const maxBytes = Number(q.maxStorageBytes) || 1073741824;
                  const usedBytes = Number(q.storageUsedBytes);
                  const percent = Math.min(Math.round((usedBytes / maxBytes) * 100), 100);
                  return (
                    <TableRow key={q.userId}>
                      <TableCell>
                        <div className="font-medium">{q.email}</div>
                        <div className="text-xs text-muted-foreground">ID: {q.userId}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{q.planName || "Free"}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatBytes(usedBytes)} / {formatBytes(maxBytes)}
                      </TableCell>
                      <TableCell>{q.fileCount}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={percent} className="h-2 w-20" />
                          <span className="text-xs text-muted-foreground">{percent}%</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openUserFiles(q)} title="View files">
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openSettings(q)} title="Settings">
                            <Settings className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleRecalculate(q.userId)} title="Recalculate">
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
          {quotasHaveMore && !searchTerm && (
            <div className="flex justify-center border-t p-4">
              <Button variant="outline" onClick={() => void fetchQuotas(quotas.length, true)} loading={loadingMore}>
                Load more users
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Files Dialog */}
      <Dialog open={userDetailOpen} onOpenChange={setUserDetailOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Files — {selectedUser?.email}</DialogTitle>
            <DialogDescription>
              {formatBytes(Number(selectedUser?.storageUsedBytes ?? 0))} used of{" "}
              {formatBytes(Number(selectedUser?.maxStorageBytes ?? 0))}
            </DialogDescription>
          </DialogHeader>

          {/* Toolbar: category filter + bulk delete */}
          {!filesLoading && userFiles.length > 0 && (
            <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <Select value={fileCategoryFilter} onValueChange={(v) => { setFileCategoryFilter(v); setFileSelectedIds(new Set()); }}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {fileCategories.map((cat) => (
                    <SelectItem key={cat} value={cat} className="capitalize">
                      {cat.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fileSelectedIds.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPendingDeleteIds(Array.from(fileSelectedIds))}
                  loading={bulkDeleting}
                  loadingText="Deleting…"
                >
                  <Trash2 />
                  Delete {fileSelectedIds.size} selected
                </Button>
              )}
            </div>
          )}
          {filesLoading ? (
            <LoadingState label="Loading files…" />
          ) : filesLoadError ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">Files could not be loaded.</p>
              {selectedUser && <Button variant="outline" size="sm" onClick={() => void openUserFiles(selectedUser)}>Try again</Button>}
            </div>
          ) : displayedFiles.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">No files found</div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={displayedFiles.length > 0 && fileSelectedIds.size === displayedFiles.length}
                      onCheckedChange={toggleFileSelectAll}
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedFiles.map((file) => (
                  <TableRow key={file.id} className={fileSelectedIds.has(file.id) ? "bg-purple-50/50 dark:bg-purple-950/20" : ""}>
                    <TableCell>
                      <Checkbox
                        checked={fileSelectedIds.has(file.id)}
                        onCheckedChange={() => toggleFileSelect(file.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm truncate max-w-[200px]">{file.originalName || file.fileName}</div>
                      {file.mimeType && <div className="text-xs text-muted-foreground">{file.mimeType}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{file.category.replace(/_/g, " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{formatBytes(Number(file.fileSizeBytes))}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(file.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingDeleteIds([file.id])}
                        className="text-red-600 hover:text-red-700"
                        aria-label={`Delete ${file.originalName || file.fileName}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          {userFilesHaveMore && !filesLoading && (
            <div className="flex justify-center border-t pt-4">
              <Button variant="outline" size="sm" onClick={() => void loadMoreUserFiles()} loading={filesLoadingMore}>
                Load more ({Math.max(0, userFilesTotal - userFiles.length)} remaining)
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDeleteIds.length > 0} onOpenChange={(open) => { if (!open && !bulkDeleting) setPendingDeleteIds([]); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDeleteIds.length === 1 ? "this file" : `${pendingDeleteIds.length} files`}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected storage objects and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDeleting}
              onClick={(event) => { event.preventDefault(); void confirmDelete(); }}
            >
              {bulkDeleting ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Storage Settings — {settingsUser?.email}</DialogTitle>
            <DialogDescription>Change plan or set a custom storage limit</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Storage Plan</Label>
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name} ({formatBytes(Number(p.maxStorageBytes))})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Custom Limit Override (GB)</Label>
              <Input
                type="number"
                value={customLimitGb}
                onChange={(e) => setCustomLimitGb(e.target.value)}
                placeholder="Leave empty to use plan limit"
                min="0.1"
                step="0.1"
              />
              <p className="text-xs text-muted-foreground">Overrides the plan&apos;s default limit for this user</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveSettings} loading={savingSettings} className="bg-purple-600 hover:bg-purple-700">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
