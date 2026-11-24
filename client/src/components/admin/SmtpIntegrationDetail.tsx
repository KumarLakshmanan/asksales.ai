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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  ArrowLeft,
  Mail,
  Key,
  Plus,
  Trash2,
  Edit,
  Play,
  Clock,
  Zap,
  AlertTriangle,
  Send,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface SmtpCredential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string;
  isActive: boolean;
  priority: string;
  config?: {
    host?: string;
    port?: number;
    secure?: boolean;
    fromName?: string;
    fromEmail?: string;
    provider?: string;
    domain?: string;
    resendCredentialId?: number;
  };
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  createdAt: string;
}

interface ResendCredential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string;
  isActive: boolean;
  priority: string;
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  createdAt: string;
}

export default function SmtpIntegrationDetail() {
  const { toast } = useToast();
  const router = useRouter();
  const [credentials, setCredentials] = useState<SmtpCredential[]>([]);
  const [_resendCredentials, setResendCredentials] = useState<ResendCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: number | null;
    type: "smtp" | "resend";
  }>({ open: false, id: null, type: "smtp" });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<unknown>("/api/admin/integrations");
      const allCreds = Array.isArray(data) ? data : ((data as Record<string, unknown>).credentials as SmtpCredential[] | undefined) || ((data as Record<string, unknown>).data as SmtpCredential[] | undefined) || [];
      const smtpCreds = allCreds.filter(
        (c: SmtpCredential) => c.platform === "smtp"
      );
      const resendCreds = allCreds.filter(
        (c: ResendCredential) => c.platform === "resend"
      );
      setCredentials(smtpCreds);
      setResendCredentials(resendCreds);
    } catch (error) {
      console.error("Error fetching data:", error);
      toast({
        title: "Error",
        description: "Failed to fetch email settings",
        variant: "destructive",
      });
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
      toast({
        title: "Success",
        description: "SMTP settings status updated",
      });
      fetchData();
    } catch {
      toast({
        title: "Error",
        description: "Failed to toggle SMTP settings",
        variant: "destructive",
      });
    }
  };

  const handleTest = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<unknown>(`/api/admin/integrations/${id}/test`);
      const testResult = (data as Record<string, unknown>).test || data;
      const test = testResult as { success?: boolean; message?: string };
      if (test.success) {
        toast({
          title: "Connection Successful",
          description: test.message || "SMTP connection test passed",
        });
      } else {
        toast({
          title: "Connection Failed",
          description: test.message || "Test failed",
          variant: "destructive",
        });
      }
    } catch (error: unknown) {
      toast({
        title: "Test Failed",
        description:
          (error as Error).message || "Failed to test SMTP connection",
        variant: "destructive",
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "SMTP settings deleted" });
      fetchData();
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete SMTP settings",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null, type: "smtp" });
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-[400px]" label="Loading email settings…" />
    );
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
            <div className="shrink-0 rounded-lg bg-red-600 p-3 text-white dark:bg-red-500 dark:text-red-950">
              <Mail className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">System Email</h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">
                Configure SMTP or Resend for OTP emails and notifications
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button onClick={fetchData} variant="outline" size="icon" aria-label="Refresh email credentials">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => router.push('/admin/dashboard/integrations/smtp/add')}>
            <Plus className="h-4 w-4 mr-2" />
            Add Email Config
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="flex flex-wrap gap-2">
        {[
          "OTP Emails",
          "Password Reset",
          "Email Verification",
          "Notifications",
        ].map((feature) => (
          <Badge key={feature} variant="secondary">
            {feature}
          </Badge>
        ))}
      </div>

      {/* Usage Info */}
      <Callout tone="info" icon={Mail} title="SMTP Email Usage">
        SMTP email is used for system emails only (OTP, password reset,
        email verification). For marketing outreach emails, configure
        email outreach in the user&apos;s settings.
      </Callout>

      {/* Credentials List */}
      <Card>
        <CardHeader>
          <CardTitle>Email Settings</CardTitle>
          <CardDescription>
            Manage your SMTP and Resend settings. Higher priority settings are
            used first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <div className="py-10 text-center sm:py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No SMTP Configured</h3>
              <p className="text-muted-foreground mb-4">
                Add your first SMTP settings to enable email features.
              </p>
              <Button onClick={() => router.push('/admin/dashboard/integrations/smtp/add')}>
                <Plus className="h-4 w-4 mr-2" />
                Add Email Config
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {credentials.map((credential) => (
                <div
                  key={credential.id}
                  className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
                    <Switch
                      checked={credential.isActive}
                      onCheckedChange={() => handleToggle(credential.id)}
                      aria-label={`${credential.isActive ? "Disable" : "Enable"} ${credential.name}`}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words font-medium">{credential.name}</span>
                        <Badge
                          variant={
                            credential.isActive ? "default" : "secondary"
                          }
                        >
                          {credential.isActive ? "Active" : "Inactive"}
                        </Badge>
                        <Badge variant="outline">{credential.priority}</Badge>
                        {credential.deactivationReason && (
                          <Badge
                            variant="destructive"
                            className="flex items-center gap-1"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {credential.deactivationReason}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground sm:text-sm">
                        {credential.config?.provider === "resend" ? (
                          <span className="flex items-center gap-1">
                            <Send className="h-3 w-3" />
                            Resend — {credential.config?.domain || "no domain"}
                          </span>
                        ) : (
                          <span>
                            {credential.config?.host}:{credential.config?.port}
                            {credential.config?.secure ? " (SSL)" : " (TLS)"}
                          </span>
                        )}
                        {credential.config?.fromEmail && (
                          <span>
                            From: {credential.config.fromName} &lt;
                            {credential.config.fromEmail}&gt;
                          </span>
                        )}
                        {credential.lastUsedAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last used:{" "}
                            {new Date(
                              credential.lastUsedAt
                            ).toLocaleDateString()}
                          </span>
                        )}
                        {credential.usageCount && (
                          <span className="flex items-center gap-1">
                            <Zap className="h-3 w-3" />
                            {credential.usageCount} emails sent
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(credential.id)}
                      loading={testingId === credential.id}
                      loadingText={null}
                      aria-label={`Test ${credential.name}`}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/admin/dashboard/integrations/smtp/edit/${credential.id}`)}
                      aria-label={`Edit ${credential.name}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDeleteConfirm({ open: true, id: credential.id, type: "smtp" })
                      }
                      loading={deletingId === credential.id}
                      loadingText={null}
                      aria-label={`Delete ${credential.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) =>
          setDeleteConfirm((prev) => ({ ...prev, open }))
        }
        onConfirm={() =>
          deleteConfirm.id && handleDelete(deleteConfirm.id)
        }
        title={deleteConfirm.type === "resend" ? "Delete Resend Settings" : "Delete SMTP Settings"}
        description={`Are you sure you want to delete these ${deleteConfirm.type === "resend" ? "Resend" : "SMTP"} settings? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
