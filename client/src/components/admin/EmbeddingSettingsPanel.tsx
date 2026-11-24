"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";

type Provider = "openai" | "gemini" | "openrouter";
const labels: Record<Provider, string> = { openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" };
type Selection = { defaultProvider: Provider | null; defaultModel: string | null; enabledProviders: Provider[] };
type Configuration = { settings: Selection; availableModels: Record<Provider, Record<string, { dimensions: number; description: string }>>; resolved: { provider: Provider; model: string } | null };

export function EmbeddingSettingsPanel() {
  const { toast } = useToast();
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const load = async () => {
    const data = await api.get<Configuration>("/api/embeddings/admin/settings");
    setConfiguration(data);
    setSelection({ ...data.settings, defaultProvider: data.settings.defaultProvider || data.resolved?.provider || "openai", defaultModel: data.settings.defaultModel || data.resolved?.model || "text-embedding-3-small" });
  };
  useEffect(() => { void load().catch(() => setError(true)); }, []);
  const save = async () => {
    if (!selection) return;
    setSaving(true);
    try {
      await api.put("/api/embeddings/admin/settings", selection);
      await load();
      toast({ title: "Embedding settings saved" });
    } catch (cause) {
      toast({ title: "Could not save embedding settings", description: cause instanceof Error ? cause.message : "Please try again.", variant: "destructive" });
    } finally { setSaving(false); }
  };
  const changeProvider = (provider: Provider) => {
    if (!configuration || !selection) return;
    setSelection({ ...selection, defaultProvider: provider, defaultModel: Object.keys(configuration.availableModels[provider])[0] });
  };
  return <Card>
    <CardHeader>
      <CardTitle>Embedding provider settings</CardTitle>
      <CardDescription>Choose which providers may run and the default model. Each provider also needs an active API key.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {error ? <p role="alert">Could not load embedding settings. Refresh to try again.</p> : !selection || !configuration ? <p>Loading embedding settings…</p> : <>
        <div className="flex flex-wrap gap-6">
          {(Object.keys(labels) as Provider[]).map(provider => <label key={provider} className="flex items-center gap-2">
            <Switch aria-label={`Enable ${labels[provider]} embeddings`} checked={selection.enabledProviders.includes(provider)}
              onCheckedChange={checked => setSelection({ ...selection, enabledProviders: checked ? [...selection.enabledProviders, provider] : selection.enabledProviders.filter(item => item !== provider) })} />
            {labels[provider]}
          </label>)}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-medium">Default provider
            <select aria-label="Default embedding provider" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={selection.defaultProvider || "openai"} onChange={event => changeProvider(event.target.value as Provider)}>
              {(Object.keys(labels) as Provider[]).map(provider => <option key={provider} value={provider}>{labels[provider]}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">Default model
            <Input aria-label="Default embedding model" list="embedding-model-options" value={selection.defaultModel || ""} onChange={event => setSelection({ ...selection, defaultModel: event.target.value })} />
            <datalist id="embedding-model-options">{Object.entries(configuration.availableModels[selection.defaultProvider || "openai"]).map(([model, details]) => <option key={model} value={model}>{details.dimensions} dimensions</option>)}</datalist>
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{configuration.resolved ? `Currently selected: ${labels[configuration.resolved.provider]} · ${configuration.resolved.model}` : "No enabled provider has a usable configuration."}</p>
        <p className="text-sm text-muted-foreground">Existing knowledge indexes keep their original model. Rebuild the index when changing models, and keep its provider enabled until the rebuild finishes.</p>
        <Button onClick={save} disabled={saving || !selection.defaultModel || (selection.enabledProviders.length > 0 && !selection.enabledProviders.includes(selection.defaultProvider!))}>{saving ? "Saving…" : "Save embedding settings"}</Button>
      </>}
    </CardContent>
  </Card>;
}
