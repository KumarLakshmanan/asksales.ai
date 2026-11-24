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
  Key,
  Plus,
  Trash2,
  Edit,
  Play,
  Clock,
  Zap,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { LoadingState } from "@/components/ui/loading-state";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface Credential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string;
  isActive: boolean;
  priority: string;
  config?: Record<string, unknown>;
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  createdAt: string;
  lastValidatedAt?: string | null;
  validationStatus?: "valid" | "invalid" | "manual_required" | null;
  validationMessage?: string | null;
  rotatedAt?: string | null;
}

interface IntegrationDetailProps {
  platform: string;
  platformName: string;
  icon: React.ReactNode;
  color: string;
  description: string;
  features: string[];
  showModelField?: boolean;
  modelPlaceholder?: string;
  modelOptions?: { value: string; label: string }[];
  /** If true, shows a second field (Key Secret / apiSecret) below the main API key */
  showSecretField?: boolean;
  keyFieldLabel?: string;
  keyFieldPlaceholder?: string;
  secretFieldLabel?: string;
  secretFieldPlaceholder?: string;
}

export default function IntegrationDetail({
  platform,
  platformName,
  icon,
  color,
  description,
  features,
  showModelField: _showModelField = false,
  modelPlaceholder: _modelPlaceholder = "",
  modelOptions: _modelOptions,
  showSecretField: _showSecretField = false,
  keyFieldLabel: _keyFieldLabel = "API Key",
  keyFieldPlaceholder: _keyFieldPlaceholder = "sk-...",
  secretFieldLabel: _secretFieldLabel = "API Secret",
  secretFieldPlaceholder: _secretFieldPlaceholder = "Enter secret",
}: IntegrationDetailProps) {
  const { toast } = useToast();
  const router = useRouter();
  const routeSlug = platform.replace(/_/g, "-");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: number | null;
  }>({ open: false, id: null });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<unknown>("/api/admin/integrations");
      const allCreds: Credential[] = Array.isArray(data)
        ? (data as Credential[])
        : ((data as Record<string, unknown>)?.credentials as Credential[]) || ((data as Record<string, unknown>)?.data as Credential[]) || [];
      const platformCreds = allCreds.filter(
        (c: Credential) => c.platform === platform
      );
      setCredentials(platformCreds);
    } catch {
      toast({
        title: "Error",
        description: "Failed to fetch credentials",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [platform, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggle = async (id: number) => {
    try {
      await api.post(`/api/admin/integrations/${id}/toggle`);
      toast({
        title: "Success",
        description: "API key status updated",
      });
      fetchData();
    } catch {
      toast({
        title: "Error",
        description: "Failed to toggle API key",
        variant: "destructive",
      });
    }
  };

  const handleTest = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<unknown>(`/api/admin/integrations/${id}/test`);
      const testData = (data as Record<string, unknown>)?.test as { success?: boolean; message?: string } | undefined;
      const test = testData || (data as { success?: boolean; message?: string });
      if (test.success) {
        toast({
          title: "Connection Successful",
          description: test.message || "Connection test passed",
        });
      } else {
        toast({
          title: "Connection Failed",
          description: test.message || "Test failed",
          variant: "destructive",
        });
      }
      await fetchData();
    } catch (error: unknown) {
      toast({
        title: "Test Failed",
        description:
          (error as Error).message || "Failed to test connection",
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
      toast({ title: "Success", description: "API key deleted" });
      fetchData();
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete API key",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null });
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-[400px]" label="Loading integration…" />
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
            <div className={`shrink-0 rounded-lg p-3 ${color} text-white`}>
              {icon}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">
                {platformName}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">{description}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button onClick={fetchData} variant="outline" size="icon" aria-label="Refresh credentials">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => router.push(`/admin/dashboard/integrations/${routeSlug}/add`)}>
            <Plus className="h-4 w-4 mr-2" />
            Add API Key
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="flex flex-wrap gap-2">
        {features.map((feature) => (
          <Badge key={feature} variant="secondary">
            {feature}
          </Badge>
        ))}
      </div>

      {/* Credentials List */}
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>
            Manage your {platformName} API keys. Higher priority keys are
            used first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <div className="py-10 text-center sm:py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">
                No API Keys Configured
              </h3>
              <p className="text-muted-foreground mb-4">
                Add your first {platformName} API key to enable this
                integration.
              </p>
              <Button onClick={() => router.push(`/admin/dashboard/integrations/${routeSlug}/add`)}>
                <Plus className="h-4 w-4 mr-2" />
                Add API Key
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
                        <span className="break-words font-medium">
                          {credential.name}
                        </span>
                        <Badge
                          variant={
                            credential.isActive ? "default" : "secondary"
                          }
                        >
                          {credential.isActive ? "Active" : "Inactive"}
                        </Badge>
                        <Badge variant="outline">
                          {credential.priority}
                        </Badge>
                        {credential.deactivationReason && (
                          <Badge
                            variant="destructive"
                            className="flex items-center gap-1"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {credential.deactivationReason}
                          </Badge>
                        )}
                        {credential.validationStatus && (
                          <Badge variant={credential.validationStatus === "valid" ? "secondary" : credential.validationStatus === "invalid" ? "destructive" : "outline"}>
                            {credential.validationStatus === "manual_required" ? "OAuth callback required" : credential.validationStatus === "valid" ? "Validated" : "Validation failed"}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground sm:text-sm">
                        <span className="flex min-w-0 items-center gap-1 break-all">
                          <Key className="h-3 w-3" />
                          {credential.apiKey}
                        </span>
                        {typeof (
                          credential.config as { model?: string }
                        )?.model === "string" && (
                          <span className="flex items-center gap-1">
                            Model:{" "}
                            {
                              (credential.config as { model?: string })
                                .model
                            }
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
                        {credential.lastValidatedAt && (
                          <span className="flex items-center gap-1" title={credential.validationMessage || undefined}>
                            <ShieldCheck className="h-3 w-3" />
                            Validated: {new Date(credential.lastValidatedAt).toLocaleDateString()}
                          </span>
                        )}
                        {credential.rotatedAt && (
                          <span className="flex items-center gap-1">
                            <RefreshCw className="h-3 w-3" />
                            Rotated: {new Date(credential.rotatedAt).toLocaleDateString()}
                          </span>
                        )}
                        {credential.usageCount && (
                          <span className="flex items-center gap-1">
                            <Zap className="h-3 w-3" />
                            {credential.usageCount} uses
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
                      onClick={() => router.push(`/admin/dashboard/integrations/${routeSlug}/edit/${credential.id}`)}
                      aria-label={`Edit ${credential.name}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDeleteConfirm({
                          open: true,
                          id: credential.id,
                        })
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
        title="Delete API Key"
        description="Are you sure you want to delete this API key? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
