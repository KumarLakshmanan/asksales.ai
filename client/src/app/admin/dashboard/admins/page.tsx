"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Shield, Lock } from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { PageErrorState } from "@/components/ui/page-state";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface Admin {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt?: string;
  created_at?: string;
}

export default function AdminsPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const { toast } = useToast();
  const { admin: currentAdmin } = useAdminAuth();
  const isSuperAdmin = currentAdmin?.role === "super_admin";

  const fetchAdmins = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<unknown>("/api/admin/admins");
      const list = Array.isArray(data) ? data : (data as Record<string, unknown>).admins || (data as Record<string, unknown>).data || [];
      setAdmins(list as Admin[]);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load admins";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAdmins();
  }, [fetchAdmins]);

  const handleDelete = async (adminId: number) => {
    try {
      setActionLoading(adminId);
      await api.delete(`/api/admin/admins/${adminId}`);

      toast({ title: "Success", description: "Admin deleted successfully" });
      fetchAdmins();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to delete admin";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <LoadingState size="page" label="Loading administrators…" />;
  }

  if (loadError) {
    return <PageErrorState title="Administrators could not be loaded" description={loadError} reset={() => void fetchAdmins()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tighter">Admin Management</h1>
          <p className="text-muted-foreground mt-1">
            {isSuperAdmin ? "Manage administrator accounts" : "View administrator accounts (super-admin access is required for changes)"}
          </p>
        </div>
        {isSuperAdmin ? (
          <Button asChild className="bg-purple-600 hover:bg-purple-700">
            <Link href="/admin/dashboard/admins/new">
            <Plus className="h-4 w-4 mr-2" />
            Create Admin
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled title="Only super admins can create administrator accounts.">
            <Lock className="mr-2 h-4 w-4" />Create Admin · Super admin only
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[680px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <p className="text-muted-foreground">No admins found</p>
                </TableCell>
              </TableRow>
            ) : (
              admins.map((admin) => (
                <TableRow key={admin.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-purple-500" />
                      {admin.name || "—"}
                    </div>
                  </TableCell>
                  <TableCell>{admin.email}</TableCell>
                  <TableCell>
                    <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 hover:bg-purple-100 capitalize">
                      {admin.role || "admin"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {formatDate(admin.createdAt || admin.created_at)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      {isSuperAdmin && currentAdmin?.id !== admin.id && <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete"
                            aria-label={`Delete ${admin.name || admin.email}`}
                            loading={actionLoading === admin.id}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Admin</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete admin{" "}
                              <strong>{admin.name || admin.email}</strong>? This
                              action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-red-600 hover:bg-red-700"
                              onClick={() => handleDelete(admin.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer info */}
      <div className="text-sm text-muted-foreground">
        {admins.length} admin{admins.length !== 1 ? "s" : ""} total
      </div>
    </div>
  );
}
