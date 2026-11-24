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
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Brain,
  Globe,
  Wand2,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { type AdminProviderCredential as Credential } from "../credential-types";

const AI_PLATFORMS = ["openai", "gemini", "vertex_ai", "openrouter", "custom_ai"] as const;

const PLATFORM_META: Record<string, { label: string; icon: React.ReactNode; color: string; description: string }> = {
  openai: {
    label: "OpenAI",
    icon: <Brain className="h-5 w-5" />,
    color: "bg-emerald-500",
    description: "GPT models for AI chat, content generation, and automation",
  },
  gemini: {
    label: "Gemini Developer API",
    icon: <Sparkles className="h-5 w-5" />,
    color: "bg-blue-500",
    description: "Google AI Studio API keys for Gemini models",
  },
  vertex_ai: {
    label: "Google Cloud Vertex AI",
    icon: <Sparkles className="h-5 w-5" />,
    color: "bg-sky-700",
    description: "Google Cloud service-account access to regional Gemini models",
  },
  openrouter: {
    label: "OpenRouter",
    icon: <Globe className="h-5 w-5" />,
    color: "bg-purple-500",
    description: "Access multiple LLM providers through a unified API",
  },
  custom_ai: {
    label: "Custom AI",
    icon: <Wand2 className="h-5 w-5" />,
    color: "bg-amber-500",
    description: "Connect your own OpenAI-compatible API endpoint",
  },
};

export default function AIProvidersPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const [addModalOpen, setAddModalOpen] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<{ credentials?: Credential[]; data?: Credential[] }>("/api/admin/integrations");
      const allCreds: Credential[] = data.credentials || data.data || [];
      setCredentials(allCreds.filter((c) => AI_PLATFORMS.includes(c.platform as typeof AI_PLATFORMS[number])));
    } catch {
      toast({ title: "Error", description: "Failed to fetch credentials", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleToggle = async (id: number) => {
    try {
      await api.post(`/api/admin/integrations/${id}/toggle`);
      toast({ title: "Success", description: "API key status updated" });
      fetchData();
    } catch { toast({ title: "Error", description: "Failed to toggle API key", variant: "destructive" }); }
  };

  const handleTest = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<{ test?: { success: boolean; message?: string }; success?: boolean; message?: string }>(`/api/admin/integrations/${id}/test`);
      const test = data.test || data;
      toast({ title: test.success ? "Connection Successful" : "Connection Failed", description: test.message || (test.success ? "Test passed" : "Test failed"), variant: test.success ? "default" : "destructive" });
    } catch (error: unknown) {
      toast({ title: "Test Failed", description: (error as Error).message || "Failed to test connection", variant: "destructive" });
    } finally { setTestingId(null); }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "API key deleted" });
      fetchData();
    } catch { toast({ title: "Error", description: "Failed to delete API key", variant: "destructive" }); }
    finally { setDeletingId(null); setDeleteConfirm({ open: false, id: null }); }
  };

  const getAddPath = (platform: string) => {
    const slug = platform.replace(/_/g, "-");
    return `/admin/dashboard/integrations/llm/${slug}/add`;
  };

  const getEditPath = (platform: string, id: number) => {
    const slug = platform.replace(/_/g, "-");
    return `/admin/dashboard/integrations/llm/${slug}/edit/${id}`;
  };

  const renderCredentialRow = (credential: Credential) => {
    const meta = PLATFORM_META[credential.platform];
    return (
      <div key={credential.id} className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex items-center gap-4">
          <Switch checked={credential.isActive} onCheckedChange={() => handleToggle(credential.id)} />
          <div>
            <div className="flex items-center gap-2">
              <div className={`p-1.5 rounded-md ${meta?.color || "bg-gray-500"} text-white`}>
                {meta?.icon || <Key className="h-4 w-4" />}
              </div>
              <span className="font-medium">{credential.name}</span>
              <Badge variant="outline" className="text-xs">{meta?.label || credential.platform}</Badge>
              <Badge variant={credential.isActive ? "default" : "secondary"}>
                {credential.isActive ? "Active" : "Inactive"}
              </Badge>
              <Badge variant="outline">{credential.priority}</Badge>
              {credential.deactivationReason && (
                <Badge variant="destructive" className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {credential.deactivationReason}
                </Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground flex items-center gap-4 mt-1">
              <span className="flex items-center gap-1">
                <Key className="h-3 w-3" />
                {credential.apiKey}
              </span>
              {typeof (credential.config as { model?: string })?.model === "string" && (
                <span>Model: {(credential.config as { model?: string }).model}</span>
              )}
              {typeof (credential.config as { baseUrl?: string })?.baseUrl === "string" && (
                <span>Endpoint: {(credential.config as { baseUrl?: string }).baseUrl}</span>
              )}
              {credential.lastUsedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last used: {new Date(credential.lastUsedAt).toLocaleDateString()}
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleTest(credential.id)} loading={testingId === credential.id} loadingText={null}>
            <Play className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push(getEditPath(credential.platform, credential.id))}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDeleteConfirm({ open: true, id: credential.id })} loading={deletingId === credential.id} loadingText={null}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <LoadingState size="page" label="Loading LLM providers…" />
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex justify-end"><Button asChild variant="outline"><Link href="/admin/dashboard/integrations/llm/models">Manage assistant models</Link></Button></div>
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
          <Link href="/admin/dashboard/integrations" className="shrink-0">
            <Button variant="ghost" size="icon" className="shrink-0"><ArrowLeft className="h-5 w-5" /></Button>
          </Link>
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="shrink-0 rounded-lg bg-gradient-to-r from-emerald-500 to-purple-500 p-3 text-white">
              <Brain className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-black tracking-tighter">LLM Providers</h1>
              <p className="text-muted-foreground">Manage OpenAI, Gemini Developer API, Vertex AI, OpenRouter, and custom providers</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:pl-14 lg:pl-0">
          <Button onClick={fetchData} variant="outline" size="icon" className="shrink-0">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setAddModalOpen(true)} className="shrink-0">
            <Plus className="h-4 w-4 mr-2" />
            Add API Key
          </Button>
        </div>
      </div>

      {/* All Credentials List */}
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>All configured AI provider credentials</CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <div className="text-center py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No API Keys Configured</h3>
              <p className="text-muted-foreground mb-4">
                Add your first API key to enable AI providers.
              </p>
              <Button onClick={() => setAddModalOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add API Key
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {credentials.map((credential) => renderCredentialRow(credential))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Provider Modal */}
      <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add API Key</DialogTitle>
            <DialogDescription>Choose which AI provider you want to add credentials for.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            {AI_PLATFORMS.map((platform) => {
              const meta = PLATFORM_META[platform];
              return (
                <button
                  key={platform}
                  className="flex items-center gap-4 p-4 rounded-lg border hover:bg-accent hover:border-primary/50 transition-colors text-left"
                  onClick={() => {
                    setAddModalOpen(false);
                    router.push(getAddPath(platform));
                  }}
                >
                  <div className={`p-2.5 rounded-lg ${meta.color} text-white`}>
                    {meta.icon}
                  </div>
                  <div>
                    <p className="font-medium">{meta.label}</p>
                    <p className="text-sm text-muted-foreground">{meta.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm((prev) => ({ ...prev, open }))}
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
