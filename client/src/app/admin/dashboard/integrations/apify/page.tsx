"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  ArrowLeft,
  Key,
  Plus,
  Trash2,
  Edit,
  Play,
  Clock,
  Zap,
  AlertTriangle,
  Server,
  Link2,
  DollarSign,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { type AdminProviderCredential as Credential } from "../credential-types";

interface Actor {
  id: string;
  name: string;
  description?: string;
}

interface ApifyBalance {
  id: number;
  name: string;
  username?: string;
  plan?: string;
  dollarRemaining?: number;
  totalMonthUsageUsd?: number;
  monthlyChargeUsd?: number;
  error?: string;
}

const deactivationLabels: Record<string, string> = {
  billing_or_account_capacity: "Apify billing or account limit",
  manual: "Turned off by an admin",
};
function deactivationLabel(reason: string) {
  return deactivationLabels[reason] || reason;
}

export default function ApifyIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [balances, setBalances] = useState<ApifyBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<{ credentials?: Credential[]; data?: Credential[] }>("/api/admin/integrations?platform=apify");
      const creds = data.credentials || data.data || [];
      setCredentials(creds);
    } catch {
      toast({ title: "Error", description: "Failed to fetch credentials", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchBalances = useCallback(async () => {
    try {
      setLoadingBalances(true);
      const data = await api.get<{ balances?: ApifyBalance[] }>("/api/admin/integrations/apify/balance");
      setBalances(data.balances || []);
    } catch {
      // Balance fetch errors are non-critical
    } finally {
      setLoadingBalances(false);
    }
  }, []);

  const fetchActors = useCallback(async () => {
    try {
      const data = await api.get<{ actors?: Actor[] }>("/api/admin/leadflow/actors");
      setActors(data.actors || []);
    } catch {
      // Actors are optional, don't show error
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchActors();
    fetchBalances();
  }, [fetchData, fetchActors, fetchBalances]);

  const handleToggle = async (id: number) => {
    try {
      await api.post(`/api/admin/integrations/${id}/toggle`);
      toast({ title: "Success", description: "API key status updated" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to toggle API key", variant: "destructive" });
    }
  };

  const handleTest = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<{ test?: { success: boolean; message?: string }; success?: boolean; message?: string }>(`/api/admin/integrations/${id}/test`);
      const test = data.test || data;
      toast({
        title: test.success ? "Connection Successful" : "Connection Failed",
        description: test.message || (test.success ? "Connection test passed" : "Test failed"),
        variant: test.success ? undefined : "destructive",
      });
    } catch (error: unknown) {
      toast({ title: "Test Failed", description: (error as Error).message || "Failed to test", variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "API key deleted" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to delete API key", variant: "destructive" });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null });
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" label="Loading Apify credentials…" />
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2 sm:gap-4">
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link href="/admin/dashboard/integrations" aria-label="Back to integrations"><ArrowLeft className="h-5 w-5" /></Link>
          </Button>
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0 rounded-lg bg-orange-600 p-3 text-white dark:bg-orange-500 dark:text-orange-950"><Server className="h-6 w-6" /></div>
            <div className="min-w-0">
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">Apify</h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">Web scraping and data extraction for lead generation</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button onClick={() => { fetchData(); fetchBalances(); }} variant="outline" size="icon" aria-label="Refresh Apify credentials"><RefreshCw className={`h-4 w-4 ${loadingBalances ? 'animate-spin' : ''}`} /></Button>
          <Button onClick={() => router.push('/admin/dashboard/integrations/apify/add')}><Plus className="h-4 w-4 mr-2" />Add API Key</Button>
        </div>
      </div>

      {/* Features */}
      <div className="flex flex-wrap gap-2">
        {["Web Scraping", "Lead Generation", "Data Extraction", "Actor Runs"].map((f) => (
          <Badge key={f} variant="secondary">{f}</Badge>
        ))}
      </div>

      {/* Info Card */}
      <Callout tone="info" icon={Link2} title="Actor-Specific Key Assignment">
        You can assign specific API keys to specific actors. When an actor runs, the system will use the assigned key first.
        If the assigned key is expired, has hit its credit limit, or is inactive, the default key will be used automatically.
      </Callout>

      {/* Credentials List */}
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>Manage your Apify API keys. Assign specific keys to actors for targeted usage.</CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <div className="py-10 text-center sm:py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No API Keys Configured</h3>
              <p className="text-muted-foreground mb-4">Add your first Apify API key to enable web scraping.</p>
              <Button onClick={() => router.push('/admin/dashboard/integrations/apify/add')}><Plus className="h-4 w-4 mr-2" />Add API Key</Button>
            </div>
          ) : (
            <div className="space-y-4">
              {credentials.map((credential) => {
                const assignedActors = (credential.config?.assignedActors as string[]) || [];
                const balance = balances.find(b => b.id === credential.id);
                return (
                  <div key={credential.id} className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                      <Switch checked={credential.isActive} onCheckedChange={() => handleToggle(credential.id)} className="mt-1" aria-label={`${credential.isActive ? "Disable" : "Enable"} ${credential.name}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{credential.name}</span>
                          <Badge variant={credential.isActive ? "default" : "secondary"}>{credential.isActive ? "Active" : "Inactive"}</Badge>
                          <Badge variant="outline">{credential.priority}</Badge>
                          {credential.deactivationReason && (
                            <Badge variant="destructive" className="flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />{deactivationLabel(credential.deactivationReason)}
                            </Badge>
                          )}
                        </div>
                        {!credential.isActive && credential.validationStatus === "invalid" && credential.validationMessage && (
                          <p className="mt-2 break-words text-sm text-destructive">{credential.validationMessage}</p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground sm:text-sm">
                          <span className="flex min-w-0 items-center gap-1 break-all"><Key className="h-3 w-3" />{credential.apiKey}</span>
                          {credential.lastUsedAt && (
                            <span className="flex items-center gap-1"><Clock className="h-3 w-3" />Last used: {new Date(credential.lastUsedAt).toLocaleDateString()}</span>
                          )}
                          {credential.usageCount && (
                            <span className="flex items-center gap-1"><Zap className="h-3 w-3" />{credential.usageCount} uses</span>
                          )}
                        </div>
                        {balance && !balance.error && (
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs sm:text-sm">
                            <span className="flex items-center gap-1 text-green-600 font-medium">
                              <DollarSign className="h-3 w-3" />
                              Balance: ${balance.dollarRemaining?.toFixed(2) ?? '0.00'}
                            </span>
                            {balance.plan && (
                              <span className="text-muted-foreground">Plan: {balance.plan}</span>
                            )}
                            {balance.username && (
                              <span className="text-muted-foreground">@{balance.username}</span>
                            )}
                          </div>
                        )}
                        {balance && balance.error && (
                          <div className="text-sm mt-1">
                            <span className="text-muted-foreground italic">Balance unavailable</span>
                          </div>
                        )}
                        {!balance && loadingBalances && (
                          <div className="text-sm mt-1">
                            <span className="text-muted-foreground italic">Loading balance...</span>
                          </div>
                        )}
                        {assignedActors.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            <span className="text-xs text-muted-foreground font-medium">Assigned Actors:</span>
                            {assignedActors.map(a => (
                              <Badge key={a} variant="outline" className="text-xs">{actors.find(ac => ac.id === a)?.name || a}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 self-end sm:self-auto">
                      <Button variant="outline" size="sm" onClick={() => handleTest(credential.id)} loading={testingId === credential.id} loadingText={null} aria-label={`Test ${credential.name}`}>
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => router.push(`/admin/dashboard/integrations/apify/edit/${credential.id}`)} aria-label={`Edit ${credential.name}`}><Edit className="h-4 w-4" /></Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteConfirm({ open: true, id: credential.id })} loading={deletingId === credential.id} loadingText={null} aria-label={`Delete ${credential.name}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title="Delete API Key"
        description="Are you sure you want to delete this API key? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
