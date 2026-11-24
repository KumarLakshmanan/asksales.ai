"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Brain, Plus, RefreshCw, Play, Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/admin-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";

type Credential = { id: number; platform: string; name: string; apiKey: string; isActive: boolean;
  priority: string; config: { model?: string }; usageCount: number; lastUsedAt?: string | null;
  validationStatus?: string | null; validationMessage?: string | null };
const providers = [
  ["openrouter", "OpenRouter"], ["openai", "OpenAI"], ["gemini", "Gemini"],
  ["vertex_ai", "Vertex AI"], ["custom_ai", "Custom AI"],
] as const;
const base = "/admin/dashboard/integrations/intent-classifier";
const endpoint = "/api/admin/intent-classifier-integrations";

export default function IntentClassifierIntegrationsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const data = await api.get<{ credentials: Credential[] }>(endpoint);
      setCredentials(data.credentials || []);
    } catch (error) {
      toast({ title: "Could not load classifiers", description: String(error), variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void reload(); }, [reload]);
  const perform = async (id: number, action: "toggle" | "test" | "delete") => {
    setBusy(id);
    try {
      if (action === "delete") await api.delete(`${endpoint}/${id}`);
      else {
        const result = await api.post<{ test?: { success: boolean; message: string } }>(`${endpoint}/${id}/${action}`);
        if (action === "test" && !result.test?.success) throw new Error(result.test?.message || "Connection test failed");
        if (action === "test") toast({ title: "Classifier connection passed", description: result.test?.message });
      }
      await reload();
    } catch (error) {
      toast({ title: `${action} failed`, description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally { setBusy(null); setDeleting(null); }
  };
  const addPath = (platform: string) => `${base}/${platform.replaceAll("_", "-")}/add`;
  const editPath = (credential: Credential) => `${base}/${credential.platform.replaceAll("_", "-")}/edit/${credential.id}`;
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link className="text-sm text-muted-foreground hover:underline" href="/admin/dashboard/integrations">Integrations</Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Brain className="h-6 w-6" /> Intent Classifier</h1>
          <p className="text-sm text-muted-foreground">Active credentials are tried by priority: high, normal, low, fallback. Jev uses OpenRouter Decisions.</p>
        </div>
        <Button variant="outline" onClick={() => void reload()} aria-label="Refresh classifiers"><RefreshCw className="h-4 w-4" /></Button>
      </div>
      <Card>
        <CardHeader><CardTitle>Add classifier credential</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {providers.map(([id, label]) => <Button key={id} variant="outline" onClick={() => router.push(addPath(id))}>
            <Plus className="mr-2 h-4 w-4" />{label}
          </Button>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Classifier credentials</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {loading ? <p>Loading…</p> : credentials.length === 0 ? <p className="text-sm text-muted-foreground">No classifier credential is active. Chat uses the full reasoning model.</p> :
            credentials.map(credential => <div key={credential.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <Switch checked={credential.isActive} disabled={busy === credential.id} onCheckedChange={() => void perform(credential.id, "toggle")}
                  aria-label={`Toggle ${credential.name}`} />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{credential.name}</span>
                    <Badge variant="outline">{credential.platform}</Badge>
                    <Badge variant={credential.isActive ? "default" : "secondary"}>{credential.isActive ? "Active" : "Inactive"}</Badge>
                    <Badge variant="outline">{credential.priority}</Badge>
                    {credential.validationStatus && <Badge variant={credential.validationStatus === "valid" ? "default" : "destructive"}>{credential.validationStatus}</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{credential.config.model || "Model missing"} · {credential.usageCount || 0} uses · Last used {credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleString() : "never"}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={busy === credential.id} onClick={() => void perform(credential.id, "test")} aria-label={`Test ${credential.name}`}><Play className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => router.push(editPath(credential))} aria-label={`Edit ${credential.name}`}><Pencil className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => setDeleting(credential.id)} aria-label={`Delete ${credential.name}`}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>)}
        </CardContent>
      </Card>
      <ConfirmDialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }}
        onConfirm={() => { if (deleting !== null) void perform(deleting, "delete"); }}
        title="Delete classifier credential" description="This removes the classifier credential. Its audit history remains available."
        confirmText="Delete" cancelText="Cancel" variant="destructive" />
    </div>
  );
}
