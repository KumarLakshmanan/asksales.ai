"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PlatformAccessModule, UserModuleMode } from "@/lib/platform-access";

interface UserModuleResponse {
  user: { id: number; name: string; email: string };
  modules: PlatformAccessModule[];
}

export default function UserModulesPage() {
  const id = String(useParams().id);
  const { toast } = useToast();
  const [data, setData] = useState<UserModuleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setData(await api.get<UserModuleResponse>(`/api/admin/users/${id}/modules`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load module access");
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!data) return;
    try {
      setSaving(true);
      setData(await api.put<UserModuleResponse>(`/api/admin/users/${id}/modules`, {
        modules: data.modules.map((module) => ({ key: module.key, mode: module.mode })),
      }));
      toast({ title: "Module access updated", description: `Access for ${data.user.email} is now enforced by the API.` });
    } catch (saveError) {
      toast({ title: "Update failed", description: saveError instanceof Error ? saveError.message : "Failed to update module access", variant: "destructive" });
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingState size="page" label="Loading module access…" />;
  if (error || !data) return <main className="p-4 sm:p-6"><Alert variant="destructive"><AlertTitle>Module access could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></AlertDescription></Alert></main>;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Button asChild variant="ghost" size="icon"><Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Module access</h1><p className="mt-1 text-sm text-muted-foreground">{data.user.name} · {data.user.email}</p></div>
        </div>
        <Button onClick={() => void save()} loading={saving} loadingText="Saving…" className="w-full sm:w-auto"><Save />Save access</Button>
      </header>

      <Alert><SlidersHorizontal className="h-4 w-4" /><AlertTitle>Global readiness always wins</AlertTitle><AlertDescription>An account override can disable an available module, but it cannot bypass global maintenance or a globally disabled module.</AlertDescription></Alert>

      <div className="grid gap-4 md:grid-cols-2">
        {data.modules.map((module, index) => (
          <Card key={module.key} className="border-border/70 shadow-none">
            <CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-sm">{module.name}</CardTitle><CardDescription className="mt-1 leading-5">{module.description}</CardDescription></div><Badge variant={module.status === "available" ? "secondary" : "outline"} className="capitalize">{module.status}</Badge></div></CardHeader>
            <CardContent>
              <Select value={module.mode} onValueChange={(mode: UserModuleMode) => {
                const modules = [...data.modules];
                modules[index] = { ...module, mode, enabled: module.status === "available" && mode !== "disabled" };
                setData({ ...data, modules });
              }}>
                <SelectTrigger aria-label={`${module.name} account access`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="inherit">Inherit global setting</SelectItem><SelectItem value="enabled">Enable for account</SelectItem><SelectItem value="disabled">Disable for account</SelectItem></SelectContent>
              </Select>
              {module.status !== "available" && <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-400">The global {module.status} state currently blocks this module{module.message ? `: ${module.message}` : "."}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
