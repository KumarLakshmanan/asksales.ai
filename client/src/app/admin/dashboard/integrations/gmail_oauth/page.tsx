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
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  ArrowLeft,
  Mail,
  Key,
  Plus,
  Trash2,
  CheckCircle,
  Save,
  Shield,
  Webhook,
  Play,
} from "lucide-react";
import { api, buildApiUrl } from "@/lib/admin-api";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageErrorState } from "@/components/ui/page-state";

interface GmailOAuthCredential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string | null;
  isActive: boolean;
  priority: string;
  config?: {
    redirectUri?: string;
    pubsubTopic?: string;
    webhookSecret?: string;
  };
  lastUsedAt?: string;
  usageCount?: string;
  createdAt: string;
}

export default function GmailOAuthIntegrationPage() {
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<GmailOAuthCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formName, setFormName] = useState("Gmail OAuth Credentials");
  const [formClientId, setFormClientId] = useState("");
  const [formClientSecret, setFormClientSecret] = useState("");
  const [formRedirectUri, setFormRedirectUri] = useState("");
  const [formPubsubTopic, setFormPubsubTopic] = useState("");
  const [formWebhookSecret, setFormWebhookSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editClientId, setEditClientId] = useState("");
  const [editClientSecret, setEditClientSecret] = useState("");
  const [editRedirectUri, setEditRedirectUri] = useState("");
  const [editPubsubTopic, setEditPubsubTopic] = useState("");
  const [editWebhookSecret, setEditWebhookSecret] = useState("");

  const activeCredential = credentials.find(c => c.isActive);
  const webhookSecretConfigured = !!activeCredential?.config?.webhookSecret;

  const webhookUrl = typeof window !== "undefined"
    ? `${new URL(buildApiUrl("/api/gmail/oauth/webhook"), window.location.origin).href}?token=<YOUR_WEBHOOK_SECRET>`
    : "";

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<{ credentials?: GmailOAuthCredential[] }>("/api/admin/integrations?platform=gmail_oauth");
      setCredentials(data.credentials || []);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Failed to fetch Gmail OAuth settings");
      toast({ title: "Error", description: "Failed to fetch Gmail OAuth settings", variant: "destructive" });
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
      toast({ title: "Success", description: "Gmail OAuth settings status updated" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to toggle settings", variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "Gmail OAuth settings deleted" });
      fetchData();
    } catch {
      toast({ title: "Error", description: "Failed to delete settings", variant: "destructive" });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null });
    }
  };

  const handleTest = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<{ test?: { success: boolean; message?: string } }>(`/api/admin/integrations/${id}/test`);
      const test = data.test;
      toast({
        title: test?.success ? "Credential format is valid" : "Credential validation failed",
        description: test?.message || "The provider returned no validation details.",
        variant: test?.success ? undefined : "destructive",
      });
    } catch (error) {
      toast({ title: "Validation failed", description: error instanceof Error ? error.message : "Unable to validate credentials", variant: "destructive" });
    } finally { setTestingId(null); }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formClientId.trim() || !formClientSecret.trim()) {
      toast({ title: "Error", description: "Both Client ID and Client Secret are required", variant: "destructive" });
      return;
    }
    try {
      setSubmitting(true);
      const config: Record<string, string> = {};
      if (formRedirectUri.trim()) config.redirectUri = formRedirectUri.trim();
      if (formPubsubTopic.trim()) config.pubsubTopic = formPubsubTopic.trim();
      if (formWebhookSecret.trim()) config.webhookSecret = formWebhookSecret.trim();

      await api.post("/api/admin/integrations", {
        platform: "gmail_oauth",
        name: formName.trim() || "Gmail OAuth Credentials",
        apiKey: formClientId.trim(),
        apiSecret: formClientSecret.trim(),
        config,
      });
      toast({ title: "Success", description: "Gmail OAuth credentials added successfully" });
      setFormName("Gmail OAuth Credentials");
      setFormClientId("");
      setFormClientSecret("");
      setFormRedirectUri("");
      setFormPubsubTopic("");
      setFormWebhookSecret("");
      setShowAddForm(false);
      fetchData();
    } catch (error: unknown) {
      toast({ title: "Error", description: (error as Error).message || "Failed to add credentials", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = async (id: number) => {
    try {
      const data = await api.get<{ credential?: GmailOAuthCredential }>(`/api/admin/integrations/${id}/full`);
      const cred = (data.credential || data) as GmailOAuthCredential;
      setEditingId(id);
      setEditName(cred.name || "");
      setEditClientId("");
      setEditClientSecret("");
      setEditRedirectUri(cred.config?.redirectUri || "");
      setEditPubsubTopic(cred.config?.pubsubTopic || "");
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
      const config: Record<string, string> = {};
      if (editRedirectUri.trim()) config.redirectUri = editRedirectUri.trim();
      if (editPubsubTopic.trim()) config.pubsubTopic = editPubsubTopic.trim();
      if (editWebhookSecret.trim()) config.webhookSecret = editWebhookSecret.trim();

      await api.put(`/api/admin/integrations/${editingId}`, {
        name: editName.trim() || "Gmail OAuth Credentials",
        ...(editClientId.trim() ? { apiKey: editClientId.trim() } : {}),
        ...(editClientSecret.trim() ? { apiSecret: editClientSecret.trim() } : {}),
        config,
      });
      toast({ title: "Success", description: "Gmail OAuth credentials updated" });
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
      <LoadingState size="page" label="Loading Gmail OAuth settings…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Gmail OAuth settings could not be loaded" description={loadError} reset={() => void fetchData()} />;
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
            <div className="shrink-0 rounded-lg bg-gradient-to-r from-orange-500 to-red-500 p-3 text-white">
              <Mail className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-black tracking-tighter sm:text-2xl">Gmail OAuth</h1>
              <p className="text-sm text-muted-foreground sm:text-base">
                Manage the default Google OAuth credentials for Gmail API integration
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button onClick={fetchData} variant="outline" size="icon" aria-label="Refresh Gmail OAuth credentials">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <Plus className="h-4 w-4 mr-2" />Add Credentials
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="flex flex-wrap gap-2">
        {["Gmail API", "OAuth 2.0", "Push Notifications", "Send & Receive"].map((feature) => (
          <Badge key={feature} variant="secondary">{feature}</Badge>
        ))}
      </div>

      {/* Info */}
      <Callout tone="info" icon={Shield} title="Default OAuth Credentials">
        These are the <strong>default</strong> Google OAuth Client ID and Secret used when users connect their Gmail
        accounts. Users can optionally override with their own credentials. Create these in the{" "}
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">
          Google Cloud Console
        </a>.
      </Callout>

      {/* Add Form */}
      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Gmail OAuth Credentials</CardTitle>
            <CardDescription>Enter your Google Cloud OAuth Client ID and Client Secret</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="addName">Name</Label>
                <Input id="addName" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Gmail OAuth Credentials" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addClientId">Client ID</Label>
                <Input id="addClientId" value={formClientId} onChange={(e) => setFormClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addClientSecret">Client Secret</Label>
                <PasswordInput
                  id="addClientSecret"
                  value={formClientSecret}
                  onChange={(e) => setFormClientSecret(e.target.value)}
                  placeholder="GOCSPX-xxxx"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addRedirectUri">OAuth Redirect URI (optional)</Label>
                <Input id="addRedirectUri" value={formRedirectUri} onChange={(e) => setFormRedirectUri(e.target.value)} placeholder="https://api.yourdomain.com/api/gmail/oauth/callback" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addPubsub">Pub/Sub Topic (optional)</Label>
                <Input id="addPubsub" value={formPubsubTopic} onChange={(e) => setFormPubsubTopic(e.target.value)} placeholder="projects/your-project/topics/gmail-push" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="addWebhookSecret">Webhook Secret (required for inbound push)</Label>
                <PasswordInput 
                  id="addWebhookSecret" 
                  value={formWebhookSecret} 
                  onChange={(e) => setFormWebhookSecret(e.target.value)} 
                  placeholder="Secret token parameter for push authentication" 
                />
              </div>
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Ensure your Google Cloud project has the Gmail API enabled and the OAuth consent screen configured with the correct scopes
                  (<code className="bg-muted px-1 rounded">gmail.send</code>, <code className="bg-muted px-1 rounded">gmail.readonly</code>).
                </AlertDescription>
              </Alert>
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
          <CardTitle>Gmail OAuth Credentials</CardTitle>
          <CardDescription>Default Google OAuth credentials used for Gmail API. The active credential is the default for all users.</CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 && !showAddForm ? (
            <div className="text-center py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Gmail OAuth Credentials</h3>
              <p className="text-muted-foreground mb-4">Add Google OAuth credentials so users can connect their Gmail accounts.</p>
              <Button onClick={() => setShowAddForm(true)}>
                <Plus className="h-4 w-4 mr-2" />Add Credentials
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
                        <Label>Client ID</Label>
                        <Input value={editClientId} onChange={(e) => setEditClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
                      </div>
                      <div className="space-y-2">
                        <Label>Client Secret</Label>
                        <PasswordInput
                          value={editClientSecret}
                          onChange={(e) => setEditClientSecret(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>OAuth Redirect URI (optional)</Label>
                        <Input value={editRedirectUri} onChange={(e) => setEditRedirectUri(e.target.value)} placeholder="https://api.yourdomain.com/api/gmail/oauth/callback" />
                      </div>
                      <div className="space-y-2">
                        <Label>Pub/Sub Topic (optional)</Label>
                        <Input value={editPubsubTopic} onChange={(e) => setEditPubsubTopic(e.target.value)} placeholder="projects/your-project/topics/gmail-push" />
                      </div>
                      <div className="space-y-2">
                        <Label>Rotate Webhook Secret (optional)</Label>
                        <PasswordInput value={editWebhookSecret} onChange={(e) => setEditWebhookSecret(e.target.value)} placeholder="Leave blank to keep the current secret" />
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
                            Client ID: {credential.apiKey}
                            {credential.config?.redirectUri && ` • Redirect: ${credential.config.redirectUri}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-auto">
                        {credential.isActive && <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="Active" />}
                        <Button variant="outline" size="sm" onClick={() => void handleTest(credential.id)} loading={testingId === credential.id} loadingText="Validating…" aria-label={`Validate ${credential.name}`}>
                          <Play className="h-4 w-4" />
                          Validate
                        </Button>
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

      {/* Pub/Sub Webhook Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <Webhook className="mt-0.5 h-5 w-5 shrink-0 text-orange-600 dark:text-orange-400" />
            <div>
              <CardTitle>Pub/Sub Webhook Settings</CardTitle>
              <CardDescription>
                Configure Google Cloud Pub/Sub to push Gmail notifications to this endpoint for real-time email syncing
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Push Endpoint URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={webhookUrl} readOnly className="min-w-0 font-mono text-sm bg-muted" />
              <CopyButton
                value={webhookUrl}
                iconOnly
                label="Copy Gmail webhook endpoint"
                className="shrink-0"
                title="Copy webhook URL"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {webhookSecretConfigured
                ? "A webhook secret is configured and remains masked. Replace <YOUR_WEBHOOK_SECRET> with the exact saved value when configuring Google Cloud; rotate it above if it is no longer available."
                : "Inbound Gmail push is disabled until the active credential has a webhook secret. Add or edit the credential, then replace <YOUR_WEBHOOK_SECRET> with that value in Google Cloud."}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground space-y-2">
            <p><strong>Google Cloud Setup:</strong></p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Create a Pub/Sub topic in <a href="https://console.cloud.google.com/cloudpubsub" target="_blank" rel="noopener noreferrer" className="underline font-medium">Google Cloud Console</a></li>
              <li>Create a push subscription for that topic with the endpoint URL above</li>
              <li>Grant <code className="bg-muted px-1 rounded text-xs">gmail-api-push@system.gserviceaccount.com</code> Pub/Sub Publisher role on the topic</li>
              <li>Save the topic name (e.g., <code className="bg-muted px-1 rounded text-xs">projects/my-project/topics/gmail-push</code>) in the <strong>Pub/Sub Topic</strong> field of the credentials above</li>
              <li>Add the server&apos;s <strong>OAuth Redirect URI</strong> (e.g., <code className="bg-muted px-1 rounded text-xs">https://yourdomain.com/api/gmail/oauth/callback</code>) to your <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="underline font-medium">Google Cloud OAuth 2.0 Client</a> authorized redirect URIs</li>
            </ol>
          </div>
          <Alert>
            <Shield className="h-4 w-4" />
            <AlertDescription className="text-sm">
              Users can enable/disable push notifications from their email integration settings. The watch subscription
              auto-expires after 7 days and needs to be renewed (done automatically via cron if configured).
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title="Delete Gmail OAuth Credentials"
        description="Are you sure? Users using default credentials will lose Gmail connectivity until new credentials are added."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
      />
    </div>
  );
}
