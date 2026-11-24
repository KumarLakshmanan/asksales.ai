"use client";

import Link from "next/link";
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import api, { ApiError } from "@/lib/admin-api";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import AdminPlanAssignment from "@/components/admin/AdminPlanAssignment";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  CreditCard,
  RefreshCw,
  Plus,
  Wallet,
} from "lucide-react";

interface UserWallet {
  id: number;
  userId: number;
  organizationId?: number;
  organizationName?: string;
  balance: number;
  totalCreditsAdded: number;
  totalCreditsUsed: number;
  createdAt: string;
  userName?: string | null;
  userEmail?: string | null;
}

interface WalletResponse {
  items: UserWallet[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { totalWallets: number; totalBalance: number; totalCreditsAdded: number };
}

const EMPTY_SUMMARY = { totalWallets: 0, totalBalance: 0, totalCreditsAdded: 0 };

function formatCredits(value: number) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value || 0);
}

export default function WalletsPage() {
  const { toast } = useToast();
  const { admin, isLoading: adminLoading } = useAdminAuth();
  const billingAuthority = !adminLoading && admin?.role === "super_admin" ? admin.id : null;
  const canManageBilling = billingAuthority !== null;
  const billingAuthorityRef = useRef(billingAuthority);
  const creditFormRef = useRef<symbol | null>(null);
  const creditSubmissionRef = useRef(false);
  const [creditFormToken, setCreditFormToken] = useState<symbol | null>(null);
  const [wallets, setWallets] = useState<UserWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addCreditsOpen, setAddCreditsOpen] = useState(false);
  const [planOrganizationId, setPlanOrganizationId] = useState<number | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [creditsAmount, setCreditsAmount] = useState("");
  const [creditsReason, setCreditsReason] = useState("");
  const [addingCredits, setAddingCredits] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const [summary, setSummary] = useState(EMPTY_SUMMARY);

  // A verified role/account change invalidates every earlier billing form.
  useLayoutEffect(() => {
    billingAuthorityRef.current = billingAuthority;
    creditFormRef.current = null;
    creditSubmissionRef.current = false;
    setCreditFormToken(null);
    setAddCreditsOpen(false);
    setPlanOrganizationId(null);
    setSelectedUserId(null);
    setCreditsAmount("");
    setCreditsReason("");
    setAddingCredits(false);
    return () => { billingAuthorityRef.current = null; creditFormRef.current = null; };
  }, [billingAuthority]);

  const closeCreditForm = () => {
    creditFormRef.current = null;
    creditSubmissionRef.current = false;
    setCreditFormToken(null);
    setAddCreditsOpen(false);
    setSelectedUserId(null);
    setCreditsAmount("");
    setCreditsReason("");
    setAddingCredits(false);
  };

  const fetchWallets = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) query.set("search", search);
      const res = await api.get<WalletResponse>(`/api/admin/wallets?${query.toString()}`);
      setWallets(res?.items || []);
      if (res) {
        setPagination(res.pagination);
        setSummary(res.summary);
        if (res.pagination.page !== page) setPage(res.pagination.page);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load wallets";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, search, toast]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const handleAddCredits = async () => {
    const authority = billingAuthority;
    const token = creditFormToken;
    if (authority === null || billingAuthorityRef.current !== authority || !token
      || creditFormRef.current !== token || creditSubmissionRef.current) return;
    const isCurrentForm = () => billingAuthorityRef.current === authority && creditFormRef.current === token;
    const amount = Number(creditsAmount);
    const reason = creditsReason.trim();
    if (!selectedUserId || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 || reason.length < 3) {
      toast({ title: "Check the adjustment", description: "Enter 1–1,000,000 credits and a reason of at least 3 characters.", variant: "destructive" });
      return;
    }
    creditSubmissionRef.current = true;
    setAddingCredits(true);
    try {
      await api.post(`/api/admin/wallets/${selectedUserId}/add-credits`, {
        amount,
        reason,
      });
      if (!isCurrentForm()) return;
      toast({ title: "Credits Added", description: `${creditsAmount} credits added successfully.` });
      closeCreditForm();
      await fetchWallets();
    } catch (error) {
      if (isCurrentForm()) toast({ title: "Credit adjustment failed", description: error instanceof ApiError ? error.message : "Failed to add credits", variant: "destructive" });
    } finally {
      if (isCurrentForm()) { creditSubmissionRef.current = false; setAddingCredits(false); }
    }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />
            Billing account wallets
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            View each user’s billing account wallet{canManageBilling ? " and manage its plan" : ""}.
          </p>
        </div>
        <Button variant="outline" onClick={fetchWallets} disabled={loading} className="gap-2 self-start sm:self-auto">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {canManageBilling ? <p className="text-sm text-muted-foreground">For an account without a wallet, or to edit the plan catalog, open <Link href="/admin/dashboard/settings/subscriptions?tab=organizations" className="text-primary underline underline-offset-4">Subscription billing</Link>.</p>
        : <p role="status" className="text-sm text-muted-foreground">{adminLoading ? "Checking billing management permissions…" : "Read-only billing access. A super administrator can add credits or manage plans."}</p>}

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Wallets could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchWallets()}>Try again</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Summary */}
      {!loadError && <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Billing account wallets</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{summary.totalWallets.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Outstanding Balance</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight text-primary">{formatCredits(summary.totalBalance)} credits</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Credits Distributed</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
              {formatCredits(summary.totalCreditsAdded)}
            </p>
          </CardContent>
        </Card>
      </div>}

      {/* Wallets Table */}
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>Billing account wallets</CardTitle>
            <CardDescription className="mt-1">Search users and review lifetime balances.</CardDescription>
          </div>
          <SearchInput
            value={searchInput}
            onValueChange={setSearchInput}
            placeholder="Search name or email"
            aria-label="Search user wallets"
            wrapperClassName="w-full sm:w-72"
          />
        </CardHeader>
        <CardContent>
          {loadError ? null : loading ? (
            <LoadingState size="section" label="Loading wallets…" />
          ) : wallets.length === 0 ? (
            <div className="text-center py-12">
              <Wallet className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">{search ? "No matching wallets" : "No wallets found"}</p>
              <p className="text-sm text-muted-foreground">{search ? "Try another name or email address." : "Wallets are created when users first use a credit-consuming feature."}</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Total Added</TableHead>
                  <TableHead className="text-right">Total Used</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      <div>
                        <p className="mb-1 text-sm font-medium">{w.organizationName || "Billing account"}{w.organizationId ? ` · #${w.organizationId}` : ""}</p>
                        <p className="font-medium">{w.userName || `User #${w.userId}`}</p>
                        {w.userEmail && <p className="text-xs text-muted-foreground">{w.userEmail}</p>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {formatCredits(w.balance)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-emerald-700 dark:text-emerald-400">
                      +{formatCredits(w.totalCreditsAdded)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-destructive">
                      -{formatCredits(w.totalCreditsUsed)}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {new Date(w.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-center">
                      {canManageBilling ? <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (billingAuthority === null || billingAuthorityRef.current !== billingAuthority) return;
                            const token = Symbol("wallet-credit-form");
                            creditFormRef.current = token;
                            setCreditFormToken(token);
                            setSelectedUserId(w.userId);
                            setAddCreditsOpen(true);
                          }}
                          className="gap-1"
                        >
                          <Plus className="w-3 h-3" /> Add Credits
                        </Button>
                        <Button variant="outline" size="sm" disabled={!w.organizationId}
                          onClick={() => { if (billingAuthority !== null && billingAuthorityRef.current === billingAuthority) setPlanOrganizationId(w.organizationId ?? null); }}>
                          Manage Plan
                        </Button>
                      </div> : <span className="text-xs text-muted-foreground">Read only</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table></div>
          )}
          {!loading && pagination.totalPages > 1 && (
            <Pagination
              className="mt-4 border-t pt-4"
              page={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.total}
              onPageChange={setPage}
              itemLabel="results"
            />
          )}
        </CardContent>
      </Card>

      {/* Add Credits Dialog */}
      {canManageBilling && <Dialog open={addCreditsOpen} onOpenChange={(open) => { if (!open) closeCreditForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add credits to billing account</DialogTitle>
            <DialogDescription>
              Add credits to the billing account owned by user #{selectedUserId}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="credit-amount">Credits amount</Label>
              <Input
                id="credit-amount"
                type="number"
                placeholder="e.g. 1000"
                value={creditsAmount}
                onChange={(e) => setCreditsAmount(e.target.value)}
                min={1}
                max={1_000_000}
                step="0.01"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="credit-reason">Reason</Label>
              <Textarea
                id="credit-reason"
                placeholder="e.g. Welcome bonus, compensation, etc."
                value={creditsReason}
                onChange={(e) => setCreditsReason(e.target.value)}
                maxLength={500}
                required
              />
              <p className="text-xs text-muted-foreground">Required for the adjustment audit trail.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreditForm}>
              Cancel
            </Button>
            <Button
              onClick={handleAddCredits}
              loading={addingCredits}
              loadingText="Add Credits"
              disabled={!creditsAmount || creditsReason.trim().length < 3}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              Add Credits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>}
      {canManageBilling && <Dialog open={planOrganizationId !== null} onOpenChange={(open) => { if (!open) setPlanOrganizationId(null); }}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage account plan</DialogTitle>
            <DialogDescription>Assign, upgrade, downgrade, schedule, or end a complimentary plan for this user’s billing account.</DialogDescription>
          </DialogHeader>
          <AdminPlanAssignment organizationId={planOrganizationId} onChanged={fetchWallets} />
        </DialogContent>
      </Dialog>}
    </div>
  );
}
