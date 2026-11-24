"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Plus,
  Eye,
  Pencil,
  Trash2,
  CheckCircle,
  XCircle,
  Shield,
  MailCheck,
  ClipboardCheck,
  BadgeCheck,
  RotateCcw,
} from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  status?: string;
  isVerified?: boolean;
  isSetupComplete?: boolean;
  isApproved?: boolean;
  createdAt?: string;
  created_at?: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [approvalFilter, setApprovalFilter] = useState("all");
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const { toast } = useToast();

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<User[] | { users?: User[]; data?: User[] }>("/api/admin/users");
      setUsers(Array.isArray(data) ? data : data.users || data.data || []);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load users";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleAction = async (
    userId: number,
    action: "verify" | "approve" | "reject"
  ) => {
    try {
      setActionLoading(userId);
      await api.post(`/api/admin/users/${userId}/${action}`);

      toast({
        title: "Success",
        description: `User ${action}d successfully`,
      });
      fetchUsers();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : `Failed to ${action} user`;
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (userId: number) => {
    try {
      setActionLoading(userId);
      await api.delete(`/api/admin/users/${userId}`);

      toast({ title: "Success", description: "User deleted successfully" });
      fetchUsers();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to delete user";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const filteredUsers = users.filter((user) => {
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch = !query
      || user.name?.toLowerCase().includes(query)
      || user.email?.toLowerCase().includes(query);
    const matchesApproval = approvalFilter === "all"
      || (approvalFilter === "approved" ? Boolean(user.isApproved) : !user.isApproved);
    const matchesVerification = verificationFilter === "all"
      || (verificationFilter === "verified" ? Boolean(user.isVerified) : !user.isVerified);
    return matchesSearch && matchesApproval && matchesVerification;
  });
  const totalPages = Math.ceil(filteredUsers.length / pageSize);
  const visiblePage = Math.min(currentPage, Math.max(totalPages, 1));
  const paginatedUsers = filteredUsers.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);

  if (loading) {
    return <LoadingState size="page" label="Loading users…" />;
  }

  if (loadError) {
    return <PageErrorState title="Users could not be loaded" description={loadError} reset={() => void fetchUsers()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tighter">User Management</h1>
          <p className="text-muted-foreground mt-1">
            Manage all registered users
          </p>
        </div>
        <Link href="/admin/dashboard/users/new">
          <Button className="bg-purple-600 hover:bg-purple-700">
            <Plus className="h-4 w-4 mr-2" />
            Create User
          </Button>
        </Link>
      </div>

      {/* Search and account filters */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
        <SearchInput
          placeholder="Search by name or email…"
          value={searchQuery}
          onValueChange={(value) => { setSearchQuery(value); setCurrentPage(1); }}
          wrapperClassName="flex-1"
          aria-label="Search users by name or email"
        />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select value={approvalFilter} onValueChange={(value) => { setApprovalFilter(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-full sm:w-[165px]" aria-label="Filter by approval status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All approval states</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="pending">Pending approval</SelectItem>
            </SelectContent>
          </Select>
          <Select value={verificationFilter} onValueChange={(value) => { setVerificationFilter(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-full sm:w-[165px]" aria-label="Filter by email verification"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All email states</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="unverified">Unverified</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(searchQuery || approvalFilter !== "all" || verificationFilter !== "all") && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => { setSearchQuery(""); setApprovalFilter("all"); setVerificationFilter("all"); setCurrentPage(1); }}>
            <RotateCcw className="mr-2 h-4 w-4" />Clear
          </Button>
        )}
        <span className="shrink-0 text-sm text-muted-foreground sm:ml-auto">{filteredUsers.length} matching ({users.length} total)</span>
      </div>

      {/* Table */}
      <p className="text-xs text-muted-foreground sm:hidden">
        Swipe horizontally to view verification, onboarding, and account actions.
      </p>
      <div
        className="overflow-x-auto rounded-md border"
        tabIndex={0}
        aria-label="User management table; scroll horizontally to view all columns"
      >
        <Table className="min-w-[920px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Email Verified</TableHead>
              <TableHead>Onboarding</TableHead>
              <TableHead>Approved</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8">
                  <p className="text-muted-foreground">{users.length === 0 ? "No user accounts yet" : "No users match these search and filter settings"}</p>
                </TableCell>
              </TableRow>
            ) : (
              paginatedUsers.map((user) => {
                return (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name || "—"}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      {user.isVerified ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-100 gap-1">
                          <MailCheck className="h-3 w-3" /> Verified
                        </Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-100 gap-1">
                          <XCircle className="h-3 w-3" /> Not Verified
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.isSetupComplete ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-100 gap-1">
                          <ClipboardCheck className="h-3 w-3" /> Completed
                        </Badge>
                      ) : (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-100 gap-1">
                          <ClipboardCheck className="h-3 w-3" /> Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.isApproved ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-100 gap-1">
                          <BadgeCheck className="h-3 w-3" /> Approved
                        </Badge>
                      ) : (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-100 gap-1">
                          <BadgeCheck className="h-3 w-3" /> Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {formatDate(user.createdAt || user.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button asChild variant="ghost" size="icon">
                          <Link href={`/admin/dashboard/users/${user.id}/view`} title="View user workspace" aria-label={`View ${user.name || user.email}`}>
                            <Eye className="h-4 w-4" />
                          </Link>
                        </Button>
                        <Button asChild variant="ghost" size="icon">
                          <Link href={`/admin/dashboard/users/${user.id}/edit`} title="Edit account" aria-label={`Edit ${user.name || user.email}`}>
                            <Pencil className="h-4 w-4" />
                          </Link>
                        </Button>

                        {!user.isVerified && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Verify Email"
                            aria-label={`Verify email for ${user.name || user.email}`}
                            disabled={actionLoading === user.id}
                            onClick={() => handleAction(user.id, "verify")}
                          >
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          </Button>
                        )}
                        {!user.isApproved && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve User"
                            aria-label={`Approve ${user.name || user.email}`}
                            disabled={actionLoading === user.id}
                            onClick={() => handleAction(user.id, "approve")}
                          >
                            <Shield className="h-4 w-4 text-blue-600" />
                          </Button>
                        )}
                        {user.isApproved && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Revoke Approval"
                            aria-label={`Revoke approval for ${user.name || user.email}`}
                            disabled={actionLoading === user.id}
                            onClick={() => handleAction(user.id, "reject")}
                          >
                            <XCircle className="h-4 w-4 text-red-600" />
                          </Button>
                        )}

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              aria-label={`Delete ${user.name || user.email}`}
                              disabled={actionLoading === user.id}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete User</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete{" "}
                                <strong>{user.name || user.email}</strong>? This action
                                cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-red-600 hover:bg-red-700"
                                onClick={() => handleDelete(user.id)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Result range and pagination */}
      <Pagination
        className="border-t border-border pt-4"
        page={visiblePage}
        pageSize={pageSize}
        totalItems={filteredUsers.length}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
        pageSizeOptions={[25, 50, 100]}
        itemLabel="matching users"
      />
    </div>
  );
}
