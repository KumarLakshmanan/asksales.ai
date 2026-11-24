"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  ArrowUpCircle,
  CreditCard,
  Clock,
  Wallet,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Transaction {
  id: number;
  type: string;
  amount: string;
  balanceAfter: string;
  description: string | null;
  category: string | null;
  referenceType: string | null;
  referenceId: string | null;
  paymentProvider: string | null;
  paymentId: string | null;
  paymentOrderId: string | null;
  amountPaid: string | null;
  currency: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
  total: number;
}

function formatPaymentAmount(amount: string, currency: string | null) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency || "INR"} ${value.toLocaleString()}`;
  }
}

export default function RechargeHistory() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading, isError, refetch } = useQuery<TransactionsResponse>({
    queryKey: ["wallet-recharge-history", billingScopeKey, page],
    queryFn: () =>
      api.get<TransactionsResponse>(
        `/api/wallet/transactions?type=recharge&limit=${limit}&offset=${page * limit}`
      ),
  });

  const transactions = useMemo(() => data?.transactions || [], [data]);
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const filtered = useMemo(() => {
    if (!search) return transactions;
    const q = search.toLowerCase();
    return transactions.filter(
      (t) =>
        t.description?.toLowerCase().includes(q) ||
        t.paymentId?.toLowerCase().includes(q) ||
        t.paymentOrderId?.toLowerCase().includes(q)
    );
  }, [transactions, search]);

  const totalRecharged = useMemo(
    () => filtered.reduce((s, t) => s + parseFloat(t.amount || "0"), 0),
    [filtered]
  );

  if (isLoading && page === 0) {
    return (
      <LoadingState size="section" className="py-16" label="Loading recharge history…" />
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm font-medium">Recharge history could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-emerald-500/20 bg-emerald-500/10">
          <CardContent className="pt-4 pb-3">
            <div className="mb-1 flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <ArrowUpCircle className="w-4 h-4" />
              <span className="text-xs font-medium uppercase">Total Recharged (page)</span>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-foreground">{totalRecharged.toLocaleString()} credits</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="mb-1 flex items-center gap-2 text-primary">
              <CreditCard className="w-4 h-4" />
              <span className="text-xs font-medium uppercase text-muted-foreground">Total Transactions</span>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-primary">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 flex items-center justify-between">
            <div>
              <div className="mb-1 flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <Wallet className="w-4 h-4" />
                <span className="text-xs font-medium uppercase text-muted-foreground">Buy More</span>
              </div>
              <p className="text-sm text-muted-foreground">Top up your wallet</p>
            </div>
            <Button
              size="sm"
              onClick={() => router.push("/dashboard/billing/recharge")}
            >
              Recharge
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <SearchInput
        placeholder="Filter this page by description or payment ID..."
        aria-label="Filter recharge history"
        value={search}
        onValueChange={setSearch}
        size="sm"
        wrapperClassName="max-w-xs"
      />

      {/* Transactions Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-purple-600" /> Recharge History
          </CardTitle>
          <CardDescription className="text-xs">All wallet recharges</CardDescription>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CreditCard className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">No recharges found</p>
              <p className="text-xs mt-1">
                {search ? "Try a different search term" : "Recharge your wallet to see transactions here."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[880px]">
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs font-semibold">Date</TableHead>
                    <TableHead className="text-xs font-semibold">Description</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Amount Paid</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Credits Added</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Balance After</TableHead>
                    <TableHead className="text-xs font-semibold">Payment ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {new Date(tx.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                        <span className="block text-xs text-muted-foreground">
                          {new Date(tx.createdAt).toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm max-w-[200px] truncate">
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                          {tx.description || "Wallet Recharge"}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-right font-medium">
                        {tx.amountPaid ? (
                          formatPaymentAmount(tx.amountPaid, tx.currency)
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                        +{parseFloat(tx.amount).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {parseFloat(tx.balanceAfter).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {tx.paymentId ? (
                          <Badge variant="outline" className="font-mono text-xs">
                            {tx.paymentId.length > 20 ? `${tx.paymentId.slice(0, 20)}...` : tx.paymentId}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination
              className="mt-4"
              page={page + 1}
              pageSize={limit}
              totalItems={total}
              onPageChange={(next) => setPage(next - 1)}
              itemLabel="recharges"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
