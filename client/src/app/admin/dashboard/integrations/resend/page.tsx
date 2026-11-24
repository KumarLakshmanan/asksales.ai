"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  ArrowLeft,
  Send,
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  CheckCircle,
  Save,
  Webhook,
} from "lucide-react";
import { api, buildApiUrl } from "@/lib/admin-api";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { PageErrorState } from "@/components/ui/page-state";

interface ResendCredential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string | null;
  isActive: boolean;
  priority: string;
  config?: {
    webhookSecret?: string;
  };
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  createdAt: string;
}

export default function ResendIntegrationPage() {
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<ResendCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formName, setFormName] = useState("Resend API Key");
  const [formApiKey, setFormApiKey] = useState("");
  const [formWebhookSecret, setFormWebhookSecret] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editWebhookSecret, setEditWebhookSecret] = useState("");
  const [showEditKey, setShowEditKey] = useState(false);

  const webhookUrl = typeof window !== "undefined"
    ? `${new URL(buildApiUrl("/api/resend/webhook")).href}`
    : "";

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<{ credentials?: ResendCredential[] }>("/api/admin/integrations?platform=resend");
      setCredentials(data.credentials || []);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Failed to fetch Resend settings");
      toast({ title: "Error", description: "Failed to fetch Resend settings", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggle = async (id: number) => {
    try {
      await api.post(`/api/admin/integrations/${id}/toggle`);
      toast({ title: "Success", description: "Resend settings status updated" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to toggle settings", variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "Resend settings deleted" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to delete settings", variant: "destructive" });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null });
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formApiKey.trim()) {
      toast({ title: "Error", description: "Resend API key is required", variant: "destructive" });
      return;
    }
    try {
      setSubmitting(true);
      await api.post("/api/admin/integrations", {
        platform: "resend",
        name: formName.trim() || "Resend API Key",
        apiKey: formApiKey.trim(),
        config: formWebhookSecret.trim() ? { webhookSecret: formWebhookSecret.trim() } : {},
      });
      toast({ title: "Success", description: "Resend API key added successfully" });
      setFormName("Resend API Key");
      setFormApiKey("");
      setFormWebhookSecret("");
      setShowAddForm(false);
      fetchData();
    } catch (error: unknown) {
      toast({ title: "Error", description: (error as Error).message || "Failed to add Resend key", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = async (id: number) => {
    try {
      const data = await api.get<{ credential?: ResendCredential }>(`/api/admin/integrations/${id}/full`);
      const cred = (data.credential || data) as ResendCredential;
      setEditingId(id);
      setEditName(cred.name || "");
      setEditApiKey("");
      setEditWebhookSecret("");
    } catch {
      toast({ title: "Error", description: "Failed to load credential for editing", variant: "destructive" });
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    try {
      setSubmitting(true);
      await api.put(`/api/admin/integrations/${editingId}`, {
        name: editName.trim() || "Resend API Key",
        ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
        config: editWebhookSecret.trim() ? { webhookSecret: editWebhookSecret.trim() } : {},
      });
      toast({ title: "Success", description: "Resend settings updated" });
      setEditingId(null);
      fetchData();
    } catch (error: unknown) {
      toast({ title: "Error", description: (error as Error).message || "Failed to update", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" label="Loading Resend settings…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Resend settings could not be loaded" description={loadError} reset={() => void fetchData()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2 sm:gap-4">
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link href="/admin/dashboard/integrations" aria-label="Back to integrations">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0 rounded-lg bg-emerald-600 p-3 text-white dark:bg-emerald-500 dark:text-emerald-950">
              <Send className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-black tracking-tighter sm:text-2xl">Resend</h1>
              <p className="text-sm text-muted-foreground sm:text-base">
                Manage the system-wide Resend API key for custom domain email sending
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button onClick={fetchData} variant="outline" size="icon" aria-label="Refresh Resend credentials">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <Plus className="h-4 w-4 mr-2" />Add API Key
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="flex flex-wrap gap-2">
        {["Custom Domain", "Email Outreach", "Domain Verification", "Webhook Events"].map((feature) => (
          <Badge key={feature} variant="secondary">{feature}</Badge>
        ))}
      </div>

      {/* Info */}
      <Callout tone="info" icon={Send} title="Resend API Key">
        This API key is used system-wide for all users&apos; custom domain email outreach. Users configure
        their sending domain in their own integration settings; this admin key powers the Resend API calls.
      </Callout>

      {/* Add Form */}
      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Resend API Key</CardTitle>
            <CardDescription>Enter your Resend API key from resend.com/api-keys</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="addName">Name</Label>
                <Input id="addName" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Resend API Key" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addApiKey">API Key</Label>
                <div className="relative">
                  <Input
                    id="addApiKey"
                    type={showApiKey ? "text" : "password"}
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    placeholder="re_xxxxxxxxxxxx"
                    className="pr-12"
                  />
                  <Button type="button" variant="ghost" className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0" onClick={() => setShowApiKey(!showApiKey)}>
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="addWebhookSecret">Webhook Signing Secret (optional)</Label>
                <Input id="addWebhookSecret" value={formWebhookSecret} onChange={(e) => setFormWebhookSecret(e.target.value)} placeholder="whsec_xxxxxxxxxxxx" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" loading={submitting} loadingText="Saving…">
                  <Save className="h-4 w-4" />
                  Save
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Credentials List */}
      <Card>
        <CardHeader>
          <CardTitle>Resend API Keys</CardTitle>
          <CardDescription>System-wide Resend credentials. The active key is used for all domain operations.</CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 && !showAddForm ? (
            <div className="text-center py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Resend API Key Configured</h3>
              <p className="text-muted-foreground mb-4">Add a Resend API key to enable custom domain email outreach.</p>
              <Button onClick={() => setShowAddForm(true)}>
                <Plus className="h-4 w-4 mr-2" />Add API Key
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {credentials.map((credential) => (
                <div key={credential.id} className="border rounded-lg p-4 space-y-3">
                  {editingId === credential.id ? (
                    <form onSubmit={handleUpdate} className="space-y-3">
                      <div className="space-y-2">
                        <Label>Name</Label>
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>API Key</Label>
                        <div className="relative">
                          <Input
                            type={showEditKey ? "text" : "password"}
                            value={editApiKey}
                            onChange={(e) => setEditApiKey(e.target.value)}
                            className="pr-12"
                          />
                          <Button type="button" variant="ghost" className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0" onClick={() => setShowEditKey(!showEditKey)}>
                            {showEditKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Rotate Webhook Secret (optional)</Label>
                        <Input value={editWebhookSecret} onChange={(e) => setEditWebhookSecret(e.target.value)} placeholder="Leave blank to keep the current secret" />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" loading={submitting} loadingText="Updating…" size="sm">
                          <Save className="h-4 w-4" />
                          Update
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-4 sm:items-center">
                        <Switch
                          checked={credential.isActive}
                          onCheckedChange={() => handleToggle(credential.id)}
                          aria-label={`${credential.isActive ? "Deactivate" : "Activate"} ${credential.name}`}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{credential.name}</span>
                            <Badge variant={credential.isActive ? "default" : "secondary"}>
                              {credential.isActive ? "Active" : "Inactive"}
                            </Badge>
                          </div>
                          <p className="break-words text-sm text-muted-foreground">
                            API Key: {credential.apiKey}
                            {credential.config?.webhookSecret && " • Webhook secret configured"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-auto">
                        {credential.isActive && <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="Active" />}
                        <Button variant="outline" size="sm" onClick={() => startEdit(credential.id)} aria-label={`Edit ${credential.name}`}>
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeleteConfirm({ open: true, id: credential.id })}
                          loading={deletingId === credential.id}
                          loadingText={null}
                          aria-label={`Delete ${credential.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <Webhook className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <CardTitle>Webhook Settings</CardTitle>
              <CardDescription>
                Configure Resend to send delivery events to this endpoint for email tracking (opens, clicks, bounces, etc.)
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Webhook Endpoint URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={webhookUrl} readOnly className="min-w-0 font-mono text-sm bg-muted" />
              <CopyButton
                value={webhookUrl}
                iconOnly
                label="Copy Resend webhook endpoint"
                className="shrink-0"
                title="Copy webhook URL"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Supported Events</Label>
            <div className="flex flex-wrap gap-2">
              {["email.sent", "email.delivered", "email.bounced", "email.complained", "email.opened", "email.clicked", "domain.updated"].map((evt) => (
                <Badge key={evt} variant="outline" className="font-mono text-xs">{evt}</Badge>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground space-y-1">
            <p><strong>Setup:</strong> Go to <a href="https://resend.com/webhooks" target="_blank" rel="noopener noreferrer" className="underline font-medium">resend.com/webhooks</a> → Add Endpoint → paste the URL above.</p>
            <p>Select the events you want to track and save. The signing secret (whsec_) should be configured in the API key settings above.</p>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title="Delete Resend API Key"
        description="Are you sure you want to delete this Resend API key? Users will not be able to send emails via Resend until a new key is configured."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
      />
    </div>
  );
}
