"use client";
import { useEffect, useState, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { listSupportWidgetTeams, type SupportWidgetTeam as Team } from "@/lib/support-widget-api";
import { useSupportWorkspace } from "@/hooks/use-support-report";
import { usePlatformAccess } from "@/hooks/use-platform-access";
import { workspaceSettingsDestinations } from "@/lib/settings-navigation";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { WorkspaceSettingsScope } from "@/components/settings/WorkspaceSettingsScope";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SupportAIPageShell } from "@/components/support/SupportAIPageShell";
import { WidgetPreview } from "@/components/support/WidgetPreview";
import {
  DEFAULT_WIDGET_SETTINGS,
  normalizeWidgetSettings,
  widgetSettingsError,
  type SupportWidgetSettings,
} from "@/lib/support-widget-settings";
export default function WidgetSettingsPage() {
  const workspace = useSupportWorkspace();
  const access = usePlatformAccess(Boolean(workspace.userId));
  const headers = useMemo(
    () => ({ [BUSINESS_PROFILE_HEADER]: String(workspace.profileId) }),
    [workspace.profileId],
  );
  if (workspace.profiles.isError)
    return <div role="alert" className="space-y-3 p-6"><p>Support workspace could not be loaded.</p><Button variant="outline" onClick={() => void workspace.profiles.refetch()}>Try again</Button></div>;
  if (!workspace.profiles.isLoading && !workspace.profileId)
    return <div className="space-y-3 p-6"><p>Choose a workspace to see its widget settings.</p><Button asChild variant="outline"><Link href="/dashboard/select-profile">Choose a workspace</Link></Button></div>;
  if (!workspace.ready)
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading support workspace…
      </div>
    );
  return (
    <WidgetSettingsWorkspace
      key={`${workspace.userId}:${workspace.profileId}`}
      headers={headers}
      canManageSupportTeams={Boolean(!access.isError && access.data && workspace.profiles.activeProfile && workspaceSettingsDestinations(workspace.profiles.activeProfile, access.data).some(item => item.id === 'support-teams'))}
    />
  );
}
function WidgetSettingsWorkspace({
  headers,
  canManageSupportTeams,
}: {
  headers: Record<string, string>;
  canManageSupportTeams: boolean;
}) {
  const query = useSearchParams();
  const teamQuery = query.get("team");
  const { toast } = useToast();
  const mounted = useRef(true);
  const writeGeneration = useRef(0);
  const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [settings, setSettings] = useState(DEFAULT_WIDGET_SETTINGS);
  const [saved, setSaved] = useState(DEFAULT_WIDGET_SETTINGS);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    listSupportWidgetTeams({
      headers,
      signal: controller.signal,
    })
      .then((data) => {
        if (!active) return;
        setTeams(data);
        const selected =
          data.find((team) => String(team.teamId) === teamQuery) || data[0];
        if (selected) {
          setTeamId(String(selected.teamId));
          const initial = normalizeWidgetSettings(selected.settings);
          setSettings(initial);
          setSaved(initial);
        }
      })
      .catch((err) => {
        if (active)
          setError(
            err instanceof Error
              ? err.message
              : "Could not load widget settings.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [headers, teamQuery, loadVersion]);
  const selected = teams.find((team) => String(team.teamId) === teamId);
  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  const validation = widgetSettingsError(settings);
  const update = <K extends keyof SupportWidgetSettings>(
    key: K,
    value: SupportWidgetSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  function selectTeam(nextId: string) {
    const team = teams.find((item) => String(item.teamId) === nextId);
    if (!team) return;
    setTeamId(nextId);
    const next = normalizeWidgetSettings(team.settings);
    setSettings(next);
    setSaved(next);
    setError("");
  }
  async function save() {
    if (validation || !selected || saving) return;
    const generation = ++writeGeneration.current;
    setSaving(true);
    setError("");
    try {
      const result = await api.put<SupportWidgetSettings>(
        `/api/support-widget/settings/${teamId}`,
        settings,
        { headers },
      );
      if (!mounted.current || generation !== writeGeneration.current) return;
      setSettings(result);
      setSaved(result);
      setTeams((current) =>
        current.map((team) =>
          team.teamId === selected.teamId
            ? { ...team, settings: result }
            : team,
        ),
      );
      toast({
        title: "Widget settings saved",
        description:
          "Existing widgets pick up your changes when the website reloads.",
      });
    } catch (err) {
      if (!mounted.current || generation !== writeGeneration.current) return;
      setError(
        err instanceof Error ? err.message : "Could not save widget settings.",
      );
    } finally {
      if (mounted.current && generation === writeGeneration.current)
        setSaving(false);
    }
  }
  return (
    <ScrollArea className="h-full min-w-0" viewportClassName="[&>div]:!block">
      <SupportAIPageShell>
        <PageHeader
          icon={SlidersHorizontal}
          title="Widget settings"
          subtitle="Make the customer chat feel at home on your website."
          actions={
            <Button asChild variant="outline">
              <Link href="/dashboard/support-ai/embed">Embed & integrate</Link>
            </Button>
          }
        />
        <WorkspaceSettingsScope detail={selected ? `Website channel · support team: ${selected.teamName}. Appearance and greeting apply to this team's website widgets.` : "Website channel · choose a support team below. Each team has its own widget appearance and greeting."} />
        {error && (
          <Callout tone="danger">{error}</Callout>
        )}
        {loading ? (
          <div role="status" className="flex items-center gap-2 p-6">
            <Spinner size="md" label={null} />
            Loading settings…
          </div>
        ) : error && !selected ? (
          <Button
            variant="outline"
            onClick={() => setLoadVersion((current) => current + 1)}
          >
            Try again
          </Button>
        ) : !selected ? (
          <div className="rounded-xl border border-dashed p-8">
            <h2 className="font-semibold">No support teams available</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Each team has its own widget appearance. {canManageSupportTeams ? 'Create a support team to configure its widget.' : 'Ask the workspace owner about support team setup.'}
            </p>
            {canManageSupportTeams && <Button asChild className="mt-4">
              <Link href="/dashboard/support/teams">Set up support team</Link>
            </Button>}
          </div>
        ) : (
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
            <form
              className="min-w-0 space-y-6 rounded-xl border bg-card p-5 sm:p-6"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="widget-team">Support team</Label>
                <select
                  id="widget-team"
                  className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                  value={teamId}
                  disabled={saving}
                  onChange={(event) => {
                    if (changed) setPendingTeamId(event.target.value);
                    else selectTeam(event.target.value);
                  }}
                >
                  {teams.map((team) => (
                    <option key={team.teamId} value={team.teamId}>
                      {team.teamName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="widget-name">Display name</Label>
                <Input
                  disabled={saving}
                  id="widget-name"
                  value={settings.displayName}
                  maxLength={100}
                  placeholder={selected.teamName}
                  onChange={(event) =>
                    update("displayName", event.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use your business name.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="widget-greeting">Greeting</Label>
                <Textarea
                  disabled={saving}
                  id="widget-greeting"
                  value={settings.greeting}
                  maxLength={500}
                  rows={3}
                  onChange={(event) => update("greeting", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Shown before a visitor sends their first message.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="widget-color">Brand color</Label>
                <div className="flex gap-3">
                  <input
                    aria-label="Choose brand color"
                    disabled={saving}
                    type="color"
                    value={
                      /^#[a-f0-9]{6}$/i.test(settings.primaryColor)
                        ? settings.primaryColor
                        : "#6366f1"
                    }
                    className="h-11 w-12 cursor-pointer rounded-md border bg-background p-1"
                    onChange={(event) =>
                      update("primaryColor", event.target.value)
                    }
                  />
                  <Input
                    disabled={saving}
                    id="widget-color"
                    value={settings.primaryColor}
                    maxLength={7}
                    onChange={(event) =>
                      update("primaryColor", event.target.value)
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="widget-logo">Logo URL</Label>
                <Input
                  disabled={saving}
                  id="widget-logo"
                  type="url"
                  value={settings.logoUrl}
                  placeholder="https://your-website.com/logo.png"
                  maxLength={2000}
                  onChange={(event) => update("logoUrl", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Use a publicly available HTTPS image.
                </p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  Chat button position
                </legend>
                <div className="flex flex-wrap gap-3">
                  {(["left", "right"] as const).map((position) => (
                    <label
                      key={position}
                      className="flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm"
                    >
                      <input
                        disabled={saving}
                        type="radio"
                        name="position"
                        checked={settings.launcherPosition === position}
                        onChange={() => update("launcherPosition", position)}
                      />
                      Bottom {position}
                    </label>
                  ))}
                </div>
              </fieldset>
              {validation && (
                <p role="alert" className="text-sm text-destructive">
                  {validation}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                <Button
                  type="submit"
                  disabled={!changed || !!validation}
                  loading={saving}
                >
                  Save changes
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!changed || saving}
                  onClick={() => setSettings(saved)}
                >
                  Discard changes
                </Button>
                {changed && (
                  <span className="text-xs text-muted-foreground">
                    Unsaved changes
                  </span>
                )}
              </div>
            </form>
            <WidgetPreview settings={settings} teamName={selected.teamName} />
          </div>
        )}
        <AlertDialog
          open={pendingTeamId !== null}
          onOpenChange={(open) => {
            if (!open) setPendingTeamId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your widget changes have not been saved. Discard them to switch
                support teams, or keep editing this team.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingTeamId) selectTeam(pendingTeamId);
                  setPendingTeamId(null);
                }}
              >
                Discard and switch
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SupportAIPageShell>
    </ScrollArea>
  );
}
