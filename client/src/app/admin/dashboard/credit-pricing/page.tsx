"use client";

import React, { useState, useEffect, useCallback } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Coins,
  Save,
  RefreshCw,
  Sparkles,
  Settings,
  Brain,
  Image,
  Video,
  Server,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";

/* ── Credit Pricing (recharge only) ── */

interface PricingItem {
  id: number;
  eventKey: string;
  name: string;
  description: string;
  category: string;
  creditsPerUnit: string;
  unitLabel: string;
  isActive: boolean;
  sortOrder: number;
}

/* ── API Pricing ── */

interface ApiPricingItem {
  id: number;
  category: string;
  pricingKey: string;
  name: string;
  promptCostPerMillion: string | null;
  completionCostPerMillion: string | null;
  creditsPerUnit: string | null;
  marginPercentage: string | null;
  originalPromptCostPerMillion: string | null;
  originalCompletionCostPerMillion: string | null;
  originalCreditsPerUnit: string | null;
  unitLabel: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface GenaiModel {
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

const API_CATEGORY_CONFIG: Record<string, { label: string; icon: React.ReactNode; description: string }> = {
  apify: { label: "Apify (Web Scraping)", icon: <Server className="w-5 h-5" />, description: "Margin percentage applied on top of actual Apify run cost." },
  zerobounce: { label: "ZeroBounce (Email Validation)", icon: <ShieldCheck className="w-5 h-5" />, description: "Fixed credits deducted per email validation." },
};

const NON_LLM_CATEGORIES = ["apify", "zerobounce"];
const GENAI_PROVIDERS = ["openai", "openrouter", "google"];
const GENAI_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google / Gemini",
};

export default function CreditPricingPage() {
  const { toast } = useToast();

  /* ── Recharge state ── */
  const [rechargeItems, setRechargeItems] = useState<PricingItem[]>([]);
  const [platformItems, setPlatformItems] = useState<PricingItem[]>([]);
  const [rechargeLoading, setRechargeLoading] = useState(true);
  const [rechargeLoadError, setRechargeLoadError] = useState(false);
  const [rechargeSaving, setRechargeSaving] = useState(false);
  const [rechargeEdited, setRechargeEdited] = useState<Record<number, string>>({});
  const [rechargeActiveEdited, setRechargeActiveEdited] = useState<Record<number, boolean>>({});
  const [rechargeHasChanges, setRechargeHasChanges] = useState(false);

  /* ── API Pricing state ── */
  const [apiPricing, setApiPricing] = useState<ApiPricingItem[]>([]);
  const [apiLoading, setApiLoading] = useState(true);
  const [apiLoadError, setApiLoadError] = useState(false);
  const [apiSaving, setApiSaving] = useState(false);
  const [apiEdited, setApiEdited] = useState<Record<number, Partial<ApiPricingItem>>>({});
  const [apiHasChanges, setApiHasChanges] = useState(false);

  /* ── LLM Margin state ── */
  const [llmMargin, setLlmMargin] = useState("");
  const [llmMarginId, setLlmMarginId] = useState<number | null>(null);
  const [llmMarginSaving, setLlmMarginSaving] = useState(false);
  const [llmMarginChanged, setLlmMarginChanged] = useState(false);

  /* ── Image Margin state ── */
  const [imageMargin, setImageMargin] = useState("");
  const [imageMarginId, setImageMarginId] = useState<number | null>(null);
  const [imageMarginSaving, setImageMarginSaving] = useState(false);
  const [imageMarginChanged, setImageMarginChanged] = useState(false);
  const [imagePricingRef, setImagePricingRef] = useState<Array<{
    modelId: string; name: string; marginPct: number;
    resolutionTiers: Array<{ resolution: string; label: string; basePriceINR: number; chargedPriceINR: number }>;
  }>>([]);

  /* ── Video Margin state ── */
  const [videoMargin, setVideoMargin] = useState("");
  const [videoMarginId, setVideoMarginId] = useState<number | null>(null);
  const [videoMarginSaving, setVideoMarginSaving] = useState(false);
  const [videoMarginChanged, setVideoMarginChanged] = useState(false);
  const [videoPricingRef, setVideoPricingRef] = useState<Array<{
    modelId: string; name: string; marginPct: number;
    resolutionTiers: Array<{ resolution: string; label: string; basePricePerSecondINR: number; chargedPricePerSecondINR: number }>;
  }>>([]);

  /* ── GenAI Prices state ── */
  const [genaiModels, setGenaiModels] = useState<Record<string, GenaiModel[]>>({});
  const [genaiLoading, setGenaiLoading] = useState(true);
  const [genaiProvider, setGenaiProvider] = useState("openai");

  /* ── Fetch recharge rules ── */
  const fetchRecharge = useCallback(async () => {
    setRechargeLoading(true);
    setRechargeLoadError(false);
    try {
      const res = await api.get<PricingItem[]>("/api/admin/credit-pricing");
      const allItems = res || [];
      setRechargeItems(allItems.filter((i) => i.category === "recharge"));
      setPlatformItems(allItems.filter((i) => i.category !== "recharge"));
      setRechargeEdited({});
      setRechargeActiveEdited({});
      setRechargeHasChanges(false);
    } catch {
      setRechargeLoadError(true);
      toast({ title: "Error", description: "Failed to load recharge pricing", variant: "destructive" });
    } finally {
      setRechargeLoading(false);
    }
  }, [toast]);

  /* ── Fetch API pricing ── */
  const fetchApiPricing = useCallback(async () => {
    setApiLoading(true);
    setApiLoadError(false);
    try {
      const res = await api.get<ApiPricingItem[]>("/api/admin/api-pricing");
      const data = res || [];
      setApiPricing(data);
      setApiEdited({});
      setApiHasChanges(false);

      // Extract llm_margin row
      const marginRow = data.find((p) => p.pricingKey === "llm_margin");
      if (marginRow) {
        setLlmMarginId(marginRow.id);
        setLlmMargin(marginRow.marginPercentage || "0");
      } else {
        setLlmMarginId(null);
        setLlmMargin("0");
      }
      setLlmMarginChanged(false);

      // Extract image_margin row
      const imgMarginRow = data.find((p) => p.pricingKey === "image_margin");
      if (imgMarginRow) {
        setImageMarginId(imgMarginRow.id);
        setImageMargin(imgMarginRow.marginPercentage || "0");
      } else {
        setImageMarginId(null);
        setImageMargin("0");
      }
      setImageMarginChanged(false);

      // Extract video_margin row
      const vidMarginRow = data.find((p) => p.pricingKey === "video_margin");
      if (vidMarginRow) {
        setVideoMarginId(vidMarginRow.id);
        setVideoMargin(vidMarginRow.marginPercentage || "0");
      } else {
        setVideoMarginId(null);
        setVideoMargin("0");
      }
      setVideoMarginChanged(false);
    } catch {
      setApiLoadError(true);
      toast({ title: "Error", description: "Failed to load API pricing", variant: "destructive" });
    } finally {
      setApiLoading(false);
    }
  }, [toast]);

  /* ── Fetch GenAI prices for reference ── */
  const fetchGenaiModels = useCallback(async (provider: string) => {
    if (genaiModels[provider]) return; // already loaded
    setGenaiLoading(true);
    try {
      const res = await api.get<{ provider: string; models: GenaiModel[] }>(
        `/api/admin/api-pricing/genai-provider-models?provider=${provider}`
      );
      setGenaiModels((prev) => ({ ...prev, [provider]: res?.models || [] }));
    } catch {
      // silent fail for reference data
    } finally {
      setGenaiLoading(false);
    }
  }, [genaiModels]);

  useEffect(() => { fetchRecharge(); fetchApiPricing(); }, [fetchRecharge, fetchApiPricing]);
  useEffect(() => { fetchGenaiModels(genaiProvider); }, [genaiProvider, fetchGenaiModels]);

  /* ── Fetch image/video pricing reference ── */
  const fetchImagePricingRef = useCallback(async () => {
    try {
      const res = await api.get<typeof imagePricingRef>("/api/admin/api-pricing/image-pricing-reference");
      setImagePricingRef(res || []);
    } catch { /* silent */ }
  }, []);

  const fetchVideoPricingRef = useCallback(async () => {
    try {
      const res = await api.get<typeof videoPricingRef>("/api/admin/api-pricing/video-pricing-reference");
      setVideoPricingRef(res || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchImagePricingRef(); fetchVideoPricingRef(); }, [fetchImagePricingRef, fetchVideoPricingRef]);

  /* ── Recharge handlers ── */
  const handleRechargeCredit = (id: number, value: string) => { setRechargeEdited((p) => ({ ...p, [id]: value })); setRechargeHasChanges(true); };
  const handleRechargeActive = (id: number, value: boolean) => { setRechargeActiveEdited((p) => ({ ...p, [id]: value })); setRechargeHasChanges(true); };

  const saveRecharge = async () => {
    setRechargeSaving(true);
    try {
      const updates = [...rechargeItems, ...platformItems]
        .filter((p) => rechargeEdited[p.id] !== undefined || rechargeActiveEdited[p.id] !== undefined)
        .map((p) => ({
          id: p.id,
          creditsPerUnit: rechargeEdited[p.id] !== undefined ? parseFloat(rechargeEdited[p.id]) : parseFloat(p.creditsPerUnit),
          isActive: rechargeActiveEdited[p.id] !== undefined ? rechargeActiveEdited[p.id] : p.isActive,
        }));
      if (updates.length === 0) { toast({ title: "No changes to save" }); setRechargeSaving(false); return; }
      if (updates.some((update) => !Number.isFinite(update.creditsPerUnit) || update.creditsPerUnit < 0 || update.creditsPerUnit > 100_000_000)) {
        toast({ title: "Invalid pricing", description: "Credits per unit must be between 0 and 100,000,000.", variant: "destructive" });
        return;
      }
      await api.put("/api/admin/credit-pricing/bulk", { updates });
      toast({ title: "Saved", description: `${updates.length} pricing record(s) updated.` });
      await fetchRecharge();
    } catch { toast({ title: "Error", description: "Failed to save", variant: "destructive" }); }
    finally { setRechargeSaving(false); }
  };

  const handleSeedDefaults = async () => {
    try {
      await api.post("/api/admin/credit-pricing/seed");
      toast({ title: "Default pricing seeded!" });
      await fetchRecharge();
    } catch { toast({ title: "Error", description: "Failed to seed defaults", variant: "destructive" }); }
  };

  /* ── LLM Margin handlers ── */
  const saveLlmMargin = async () => {
    const parsedMargin = Number(llmMargin);
    if (!Number.isFinite(parsedMargin) || parsedMargin < -99 || parsedMargin > 999.99) {
      toast({ title: "Invalid margin", description: "Margin must be between -99% and 999.99%.", variant: "destructive" });
      return;
    }
    setLlmMarginSaving(true);
    try {
      if (llmMarginId) {
        await api.put(`/api/admin/api-pricing/${llmMarginId}`, { marginPercentage: llmMargin });
      } else {
        await api.post("/api/admin/api-pricing", {
          category: "llm_model",
          pricingKey: "llm_margin",
          name: "LLM Models Margin",
          marginPercentage: llmMargin,
        });
      }
      toast({ title: "Saved!", description: "LLM margin updated." });
      setLlmMarginChanged(false);
      await fetchApiPricing();
    } catch { toast({ title: "Error", description: "Failed to save LLM margin", variant: "destructive" }); }
    finally { setLlmMarginSaving(false); }
  };

  /* ── Image Margin handlers ── */
  const saveImageMargin = async () => {
    const parsedMargin = Number(imageMargin);
    if (!Number.isFinite(parsedMargin) || parsedMargin < -99 || parsedMargin > 999.99) {
      toast({ title: "Invalid margin", description: "Margin must be between -99% and 999.99%.", variant: "destructive" });
      return;
    }
    setImageMarginSaving(true);
    try {
      if (imageMarginId) {
        await api.put(`/api/admin/api-pricing/${imageMarginId}`, { marginPercentage: imageMargin });
      } else {
        await api.post("/api/admin/api-pricing", {
          category: "image_generation",
          pricingKey: "image_margin",
          name: "Image Generation Margin",
          marginPercentage: imageMargin,
        });
      }
      toast({ title: "Saved!", description: "Image generation margin updated." });
      setImageMarginChanged(false);
      await fetchApiPricing();
      await fetchImagePricingRef();
    } catch { toast({ title: "Error", description: "Failed to save Image margin", variant: "destructive" }); }
    finally { setImageMarginSaving(false); }
  };

  /* ── Video Margin handlers ── */
  const saveVideoMargin = async () => {
    const parsedMargin = Number(videoMargin);
    if (!Number.isFinite(parsedMargin) || parsedMargin < -99 || parsedMargin > 999.99) {
      toast({ title: "Invalid margin", description: "Margin must be between -99% and 999.99%.", variant: "destructive" });
      return;
    }
    setVideoMarginSaving(true);
    try {
      if (videoMarginId) {
        await api.put(`/api/admin/api-pricing/${videoMarginId}`, { marginPercentage: videoMargin });
      } else {
        await api.post("/api/admin/api-pricing", {
          category: "video_generation",
          pricingKey: "video_margin",
          name: "Video Generation Margin",
          marginPercentage: videoMargin,
        });
      }
      toast({ title: "Saved!", description: "Video generation margin updated." });
      setVideoMarginChanged(false);
      await fetchApiPricing();
      await fetchVideoPricingRef();
    } catch { toast({ title: "Error", description: "Failed to save Video margin", variant: "destructive" }); }
    finally { setVideoMarginSaving(false); }
  };

  /* ── API pricing handlers ── */
  const handleApiField = (id: number, field: string, value: string | boolean) => {
    setApiEdited((p) => ({ ...p, [id]: { ...p[id], [field]: value } }));
    setApiHasChanges(true);
  };

  const getApiVal = (item: ApiPricingItem, field: keyof ApiPricingItem): string => {
    const e = apiEdited[item.id];
    if (e && field in e) return String(e[field as keyof typeof e]);
    return String(item[field] ?? "");
  };

  const saveApiPricing = async () => {
    setApiSaving(true);
    try {
      const updates = Object.entries(apiEdited).map(([idStr, fields]) => ({ id: parseInt(idStr), ...fields }));
      if (updates.length === 0) { toast({ title: "No changes to save" }); setApiSaving(false); return; }
      const numericFields = [
        "promptCostPerMillion",
        "completionCostPerMillion",
        "creditsPerUnit",
        "marginPercentage",
        "originalPromptCostPerMillion",
        "originalCompletionCostPerMillion",
        "originalCreditsPerUnit",
      ];
      const invalid = updates.some((update) => numericFields.some((field) => {
        const value = update[field as keyof typeof update];
        if (value === undefined) return false;
        const numeric = Number(value);
        const minimum = field === "marginPercentage" ? -99 : 0;
        const maximum = field === "marginPercentage" ? 999.99 : 100_000_000;
        return !Number.isFinite(numeric) || numeric < minimum || numeric > maximum;
      }));
      if (invalid) {
        toast({ title: "Invalid API pricing", description: "Review the edited amount and margin fields before saving.", variant: "destructive" });
        return;
      }
      await api.put("/api/admin/api-pricing/bulk", { updates });
      toast({ title: "Saved!", description: `${updates.length} pricing record(s) updated.` });
      await fetchApiPricing();
    } catch { toast({ title: "Error", description: "Failed to save", variant: "destructive" }); }
    finally { setApiSaving(false); }
  };

  const nonLlmPricing = NON_LLM_CATEGORIES.reduce<Record<string, ApiPricingItem[]>>((acc, cat) => {
    const items = apiPricing.filter((p) => p.category === cat);
    if (items.length > 0) acc[cat] = items;
    return acc;
  }, {});

  const currentGenaiModels = genaiModels[genaiProvider] || [];
  const marginNum = parseFloat(llmMargin) || 0;
  const multiplier = 1 + marginNum / 100;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* ─── Header ─── */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
          <Coins className="h-6 w-6 text-purple-600 dark:text-purple-400" />
          Credit & API Pricing
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure customer credit rates, provider costs, and margins in one place. Model reference prices are sourced automatically from genai-prices.
        </p>
      </div>

      {/* ─── SECTION 1: Recharge Rules ─── */}
      <div id="recharge-rules" className="scroll-mt-24 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Coins className="w-5 h-5 text-amber-500" /> Recharge Rules
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSeedDefaults} className="gap-1">
            <Sparkles className="w-4 h-4" /> Seed Defaults
          </Button>
          <Button variant="outline" size="sm" onClick={fetchRecharge} className="gap-1">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          <Button size="sm" onClick={saveRecharge} loading={rechargeSaving} loadingText="Saving…" disabled={!rechargeHasChanges} className="gap-1 bg-purple-600 hover:bg-purple-700">
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </div>

      {rechargeLoading ? (
        <LoadingState size="section" label="Loading recharge pricing…" />
      ) : rechargeLoadError ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex flex-col items-center py-8 text-center">
            <AlertCircle className="mb-3 h-8 w-8 text-destructive" />
            <p className="font-medium">Recharge pricing could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">Existing pricing has not been changed.</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchRecharge}>Try again</Button>
          </CardContent>
        </Card>
      ) : rechargeItems.length === 0 ? (
        <Card>
          <CardContent className="text-center py-8">
            <Coins className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No recharge rules configured</p>
            <p className="text-sm text-muted-foreground mt-1 mb-3">Click &quot;Seed Defaults&quot; to create them.</p>
            <Button onClick={handleSeedDefaults} size="sm" className="gap-1 bg-purple-600 hover:bg-purple-700"><Sparkles className="w-4 h-4" /> Seed</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[250px]">Event</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[150px]">Credits/Unit</TableHead>
                  <TableHead className="w-[100px]">Unit</TableHead>
                  <TableHead className="w-[80px] text-center">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rechargeItems].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{item.name}</span>
                        <Badge variant="outline" className="text-xs font-mono">{item.eventKey}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.description}</TableCell>
                    <TableCell>
                      <Input type="number" step="0.1" min="0" value={rechargeEdited[item.id] !== undefined ? rechargeEdited[item.id] : item.creditsPerUnit} onChange={(e) => handleRechargeCredit(item.id, e.target.value)} className="w-[120px] text-right font-mono" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.unitLabel}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked={rechargeActiveEdited[item.id] !== undefined ? rechargeActiveEdited[item.id] : item.isActive} onCheckedChange={(v) => handleRechargeActive(item.id, v)} aria-label={`Toggle ${item.name}`} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* ─── SECTION 2: API Pricing ─── */}
      <div id="api-pricing" className="scroll-mt-24 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Settings className="w-5 h-5 text-purple-500" /> API Costs & Customer Pricing
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchApiPricing} className="gap-1">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          <Button size="sm" onClick={saveApiPricing} loading={apiSaving} loadingText="Saving…" disabled={apiLoadError || !apiHasChanges} className="gap-1 bg-purple-600 hover:bg-purple-700">
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </div>

      {apiLoadError && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex flex-col items-center py-8 text-center">
            <AlertCircle className="mb-3 h-8 w-8 text-destructive" />
            <p className="font-medium">API pricing could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">Pricing controls are unavailable until the records reload successfully.</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchApiPricing}>Try again</Button>
          </CardContent>
        </Card>
      )}

      {/* ─── LLM Pricing (margin based) ─── */}
      <Card id="llm-pricing" className="scroll-mt-24">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <Brain className="w-5 h-5" />
              <div>
                <CardTitle className="text-lg">LLM Model Pricing</CardTitle>
                <CardDescription>
                  Model costs are sourced automatically from <code className="text-xs bg-muted px-1 py-0.5 rounded">@pydantic/genai-prices</code>.
                  Set a margin percentage that is applied on top of the base cost.
                  Formula: <strong>genai-price + (genai-price &times; margin%) = cost charged to user</strong>
                </CardDescription>
              </div>
            </div>
            <Button
              size="sm"
              onClick={saveLlmMargin}
              loading={llmMarginSaving}
              loadingText="Saving…"
              disabled={apiLoadError || !llmMarginChanged}
              className="gap-1 bg-purple-600 hover:bg-purple-700"
            >
              <Save className="w-4 h-4" />
              Save Margin
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <Label className="whitespace-nowrap font-medium">LLM Margin %</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="1"
                min="0"
                className="w-24"
                value={llmMargin}
                onChange={(e) => { setLlmMargin(e.target.value); setLlmMarginChanged(true); }}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {marginNum > 0 && (
              <span className="text-xs text-muted-foreground">
                e.g. ₹10/1M &rarr; ₹{(10 * multiplier).toFixed(2)}/1M charged
              </span>
            )}
          </div>

          <Separator />

          <div>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium text-muted-foreground">
                Reference: Model base prices (read-only)
              </p>
              <Select value={genaiProvider} onValueChange={setGenaiProvider}>
                <SelectTrigger className="h-8 w-full sm:w-40" aria-label="Choose model provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENAI_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>{GENAI_PROVIDER_LABELS[p] || p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {genaiLoading && !genaiModels[genaiProvider] ? (
              <LoadingState size="section" className="py-4" label="Loading models…" />
            ) : currentGenaiModels.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No models found for this provider.</p>
            ) : (
              <div className="max-h-[400px] overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[220px]">Model</TableHead>
                      <TableHead className="w-[130px] text-right">Input ₹/1M</TableHead>
                      <TableHead className="w-[130px] text-right">Output ₹/1M</TableHead>
                      {marginNum > 0 && (
                        <>
                          <TableHead className="w-[130px] text-right">Charged Input</TableHead>
                          <TableHead className="w-[130px] text-right">Charged Output</TableHead>
                        </>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentGenaiModels
                      .filter((m) => m.inputPerMillion > 0 || m.outputPerMillion > 0)
                      .sort((a, b) => a.id.localeCompare(b.id))
                      .map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>
                            <span className="font-medium text-sm">{m.name}</span>
                            {m.name !== m.id && <span className="text-xs text-muted-foreground ml-1">({m.id})</span>}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">₹{m.inputPerMillion.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">₹{m.outputPerMillion.toFixed(2)}</TableCell>
                          {marginNum > 0 && (
                            <>
                              <TableCell className="text-right font-mono text-xs text-purple-600">₹{(m.inputPerMillion * multiplier).toFixed(2)}</TableCell>
                              <TableCell className="text-right font-mono text-xs text-purple-600">₹{(m.outputPerMillion * multiplier).toFixed(2)}</TableCell>
                            </>
                          )}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Image Generation Pricing (margin based) ─── */}
      <Card id="image-pricing" className="scroll-mt-24">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <Image className="w-5 h-5" />
              <div>
                <CardTitle className="text-lg">Image Generation Pricing</CardTitle>
                <CardDescription>
                  Image costs are based on actual Google model pricing (per image).
                  Set a margin percentage that is applied on top of the base cost.
                  Formula: <strong>model price + (model price &times; margin%) = cost charged to user</strong>
                </CardDescription>
              </div>
            </div>
            <Button
              size="sm"
              onClick={saveImageMargin}
              loading={imageMarginSaving}
              loadingText="Saving…"
              disabled={apiLoadError || !imageMarginChanged}
              className="gap-1 bg-purple-600 hover:bg-purple-700"
            >
              <Save className="w-4 h-4" />
              Save Margin
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <Label className="whitespace-nowrap font-medium">Image Margin %</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="1"
                min="0"
                className="w-24"
                value={imageMargin}
                onChange={(e) => { setImageMargin(e.target.value); setImageMarginChanged(true); }}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {parseFloat(imageMargin) > 0 && (
              <span className="text-xs text-muted-foreground">
                e.g. ₹0.034/image &rarr; ₹{(0.034 * (1 + parseFloat(imageMargin) / 100)).toFixed(4)}/image charged
              </span>
            )}
          </div>

          <Separator />

          <div>
            <p className="text-sm font-medium text-muted-foreground mb-3">
              Reference: Image model base prices (read-only)
            </p>
            {imagePricingRef.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading image model prices...</p>
            ) : (
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Model</TableHead>
                      <TableHead className="w-[140px]">Resolution</TableHead>
                      <TableHead className="w-[110px] text-right">Base ₹/Image</TableHead>
                      {parseFloat(imageMargin) > 0 && (
                        <TableHead className="w-[110px] text-right">Charged ₹/Image</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {imagePricingRef.flatMap((m) =>
                      m.resolutionTiers.map((t, idx) => (
                        <TableRow key={`${m.modelId}-${t.resolution}`}>
                          {idx === 0 ? (
                            <TableCell rowSpan={m.resolutionTiers.length} className="align-top">
                              <span className="font-medium text-sm">{m.name}</span>
                              <span className="text-xs text-muted-foreground block">({m.modelId})</span>
                            </TableCell>
                          ) : null}
                          <TableCell className="text-sm">{t.label}</TableCell>
                          <TableCell className="text-right font-mono text-xs">₹{t.basePriceINR.toFixed(2)}</TableCell>
                          {parseFloat(imageMargin) > 0 && (
                            <TableCell className="text-right font-mono text-xs text-purple-600">₹{t.chargedPriceINR.toFixed(2)}</TableCell>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Video Generation Pricing (margin based) ─── */}
      <Card id="video-pricing" className="scroll-mt-24">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <Video className="w-5 h-5" />
              <div>
                <CardTitle className="text-lg">Video Generation Pricing</CardTitle>
                <CardDescription>
                  Video costs are based on actual Google model pricing (per second of generated video).
                  Set a margin percentage that is applied on top of the base cost.
                  Formula: <strong>model price/sec &times; duration &times; (1 + margin%) = cost charged to user</strong>
                </CardDescription>
              </div>
            </div>
            <Button
              size="sm"
              onClick={saveVideoMargin}
              loading={videoMarginSaving}
              loadingText="Saving…"
              disabled={apiLoadError || !videoMarginChanged}
              className="gap-1 bg-purple-600 hover:bg-purple-700"
            >
              <Save className="w-4 h-4" />
              Save Margin
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <Label className="whitespace-nowrap font-medium">Video Margin %</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="1"
                min="0"
                className="w-24"
                value={videoMargin}
                onChange={(e) => { setVideoMargin(e.target.value); setVideoMarginChanged(true); }}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {parseFloat(videoMargin) > 0 && (
              <span className="text-xs text-muted-foreground">
                e.g. ₹0.40/sec &rarr; ₹{(0.40 * (1 + parseFloat(videoMargin) / 100)).toFixed(4)}/sec charged (8s video = ₹{(0.40 * 8 * (1 + parseFloat(videoMargin) / 100)).toFixed(2)})
              </span>
            )}
          </div>

          <Separator />

          <div>
            <p className="text-sm font-medium text-muted-foreground mb-3">
              Reference: Video model base prices (read-only)
            </p>
            {videoPricingRef.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading video model prices...</p>
            ) : (
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Model</TableHead>
                      <TableHead className="w-[140px]">Resolution</TableHead>
                      <TableHead className="w-[110px] text-right">Base ₹/Second</TableHead>
                      {parseFloat(videoMargin) > 0 && (
                        <TableHead className="w-[110px] text-right">Charged ₹/Second</TableHead>
                      )}
                      <TableHead className="w-[120px] text-right">Cost per 8s</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {videoPricingRef.flatMap((m) =>
                      m.resolutionTiers.map((t, idx) => (
                        <TableRow key={`${m.modelId}-${t.resolution}`}>
                          {idx === 0 ? (
                            <TableCell rowSpan={m.resolutionTiers.length} className="align-top">
                              <span className="font-medium text-sm">{m.name}</span>
                              <span className="text-xs text-muted-foreground block">({m.modelId})</span>
                            </TableCell>
                          ) : null}
                          <TableCell className="text-sm">{t.label}</TableCell>
                          <TableCell className="text-right font-mono text-xs">₹{t.basePricePerSecondINR.toFixed(2)}</TableCell>
                          {parseFloat(videoMargin) > 0 && (
                            <TableCell className="text-right font-mono text-xs text-purple-600">₹{t.chargedPricePerSecondINR.toFixed(2)}</TableCell>
                          )}
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">₹{(t.chargedPricePerSecondINR * 8).toFixed(2)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── Other API Pricing (non-LLM) ─── */}
      <section id="other-api-pricing" className="scroll-mt-24 space-y-4" aria-labelledby="other-api-pricing-title">
        <div>
          <h2 id="other-api-pricing-title" className="text-lg font-semibold">Other Provider Pricing</h2>
          <p className="mt-1 text-sm text-muted-foreground">Configure Apify margins and ZeroBounce provider and customer credit rates.</p>
        </div>
        {apiLoading ? (
          <LoadingState size="section" label="Loading provider pricing…" />
        ) : (
          Object.entries(nonLlmPricing).map(([category, items]) => {
          const config = API_CATEGORY_CONFIG[category] || { label: category, icon: null, description: "" };

          return (
            <Card key={category}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  {config.icon}
                  <div>
                    <CardTitle className="text-lg">{config.label}</CardTitle>
                    <CardDescription>{config.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[250px]">Name</TableHead>
                      {category === "apify" ? (
                        <TableHead className="w-[200px]">Margin %</TableHead>
                      ) : (
                        <>
                          <TableHead className="w-[180px]">Provider Cost (credits/unit)</TableHead>
                          <TableHead className="w-[180px]">Customer Price (credits/unit)</TableHead>
                        </>
                      )}
                      <TableHead className="w-[80px] text-center">Active</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <span className="font-medium">{item.name}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{item.unitLabel || (category === "apify" ? "percentage margin on provider cost" : "credits per provider unit")}</span>
                        </TableCell>
                        {category === "apify" ? (
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Input type="number" step="1" className="w-24 h-8" value={getApiVal(item, "marginPercentage")} onChange={(e) => handleApiField(item.id, "marginPercentage", e.target.value)} />
                              <span className="text-sm text-muted-foreground">%</span>
                            </div>
                          </TableCell>
                        ) : (
                          <>
                            <TableCell><Input type="number" step="1" className="w-24 h-8" value={getApiVal(item, "originalCreditsPerUnit")} onChange={(e) => handleApiField(item.id, "originalCreditsPerUnit", e.target.value)} /></TableCell>
                            <TableCell><Input type="number" step="1" className="w-24 h-8" value={getApiVal(item, "creditsPerUnit")} onChange={(e) => handleApiField(item.id, "creditsPerUnit", e.target.value)} /></TableCell>
                          </>
                        )}
                        <TableCell className="text-center"><Switch checked={apiEdited[item.id]?.isActive !== undefined ? apiEdited[item.id].isActive as boolean : item.isActive} onCheckedChange={(v) => handleApiField(item.id, "isActive", v)} aria-label={`Toggle ${item.name}`} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
          })
        )}
      </section>

      <Separator />

      {/* ─── SECTION 3: Platform Pricing Events ─── */}
      <div id="platform-pricing-events" className="scroll-mt-24 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Coins className="w-5 h-5 text-blue-500" /> Platform Pricing Events
        </h2>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={saveRecharge} loading={rechargeSaving} loadingText="Saving…" disabled={!rechargeHasChanges} className="gap-1 bg-purple-600 hover:bg-purple-700">
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </div>

      {rechargeLoading ? (
        <LoadingState size="section" label="Loading platform pricing events…" />
      ) : rechargeLoadError ? null : platformItems.length === 0 ? (
        <Card>
          <CardContent className="text-center py-8">
            <Coins className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No platform pricing events configured</p>
            <p className="text-sm text-muted-foreground mt-1 mb-3">Click &quot;Seed Defaults&quot; above to create them.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Event</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[100px]">Category</TableHead>
                  <TableHead className="w-[150px]">Credits/Unit</TableHead>
                  <TableHead className="w-[100px]">Unit</TableHead>
                  <TableHead className="w-[80px] text-center">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...platformItems].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{item.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.description}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs capitalize">{item.category}</Badge>
                    </TableCell>
                    <TableCell>
                      <Input type="number" step="0.1" min="0" value={rechargeEdited[item.id] !== undefined ? rechargeEdited[item.id] : item.creditsPerUnit} onChange={(e) => handleRechargeCredit(item.id, e.target.value)} className="w-[120px] text-right font-mono" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.unitLabel}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked={rechargeActiveEdited[item.id] !== undefined ? rechargeActiveEdited[item.id] : item.isActive} onCheckedChange={(v) => handleRechargeActive(item.id, v)} aria-label={`Toggle ${item.name}`} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
