"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Eye, EyeOff, CheckCircle, XCircle } from "lucide-react";
import { api } from "@/lib/admin-api";

export default function CustomAIAddPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ success: boolean; message: string } | null>(null);

  const [formName, setFormName] = useState("Custom AI Provider");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formPriority, setFormPriority] = useState("normal");
  const [showApiKey, setShowApiKey] = useState(false);

  const validateConnection = async () => {
    if (!formBaseUrl || !formApiKey) {
      toast({ title: "Error", description: "Base URL and API Key are required to validate", variant: "destructive" });
      return;
    }
    try {
      setValidating(true);
      setValidationResult(null);
      const data = await api.post<{ validation?: { success: boolean; message: string; accountName?: string }; success?: boolean; message?: string }>("/api/admin/integrations/validate", { platform: "custom_ai", apiKey: formApiKey, baseUrl: formBaseUrl, model: formModel });
      const validation = data.validation || data;
      setValidationResult(validation as { success: boolean; message: string });
      if ((validation as { success: boolean; accountName?: string }).success && (validation as { accountName?: string }).accountName) {
        setFormName((validation as { accountName: string }).accountName);
      }
    } catch {
      setValidationResult({ success: false, message: "Failed to validate connection" });
    } finally {
      setValidating(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) { toast({ title: "Error", description: "Name is required", variant: "destructive" }); return; }
    if (!formBaseUrl.trim()) { toast({ title: "Error", description: "Base URL is required", variant: "destructive" }); return; }
    if (!formApiKey.trim()) { toast({ title: "Error", description: "API Key is required", variant: "destructive" }); return; }

    try {
      setSubmitting(true);
      const payload = {
        platform: "custom_ai",
        name: formName,
        apiKey: formApiKey,
        priority: formPriority,
        config: { baseUrl: formBaseUrl, model: formModel || undefined },
      };
      await api.post("/api/admin/integrations", payload);
      toast({ title: "Success", description: "Custom AI provider added successfully" });
      router.push("/admin/dashboard/integrations/llm");
    } catch (error: unknown) {
      toast({ title: "Error", description: (error as Error).message || "Failed to save", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back to AI integrations" onClick={() => router.push("/admin/dashboard/integrations/llm")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Add Custom AI Provider</h1>
          <p className="text-muted-foreground text-sm">Connect any OpenAI-compatible API endpoint</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Custom AI Credential</CardTitle>
          <CardDescription>
            Enter your custom AI provider details. The endpoint must be compatible with the OpenAI chat completions API format.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" placeholder="My Custom AI Provider" value={formName} onChange={(e) => setFormName(e.target.value)} />
              <p className="text-xs text-muted-foreground">A friendly name to identify this provider</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="baseUrl">API Base URL</Label>
              <Input id="baseUrl" type="url" placeholder="https://api.example.com/v1" value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} />
              <p className="text-xs text-muted-foreground">The base URL of the OpenAI-compatible API (e.g., https://api.example.com/v1)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Input
                    id="apiKey"
                    type={showApiKey ? "text" : "password"}
                    placeholder="Enter API key"
                    className="pr-10"
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <Button type="button" variant="outline" className="shrink-0" onClick={validateConnection} loading={validating} loadingText="Validating…" disabled={!formApiKey || !formBaseUrl}>
                  Validate
                </Button>
              </div>
              {validationResult && (
                <div className={`flex items-center gap-2 text-sm ${validationResult.success ? "text-green-600" : "text-red-600"}`}>
                  {validationResult.success ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {validationResult.message}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Default Model (optional)</Label>
              <Input id="model" placeholder="e.g., gpt-4, llama-3, custom-model-name" value={formModel} onChange={(e) => setFormModel(e.target.value)} />
              <p className="text-xs text-muted-foreground">The default model to use. Leave blank to use the endpoint&apos;s default.</p>
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
              <p className="text-xs text-muted-foreground">Higher priority keys are tried first when multiple keys are configured</p>
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
              <Button type="submit" loading={submitting} className="w-full sm:w-auto">
                Add Custom AI Provider
              </Button>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => router.push("/admin/dashboard/integrations/llm")}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
