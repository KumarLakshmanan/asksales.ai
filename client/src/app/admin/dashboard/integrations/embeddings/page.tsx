"use client";

import { EmbeddingSettingsPanel } from "@/components/admin/EmbeddingSettingsPanel";

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
  Database,
  Key,
  Plus,
  Trash2,
  Edit,
  Clock,
  Zap,
  AlertTriangle,
  Play,
  Brain,
  Sparkles,
} from "lucide-react";
import React from "react";
import { api } from "@/lib/admin-api";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";

interface Credential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  isActive: boolean;
  priority: string;
  config?: Record<string, unknown>;
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  createdAt: string;
}

const EMBEDDING_PLATFORMS = ["openai_embedding", "gemini_embedding", "openrouter_embedding"] as const;

const PLATFORM_META: Record<string, { label: string; icon: React.ReactNode; color: string; description: string }> = {
  openai_embedding: {
    label: "OpenAI Embedding",
    icon: <Brain className="h-5 w-5" />,
    color: "bg-emerald-500",
    description: "OpenAI embedding models for semantic search and RAG",
  },
  openrouter_embedding: {
    label: "OpenRouter Embedding", icon: <Zap className="h-5 w-5" />, color: "bg-purple-500",
    description: "Embedding models through OpenRouter",
  },
  gemini_embedding: {
    label: "Gemini Embedding",
    icon: <Sparkles className="h-5 w-5" />,
    color: "bg-blue-500",
    description: "Google Gemini embedding models for semantic search and RAG",
  },
};

export default function EmbeddingsIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  // API credentials state
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const [addModalOpen, setAddModalOpen] = useState(false);

  // Fetch API credentials
  const fetchCredentials = useCallback(async () => {
    try {
      setCredentialsLoading(true);
      const data = await api.get<{ credentials?: Credential[]; data?: Credential[] }>("/api/admin/integrations");
      const allCreds: Credential[] = data.credentials || data.data || [];
      setCredentials(allCreds.filter((c) => EMBEDDING_PLATFORMS.includes(c.platform as typeof EMBEDDING_PLATFORMS[number])));
    } catch {
      toast({ title: "Error", description: "Failed to fetch credentials", variant: "destructive" });
    } finally {
      setCredentialsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  // Toggle credential active/inactive
  const handleToggleCredential = async (id: number) => {
    try {
      await api.post(`/api/admin/integrations/${id}/toggle`);
      toast({ title: "Success", description: "API key status updated" });
      fetchCredentials();
    } catch {
      toast({ title: "Error", description: "Failed to toggle API key", variant: "destructive" });
    }
  };

  // Test credential
  const handleTestCredential = async (id: number) => {
    try {
      setTestingId(id);
      const data = await api.post<{ test?: { success: boolean; message?: string }; success?: boolean; message?: string }>(`/api/admin/integrations/${id}/test`);
      const test = data.test || data;
      toast({
        title: test.success ? "Connection Successful" : "Connection Failed",
        description: test.message || (test.success ? "Test passed" : "Test failed"),
        variant: test.success ? "default" : "destructive",
      });
    } catch (error: unknown) {
      toast({ title: "Test Failed", description: (error as Error).message || "Failed to test connection", variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  // Delete credential
  const handleDeleteCredential = async (id: number) => {
    try {
      setDeletingId(id);
      await api.delete(`/api/admin/integrations/${id}`);
      toast({ title: "Success", description: "API key deleted" });
      fetchCredentials();
    } catch {
      toast({ title: "Error", description: "Failed to delete API key", variant: "destructive" });
    } finally {
      setDeletingId(null);
      setDeleteConfirm({ open: false, id: null });
    }
  };

  const getAddPath = (platform: string) => {
    const slug = platform.replace(/_/g, "-");
    return `/admin/dashboard/integrations/embeddings/${slug}/add`;
  };

  const getEditPath = (platform: string, id: number) => {
    const slug = platform.replace(/_/g, "-");
    return `/admin/dashboard/integrations/embeddings/${slug}/edit/${id}`;
  };

  const renderCredentialRow = (credential: Credential) => {
    const meta = PLATFORM_META[credential.platform];
    return (
      <div key={credential.id} className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex items-center gap-4">
          <Switch checked={credential.isActive} onCheckedChange={() => handleToggleCredential(credential.id)} />
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
          <Button variant="outline" size="sm" onClick={() => handleTestCredential(credential.id)} loading={testingId === credential.id} loadingText={null}>
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



  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard/integrations">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-gradient-to-r from-teal-500 to-cyan-500 text-white">
              <Database className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter">Embedding Providers</h1>
              <p className="text-muted-foreground">
                Configure embedding API keys and providers for semantic search and RAG
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => fetchCredentials()} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setAddModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add API Key
          </Button>
        </div>
      </div>

      <EmbeddingSettingsPanel key={credentials.map(credential => `${credential.id}:${credential.isActive}`).join(',')} />

      {/* API Keys Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Embedding API Keys
          </CardTitle>
          <CardDescription>
            Manage API keys for embedding providers. These are separate from LLM API keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentialsLoading ? (
            <LoadingState size="section" label="Loading embedding API keys…" />
          ) : credentials.length === 0 ? (
            <div className="text-center py-12">
              <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Embedding API Keys</h3>
              <p className="text-muted-foreground mb-4">
                Add your first embedding API key to enable vector embeddings. If no embedding key is configured for a provider, its active LLM API key can be used. Disabled embedding keys are never bypassed.
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


      {/* Info Card */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <Database className="h-5 w-5 text-teal-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">How Embeddings Work</p>
              <p>
                Embeddings convert text into numerical vectors that capture semantic meaning.
                They power the Knowledge Base RAG system, enabling AI to find and use the most
                relevant information when generating replies, drafts, and content.
              </p>
              <p>
                <strong>API Key Fallback:</strong> If no embedding-specific API key has been configured for a provider,
                the system automatically falls back to using the corresponding LLM API key from{" "}
                <Link href="/admin/dashboard/integrations/llm" className="text-primary underline">
                  LLM Providers
                </Link>
                .
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Add Provider Modal */}
      <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Embedding API Key</DialogTitle>
            <DialogDescription>Choose which embedding provider you want to add credentials for.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            {EMBEDDING_PLATFORMS.map((platform) => {
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
        onConfirm={() => deleteConfirm.id && handleDeleteCredential(deleteConfirm.id)}
        title="Delete API Key"
        description="Are you sure you want to delete this embedding API key? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
