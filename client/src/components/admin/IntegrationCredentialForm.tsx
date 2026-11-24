"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, IndianRupee } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/admin-api";
import type { PlatformConfig } from "@/lib/admin-integration-platforms";

interface GenaiPriceData {
  model: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
  margin: number;
  adjustedInputPerMillion: number;
  adjustedOutputPerMillion: number;
}

const LLM_PLATFORMS = new Set(["openai", "gemini", "vertex_ai", "openrouter", "custom_ai"]);
const EMBEDDING_PLATFORMS = new Set(["openai_embedding", "gemini_embedding", "openrouter_embedding"]);

// Map admin platform keys to genai-prices provider IDs for dynamic model fetching
const PLATFORM_TO_GENAI_PROVIDER: Record<string, string> = {
  openai: "openai",
  gemini: "google",
  vertex_ai: "google",
  openrouter: "openrouter",
};

interface IntegrationCredentialFormProps {
  platform: string;
  config: PlatformConfig;
  credentialId?: number;
  classifier?: boolean;
}

export default function IntegrationCredentialForm({
  platform,
  config,
  credentialId,
  classifier = false,
}: IntegrationCredentialFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const routeSlug = platform.replace(/_/g, "-");
  const backPath = classifier
    ? "/admin/dashboard/integrations/intent-classifier"
    : EMBEDDING_PLATFORMS.has(platform)
    ? "/admin/dashboard/integrations/embeddings"
    : LLM_PLATFORMS.has(platform)
      ? "/admin/dashboard/integrations/llm"
      : `/admin/dashboard/integrations/${routeSlug}`;

  const [loading, setLoading] = useState(!!credentialId);
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
    accountName?: string;
  } | null>(null);

  const endpoint = classifier ? "/api/admin/intent-classifier-integrations" : "/api/admin/integrations";
  const [formName, setFormName] = useState(`${config.platformName} ${classifier ? "Classifier" : "API Key"}`);
  const [formApiKey, setFormApiKey] = useState("");
  const [formApiSecret, setFormApiSecret] = useState("");
  const [formPriority, setFormPriority] = useState("normal");
  const [formModel, setFormModel] = useState(classifier && platform === "openrouter" ? "typesafe/jev-1.13" : "");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formLocation, setFormLocation] = useState(platform === "vertex_ai" ? "us-central1" : "");
  const [formChunkSize, setFormChunkSize] = useState("");
  const [formChunkOverlap, setFormChunkOverlap] = useState("");
  const [genaiPrice, setGenaiPrice] = useState<GenaiPriceData | null>(null);
  const [genaiLoading, setGenaiLoading] = useState(false);
  const [dynamicModels, setDynamicModels] = useState<{ value: string; label: string }[]>([]);

  const isLlmPlatform = LLM_PLATFORMS.has(platform);

  // Fetch dynamic model list from genai-prices for LLM platforms
  useEffect(() => {
    const genaiProvider = PLATFORM_TO_GENAI_PROVIDER[platform];
    if (!genaiProvider) return;
    let cancelled = false;
    const fetchModels = async () => {
      try {
        const res = await api.get<{ provider: string; models: { id: string; name: string }[] }>(
          `/api/admin/api-pricing/genai-provider-models?provider=${genaiProvider}`
        );
        if (!cancelled && res?.models) {
          setDynamicModels(res.models.map(m => ({ value: m.id, label: m.name || m.id })));
        }
      } catch {
        // Fall back to static options
      }
    };
    fetchModels();
    return () => { cancelled = true; };
  }, [platform]);

  useEffect(() => {
    if (!credentialId) return;
    const fetchCredential = async () => {
      try {
        const data = await api.get<unknown>(`${endpoint}/${credentialId}/full`);
        const cred = ((data as Record<string, unknown>)?.credential as Record<string, unknown>) || (data as Record<string, unknown>);
        setFormName((cred?.name as string) || "");
        setFormApiKey("");
        setFormApiSecret("");
        setFormPriority((cred?.priority as string) || "normal");
        const config = cred?.config as Record<string, unknown> | undefined;
        setFormModel((config?.model as string) || "");
        setFormBaseUrl((config?.baseUrl as string) || "");
        setFormLocation((config?.location as string) || (platform === "vertex_ai" ? "us-central1" : ""));
        setFormChunkSize(config?.chunkSize != null ? String(config.chunkSize) : "");
        setFormChunkOverlap(config?.chunkOverlap != null ? String(config.chunkOverlap) : "");
      } catch {
        toast({
          title: "Error",
          description: "Failed to load credential",
          variant: "destructive",
        });
        router.push(backPath);
      } finally {
        setLoading(false);
      }
    };
    fetchCredential();
  }, [credentialId, platform, backPath, endpoint, router, toast]);

  // Fetch genai-prices for LLM model pricing
  useEffect(() => {
    if (!isLlmPlatform || !formModel) {
      setGenaiPrice(null);
      return;
    }
    let cancelled = false;
    const fetchGenai = async () => {
      setGenaiLoading(true);
      try {
        const data = await api.get<unknown>(`/api/admin/api-pricing/genai-model-price?model=${encodeURIComponent(formModel)}`);
        if (!cancelled) {
          const price = data as Partial<GenaiPriceData> | null;
          setGenaiPrice(price && typeof price.inputPerMillion === "number"
            && typeof price.outputPerMillion === "number"
            && typeof price.margin === "number"
            && typeof price.adjustedInputPerMillion === "number"
            && typeof price.adjustedOutputPerMillion === "number"
            ? price as GenaiPriceData : null);
        }
      } catch {
        if (!cancelled) setGenaiPrice(null);
      } finally {
        if (!cancelled) setGenaiLoading(false);
      }
    };
    const timer = setTimeout(fetchGenai, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isLlmPlatform, formModel]);

  const validateApiKey = async (apiKey: string) => {
    if (classifier) return;
    if (!apiKey || apiKey.length < 10) return;
    try {
      setValidating(true);
      setValidationResult(null);
      const validationConfig: Record<string, unknown> = {};
      if (formModel) validationConfig.model = formModel;
      if (formLocation) validationConfig.location = formLocation;
      const data = await api.post<unknown>("/api/admin/integrations/validate", {
        platform,
        apiKey,
        ...(formApiSecret ? { apiSecret: formApiSecret } : {}),
        config: validationConfig,
      });
      const validationData = ((data as Record<string, unknown>)?.validation as Record<string, unknown>) || (data as Record<string, unknown>);
      const validation = {
        success: validationData.success === true,
        message: typeof validationData.message === "string" ? validationData.message : validationData.success === true ? "API key is valid" : "API key validation failed",
        accountName: typeof validationData.accountName === "string" ? validationData.accountName : undefined,
      };
      setValidationResult(validation);
      if (validation.success && validation.accountName) {
        setFormName(validation.accountName);
      }
    } catch {
      setValidationResult({ success: false, message: "Failed to validate API key" });
    } finally {
      setValidating(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast({ title: "Error", description: "Name is required", variant: "destructive" });
      return;
    }
    if (config.showSecretField && config.secretRequired !== false && !credentialId && !formApiSecret) {
      toast({
        title: "Error",
        description: `${config.secretFieldLabel || "API Secret"} is required`,
        variant: "destructive",
      });
      return;
    }
    if (!credentialId && !formApiKey) {
      toast({ title: "Error", description: "API key is required", variant: "destructive" });
      return;
    }
    if (classifier && !formModel.trim()) {
      toast({ title: "Error", description: "Classifier model is required", variant: "destructive" });
      return;
    }



    try {
      setSubmitting(true);
      const configPayload: Record<string, unknown> = {};
      if (formModel) configPayload.model = formModel;
      if (platform === "custom_ai" && formBaseUrl) configPayload.baseUrl = formBaseUrl;
      if (config.showLocationField && formLocation) configPayload.location = formLocation;
      if (config.showChunkConfig) {
        const cs = parseInt(formChunkSize);
        const co = parseInt(formChunkOverlap);
        if (!isNaN(cs) && cs > 0) configPayload.chunkSize = cs;
        if (!isNaN(co) && co >= 0) configPayload.chunkOverlap = co;
      }

      const payload: Record<string, unknown> = {
        platform,
        name: formName,
        priority: formPriority,
        config: configPayload,
      };
      if (formApiKey) payload.apiKey = formApiKey;
      if (formApiSecret) payload.apiSecret = formApiSecret;

      if (credentialId) {
        await api.put(`${endpoint}/${credentialId}`, payload);
      } else {
        await api.post(endpoint, payload);
      }

      toast({
        title: "Success",
        description: credentialId ? "Credential updated successfully" : "Credential added successfully",
      });
      router.push(backPath);
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: (error as Error).message || "Failed to save credential",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-[400px]" label="Loading credential…" />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push(backPath)}
          className="shrink-0"
          aria-label="Back to integration credentials"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight sm:text-2xl">
            {credentialId ? "Edit" : "Add"} {config.platformName} {classifier ? "Classifier" : "Credential"}
          </h1>
          <p className="text-muted-foreground text-sm">{config.description}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{credentialId ? "Update" : "New"} API Key</CardTitle>
          <CardDescription>
            {credentialId
              ? "Update your API key settings. Leave the key field blank to keep the existing key."
              : `Add a new ${config.platformName} API key.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="My API Key"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">A friendly name to identify this key</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">
                {config.keyFieldLabel || "API Key"}
                {credentialId && (
                  <span className="ml-1 text-muted-foreground font-normal text-xs">(leave blank to keep existing)</span>
                )}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <PasswordInput
                    id="apiKey"
                    placeholder={config.keyFieldPlaceholder || "Enter API key"}
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    onBlur={() => {
                      if (!classifier && formApiKey && config.showValidate !== false) {
                        validateApiKey(formApiKey);
                      }
                    }}
                  />
                </div>
                {!classifier && config.showValidate !== false && (
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0 sm:self-start"
                    onClick={() => validateApiKey(formApiKey)}
                    loading={validating}
                    loadingText="Validating…"
                    disabled={!formApiKey}
                  >
                    Validate
                  </Button>
                )}
              </div>
              {validationResult && (
                <div className={`text-sm break-words ${validationResult.success ? "text-green-600" : "text-red-600"}`}>
                  {validationResult.message}
                  {validationResult.success && validationResult.accountName && (
                    <span className="block text-muted-foreground">Account: {validationResult.accountName}</span>
                  )}
                </div>
              )}
            </div>

            {config.showSecretField && (
              <div className="space-y-2">
                <Label htmlFor="apiSecret">
                  {config.secretFieldLabel || "API Secret"}
                  {credentialId && (
                    <span className="ml-1 text-muted-foreground font-normal text-xs">(leave blank to keep existing)</span>
                  )}
                </Label>
                <PasswordInput
                  id="apiSecret"
                  placeholder={config.secretFieldPlaceholder || "Enter secret"}
                  value={formApiSecret}
                  onChange={(e) => setFormApiSecret(e.target.value)}
                />
              </div>
            )}

            {config.showModelField && (
              <div className="space-y-2">
                <Label htmlFor="model">{classifier ? "Classifier Model (required)" : "Default Model (optional)"}</Label>
                {(() => {
                  const jev = classifier && platform === "openrouter" ? [{ value: "typesafe/jev-1.13", label: "Jev 1.13 (Decisions)" }] : [];
                  const effectiveOptions = [...jev, ...(dynamicModels.length > 0 ? dynamicModels : (config.modelOptions || [])).filter(option => !jev.some(item => item.value === option.value))];
                  return (
                    <>
                      <Input
                        id="model"
                        list={effectiveOptions.length > 0 ? `model-options-${platform}` : undefined}
                        placeholder={config.modelPlaceholder || "Enter or select a model"}
                        value={formModel}
                        onChange={(e) => setFormModel(e.target.value)}
                      />
                      {effectiveOptions.length > 0 && (
                        <datalist id={`model-options-${platform}`}>
                          {effectiveOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </datalist>
                      )}
                    </>
                  );
                })()}
                <p className="text-xs text-muted-foreground">Select from suggestions or type a custom model name</p>

                {/* Model pricing display (LLM platforms only — image/video use flat credits) */}
                {formModel && isLlmPlatform && (
                  <div className="mt-2">
                    {genaiLoading ? (
                      <div className="flex items-center gap-2 p-2 rounded-md bg-muted border">
                        <Spinner size="sm" label={null} />
                        <span className="text-xs text-muted-foreground">Looking up model pricing&hellip;</span>
                      </div>
                    ) : genaiPrice ? (
                      <div className="flex items-center gap-2 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                        <IndianRupee className="h-4 w-4 text-green-600" />
                        <div className="text-xs text-green-700 dark:text-green-300">
                          <span className="font-medium">{genaiPrice.name}</span>
                          <span>
                            {" "}&mdash; Input: ₹{genaiPrice.inputPerMillion.toFixed(2)}/1M
                            {" "}&bull; Output: ₹{genaiPrice.outputPerMillion.toFixed(2)}/1M
                          </span>
                          {genaiPrice.margin > 0 && (
                            <span className="text-green-600 dark:text-green-400">
                              {" "}(+{genaiPrice.margin}% margin &rarr; ₹{genaiPrice.adjustedInputPerMillion.toFixed(2)}/₹{genaiPrice.adjustedOutputPerMillion.toFixed(2)})
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <Callout tone="warning" size="sm">
                        Model &ldquo;{formModel}&rdquo; not found in genai-prices database. Cost tracking may be inaccurate.
                      </Callout>
                    )}
                  </div>
                )}
              </div>
            )}

            {platform === "custom_ai" && (
              <div className="space-y-2">
                <Label htmlFor="baseUrl">OpenAI-compatible endpoint URL</Label>
                <Input id="baseUrl" type="url" required value={formBaseUrl}
                  onChange={(event) => setFormBaseUrl(event.target.value)} placeholder="https://example.com/v1" />
              </div>
            )}

            {config.showLocationField && (
              <div className="space-y-2">
                <Label htmlFor="location">Google Cloud location</Label>
                <Input
                  id="location"
                  placeholder="us-central1"
                  value={formLocation}
                  onChange={(event) => setFormLocation(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The Vertex AI region used for data processing. It must support the selected model.
                </p>
              </div>
            )}

            {config.showChunkConfig && (
              <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
                <div>
                  <h3 className="text-sm font-semibold mb-1">Chunking Settings</h3>
                  <p className="text-xs text-muted-foreground">
                    Controls how documents are split into chunks before embedding. Leave blank to use system defaults (1200 / 200).
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="chunkSize">Chunk Size (chars)</Label>
                    <Input
                      id="chunkSize"
                      type="number"
                      min={100}
                      max={8000}
                      placeholder="1200"
                      value={formChunkSize}
                      onChange={(e) => setFormChunkSize(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Characters per chunk (100–8000)</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="chunkOverlap">Chunk Overlap (chars)</Label>
                    <Input
                      id="chunkOverlap"
                      type="number"
                      min={0}
                      max={2000}
                      placeholder="200"
                      value={formChunkOverlap}
                      onChange={(e) => setFormChunkOverlap(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Overlap between chunks (0–2000)</p>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select onValueChange={setFormPriority} value={formPriority}>
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High (used first)</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="fallback">Fallback (used last)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Higher priority keys are tried first when multiple keys are configured</p>
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
              <Button type="submit" loading={submitting} className="w-full sm:w-auto">
                {credentialId ? "Update Credential" : "Add Credential"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(backPath)}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
