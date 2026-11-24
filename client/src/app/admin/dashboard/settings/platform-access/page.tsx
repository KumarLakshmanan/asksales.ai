"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Save, ShieldCheck, Wrench } from "lucide-react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PlatformModuleKey, PlatformModuleStatus } from "@/lib/platform-access";

interface AdminPlatformModule {
  moduleKey: PlatformModuleKey;
  name: string;
  description: string;
  status: PlatformModuleStatus;
  statusMessage: string | null;
  sortOrder: number;
}

interface Controls {
  maintenance: { enabled: boolean; message: string };
  modules: AdminPlatformModule[];
}

export default function PlatformAccessSettingsPage() {
  const { toast } = useToast();
  const [controls, setControls] = useState<Controls | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setControls(await api.get<Controls>("/api/admin/platform-access"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load platform controls");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!controls) return;
    try {
      setSaving(true);
      setControls(await api.put<Controls>("/api/admin/platform-access", {
        maintenance: controls.maintenance,
        modules: controls.modules.map((module) => ({
          key: module.moduleKey,
          status: module.status,
          message: module.statusMessage,
        })),
      }));
      toast({ title: "Platform access updated", description: "The API and client now use the new availability state." });
    } catch (saveError) {
      toast({
        title: "Update failed",
        description: saveError instanceof Error ? saveError.message : "Failed to update platform controls",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingState size="page" label="Loading platform access controls…" />;
  }

  if (error || !controls) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Platform controls could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{error || "The server returned no configuration."}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  const unavailableModules = controls.modules.filter((module) => module.status !== "available");

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Platform access</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Control global maintenance and module readiness. Changes are enforced by the API and recorded in an immutable audit trail.
          </p>
        </div>
        <Button onClick={() => void save()} loading={saving} loadingText="Save controls" className="w-full sm:w-auto">
          <Save className="mr-2 h-4 w-4" />
          Save controls
        </Button>
      </header>

      <Card className={controls.maintenance.enabled ? "border-amber-500/50" : "border-border/70"}>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-400"><Wrench className="h-5 w-5" /></div>
              <div><CardTitle className="text-base">Global maintenance</CardTitle><CardDescription className="mt-1">Blocks customer API and dashboard access while preserving admin recovery, auth, OAuth, legal, and signed webhooks.</CardDescription></div>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="maintenance">{controls.maintenance.enabled ? "Enabled" : "Disabled"}</Label>
              <Switch id="maintenance" checked={controls.maintenance.enabled} onCheckedChange={(enabled) => setControls({ ...controls, maintenance: { ...controls.maintenance, enabled } })} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Label htmlFor="maintenance-message">Customer message</Label>
          <Textarea id="maintenance-message" value={controls.maintenance.message} maxLength={500} rows={3} className="mt-2" onChange={(event) => setControls({ ...controls, maintenance: { ...controls.maintenance, message: event.target.value } })} />
          <p className="mt-1 text-xs text-muted-foreground">{controls.maintenance.message.length}/500 characters</p>
        </CardContent>
      </Card>

      {unavailableModules.length > 0 && (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle>Some client areas are unavailable</AlertTitle>
          <AlertDescription className="mt-2 space-y-1">
            <p>
              {unavailableModules.map((module) => `${module.name} (${module.status})`).join(", ")}.
              These global states hide the matching client sidebar sections and block their API routes for every account;
              account-level overrides cannot bypass them.
            </p>
            {unavailableModules.some((module) => module.moduleKey === "ai_visibility") && (
              <p>
                AI Visibility controls the SEO, AEO, GEO, commerce, competitor, fixes, assets, and report pages.
                Mark it Available only after the provider and credit settings are ready.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      <section>
        <div className="mb-3 flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="text-base font-semibold">Module readiness</h2></div>
        <div className="grid gap-4 lg:grid-cols-2">
          {controls.modules.map((module, index) => (
            <Card key={module.moduleKey} className="border-border/70 shadow-none">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div><CardTitle className="text-sm">{module.name}</CardTitle><CardDescription className="mt-1 leading-5">{module.description}</CardDescription></div>
                  <Select value={module.status} onValueChange={(status: PlatformModuleStatus) => {
                    const modules = [...controls.modules];
                    modules[index] = { ...module, status };
                    setControls({ ...controls, modules });
                  }}>
                    <SelectTrigger className="w-full sm:w-36" aria-label={`${module.name} status`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="available">Available</SelectItem><SelectItem value="maintenance">Maintenance</SelectItem><SelectItem value="disabled">Disabled</SelectItem></SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                <Label htmlFor={`message-${module.moduleKey}`}>Availability message</Label>
                <Textarea id={`message-${module.moduleKey}`} value={module.statusMessage || ""} maxLength={500} rows={2} className="mt-2" placeholder="Optional message shown when unavailable" onChange={(event) => {
                  const modules = [...controls.modules];
                  modules[index] = { ...module, statusMessage: event.target.value || null };
                  setControls({ ...controls, modules });
                }} />
                {module.status !== "available" && (
                  <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
                    This status hides the module from customer navigation and blocks its API routes globally.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
