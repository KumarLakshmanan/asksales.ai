"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { api } from "@/lib/admin-api";

interface Actor {
  id: string;
  name: string;
  description?: string;
}

interface ApifyCredentialFormProps {
  credentialId?: number;
}

export default function ApifyCredentialForm({ credentialId }: ApifyCredentialFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [loading, setLoading] = useState(!!credentialId);
  const [submitting, setSubmitting] = useState(false);
  const [actors, setActors] = useState<Actor[]>([]);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
    accountName?: string;
  } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const [formName, setFormName] = useState("Apify API Key");
  const [formApiKey, setFormApiKey] = useState("");
  const [formPriority, setFormPriority] = useState("normal");
  const [assignMode, setAssignMode] = useState<"all" | "specific">("all");
  const [formAssignedActors, setFormAssignedActors] = useState<string[]>([]);

  const fetchActors = useCallback(async () => {
    try {
      const data = await api.get<{ actors: Actor[] }>("/api/admin/leadflow/actors");
      setActors(data.actors || []);
    } catch {
      // actors are optional
    }
  }, []);

  useEffect(() => {
    fetchActors();
    if (!credentialId) return;

    const fetchCredential = async () => {
      try {
        const data = await api.get<unknown>(`/api/admin/integrations/${credentialId}/full`);
        const cred = ((data as Record<string, unknown>)?.credential as Record<string, unknown>) || (data as Record<string, unknown>);
        setFormName((cred?.name as string) || "Apify API Key");
        setFormApiKey("");
        setFormPriority((cred?.priority as string) || "normal");
        const config = cred?.config as Record<string, unknown> | undefined;
        const savedActors = (config?.assignedActors as string[]) || [];
        setFormAssignedActors(savedActors);
        setAssignMode(savedActors.length > 0 ? "specific" : "all");
      } catch {
        toast({ title: "Error", description: "Failed to load credential", variant: "destructive" });
        router.push("/admin/dashboard/integrations/apify");
      } finally {
        setLoading(false);
      }
    };
    fetchCredential();
  }, [credentialId, router, toast, fetchActors]);

  const validateApiKey = async (apiKey: string) => {
    if (!apiKey || apiKey.length < 10) return;
    try {
      setValidating(true);
      setValidationResult(null);
      const data = await api.post<unknown>("/api/admin/integrations/validate", { platform: "apify", apiKey });
      const validationData = ((data as Record<string, unknown>)?.validation as Record<string, unknown>) || (data as Record<string, unknown>);
      const validation = {
        success: validationData.success === true,
        message: typeof validationData.message === "string" ? validationData.message : validationData.success === true ? "API key is valid" : "API key validation failed",
        accountName: typeof validationData.accountName === "string" ? validationData.accountName : undefined,
      };
      setValidationResult(validation);
      if (validation.success && validation.accountName) setFormName(validation.accountName);
    } catch {
      setValidationResult({ success: false, message: "Failed to validate API key" });
    } finally {
      setValidating(false);
    }
  };

  const toggleActorAssignment = (actorId: string) => {
    setFormAssignedActors((prev) =>
      prev.includes(actorId) ? prev.filter((id) => id !== actorId) : [...prev, actorId]
    );
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast({ title: "Error", description: "Name is required", variant: "destructive" });
      return;
    }
    if (!credentialId && !formApiKey) {
      toast({ title: "Error", description: "API key is required", variant: "destructive" });
      return;
    }
    try {
      setSubmitting(true);
      const config: Record<string, unknown> = {};
      if (assignMode === "specific" && formAssignedActors.length > 0) config.assignedActors = formAssignedActors;

      const payload: Record<string, unknown> = {
        platform: "apify",
        name: formName,
        priority: formPriority,
        config,
      };
      if (formApiKey) payload.apiKey = formApiKey;

      if (credentialId) {
        await api.put(`/api/admin/integrations/${credentialId}`, payload);
      } else {
        await api.post("/api/admin/integrations", payload);
      }

      toast({
        title: "Success",
        description: credentialId ? "API key updated successfully" : "API key added successfully",
      });
      router.push("/admin/dashboard/integrations/apify");
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: (error as Error).message || "Failed to save API key",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-[400px]" label="Loading Apify credential…" />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/admin/dashboard/integrations/apify")}
          className="shrink-0"
          aria-label="Back to Apify credentials"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight sm:text-2xl">
            {credentialId ? "Edit" : "Add"} Apify API Key
          </h1>
          <p className="text-muted-foreground text-sm">
            Web scraping and data extraction for lead generation
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{credentialId ? "Update" : "New"} API Key</CardTitle>
          <CardDescription>
            {credentialId
              ? "Update your Apify API key settings and actor assignments."
              : "Add a new Apify API key. You can assign it to specific actors."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="My Apify Key"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">
                API Key
                {credentialId && (
                  <span className="ml-1 text-muted-foreground font-normal text-xs">(leave blank to keep existing)</span>
                )}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Input
                    id="apiKey"
                    type={showApiKey ? "text" : "password"}
                    placeholder="apify_api_..."
                    className="pr-10"
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    onBlur={() => {
                      if (!credentialId && formApiKey) validateApiKey(formApiKey);
                    }}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {!credentialId && (
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
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
                <div className={`text-sm ${validationResult.success ? "text-green-600" : "text-red-600"}`}>
                  {validationResult.message}
                  {validationResult.success && validationResult.accountName && (
                    <span className="block text-muted-foreground">Account: {validationResult.accountName}</span>
                  )}
                </div>
              )}
            </div>

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
              <p className="text-xs text-muted-foreground">Higher priority keys are tried first</p>
            </div>

            <div className="space-y-3">
              <Label>Actor Assignment</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setAssignMode("all"); setFormAssignedActors([]); }}
                  className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    assignMode === "all"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-foreground border-border hover:bg-muted"
                  }`}
                >
                  All Actors
                </button>
                <button
                  type="button"
                  onClick={() => setAssignMode("specific")}
                  className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    assignMode === "specific"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-foreground border-border hover:bg-muted"
                  }`}
                >
                  Specific Actors
                </button>
              </div>
              {assignMode === "all" ? (
                <p className="text-xs text-muted-foreground">
                  This key will be used as the default for all Apify actors. If it becomes inactive or expired, other active keys will be tried.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Select the Apify actors that should use this specific key. If this key becomes inactive or expired, the default key will be used automatically.
                  </p>
                  {actors.length > 0 ? (
                    <div className="border rounded-lg p-3 max-h-48 overflow-y-auto space-y-2">
                      {actors.map((actor) => (
                        <label
                          key={actor.id}
                          className="flex items-center gap-3 cursor-pointer hover:bg-muted/50 p-1.5 rounded-md transition-colors"
                        >
                          <Checkbox
                            checked={formAssignedActors.includes(actor.id)}
                            onCheckedChange={() => toggleActorAssignment(actor.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium">{actor.name}</span>
                            {actor.description && (
                              <p className="text-xs text-muted-foreground truncate">{actor.description}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic p-3 border rounded-lg">
                      No actors found. Actors will appear here once configured.
                    </p>
                  )}
                  {formAssignedActors.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {formAssignedActors.map((a) => (
                        <Badge key={a} variant="secondary" className="text-xs">
                          {actors.find((ac) => ac.id === a)?.name || a}
                          <button
                            type="button"
                            className="ml-1 hover:text-destructive"
                            onClick={() => toggleActorAssignment(a)}
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
              <Button type="submit" loading={submitting} className="w-full sm:w-auto">
                {credentialId ? "Update API Key" : "Add API Key"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/admin/dashboard/integrations/apify")}
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
