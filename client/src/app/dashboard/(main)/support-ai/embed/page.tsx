"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Code,
  RefreshCw,
  Globe,
  FileCode,
  Link2,
  Loader2,
  ArrowUpRight,
  Users,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { listSupportWidgetTeams, type SupportWidgetTeam as WidgetTeam } from "@/lib/support-widget-api";
import { useSupportWorkspace } from "@/hooks/use-support-report";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { SupportAIPageShell } from "@/components/support/SupportAIPageShell";
import { WidgetPreview } from "@/components/support/WidgetPreview";
import {
  normalizeWidgetSettings,
} from "@/lib/support-widget-settings";
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
import { Skeleton } from "@/components/ui/skeleton";
import { supportWidgetEmbedScriptUrl } from "@/lib/support-widget-embed";
import styles from "./support-embed.module.css";

export default function SupportAIEmbedPage() {
  const workspace = useSupportWorkspace();
  const headers = useMemo(
    () => ({ [BUSINESS_PROFILE_HEADER]: String(workspace.profileId) }),
    [workspace.profileId],
  );
  if (workspace.profiles.isError)
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>Support workspace could not be loaded.</p>
        <Button variant="outline" onClick={() => void workspace.profiles.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!workspace.profiles.isLoading && !workspace.profileId)
    return (
      <div className="space-y-3 p-6">
        <p>Choose a workspace to see its widget integrations.</p>
        <Button asChild variant="outline">
          <Link href="/dashboard/select-profile">Choose a workspace</Link>
        </Button>
      </div>
    );
  if (!workspace.ready)
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading support workspace…
      </div>
    );
  return (
    <SupportAIEmbedWorkspace
      key={`${workspace.userId}:${workspace.profileId}`}
      headers={headers}
    />
  );
}

function SupportAIEmbedWorkspace({
  headers,
}: {
  headers: Record<string, string>;
}) {
  const { toast } = useToast();
  const [widgetTeams, setWidgetTeams] = useState<WidgetTeam[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingTeam, setRevokingTeam] = useState<WidgetTeam | null>(null);
  const [rotatingTeam, setRotatingTeam] = useState<WidgetTeam | null>(null);
  const [generatingToken, setGeneratingToken] = useState<number | null>(null);
  const confirmationFocus = useRef<{
    trigger: HTMLButtonElement;
    heading: HTMLElement | null;
    pathname: string;
  } | null>(null);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const writeInProgress = useRef(false);
  const readController = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readController.current?.abort();
    };
  }, []);

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "";
  const clientBaseUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  const loadWidgetTokens = useCallback(async () => {
    if (!mounted.current || writeInProgress.current) return;
    const generation = ++readGeneration.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setLoadingTokens(true);
    setLoadError(null);
    try {
      const teams = await listSupportWidgetTeams({
        headers,
        signal: controller.signal,
      });
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== readGeneration.current
      )
        return;
      setWidgetTeams(Array.isArray(teams) ? teams : []);
    } catch (error: unknown) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== readGeneration.current
      )
        return;
      setLoadError(
        error instanceof Error ? error.message : "Failed to load widget keys",
      );
    } finally {
      if (mounted.current && generation === readGeneration.current)
        setLoadingTokens(false);
    }
  }, [headers]);

  useEffect(() => {
    void loadWidgetTokens();
  }, [loadWidgetTokens]);

  const beginWrite = useCallback((teamId: number) => {
    // State alone cannot exclude another event before React's next render.
    // One outstanding write keeps every committed receipt owned by this view.
    if (!mounted.current || writeInProgress.current) return false;
    writeInProgress.current = true;
    // A pre-write GET is stale even if its transport ignores cancellation.
    ++readGeneration.current;
    readController.current?.abort();
    readController.current = null;
    setLoadingTokens(false);
    setLoadError(null);
    setGeneratingToken(teamId);
    return true;
  }, []);

  const generateToken = useCallback(
    async (teamId: number) => {
      if (!beginWrite(teamId)) return;
      try {
        const data = await api.post<{
          token: string;
          teamId: number;
          teamName: string;
        }>("/api/support-widget/generate-token", { teamId }, { headers });
        if (!mounted.current) return;
        setWidgetTeams((prev) =>
          prev.map((team) =>
            team.teamId === data.teamId
              ? { ...team, token: data.token, installation: null }
              : team,
          ),
        );
        toast({
          title: "Key generated",
          description: `New widget key created for ${data.teamName}`,
        });
      } catch (error) {
        if (!mounted.current) return;
        toast({
          title: "Error",
          description:
            error instanceof Error ? error.message : "Failed to generate key",
          variant: "destructive",
        });
      } finally {
        writeInProgress.current = false;
        if (mounted.current) setGeneratingToken(null);
      }
    },
    [toast, headers, beginWrite],
  );

  const revokeToken = async (team: WidgetTeam) => {
    if (!beginWrite(team.teamId)) return;
    try {
      await api.delete(`/api/support-widget/token/${team.teamId}`, { headers });
      if (!mounted.current) return;
      setWidgetTeams((current) =>
        current.map((item) =>
          item.teamId === team.teamId
            ? { ...item, token: null, installation: null }
            : item,
        ),
      );
      toast({
        title: "Widget key revoked",
        description: "Website widgets and links using this key are disabled.",
      });
    } catch (error) {
      if (!mounted.current) return;
      toast({
        title: "Could not revoke key",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    } finally {
      writeInProgress.current = false;
      if (mounted.current) setGeneratingToken(null);
    }
  };

  const rememberConfirmationFocus = (trigger: HTMLButtonElement) => {
    confirmationFocus.current = {
      trigger,
      heading: trigger.closest("section")?.querySelector("h2") ?? null,
      pathname: window.location.pathname,
    };
  };
  const restoreConfirmationFocus = (event: Event) => {
    const origin = confirmationFocus.current;
    if (!mounted.current || !origin || origin.pathname !== window.location.pathname)
      return;
    const content = event.target as HTMLElement;
    const active = document.activeElement;
    // A newer dialog or navigation owns focus once the exit starts.
    if (
      document.querySelector('[role="alertdialog"][data-state="open"], [role="dialog"][data-state="open"]') ||
      (active !== document.body && active !== origin.trigger && active && !content.contains(active))
    ) return;
    const target = origin.trigger.disabled ? origin.heading : origin.trigger;
    if (target?.isConnected && !target.closest('[hidden], [inert], [aria-hidden="true"]')) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  };

  const showCopyError = useCallback(
    () =>
      toast({
        title: "Error",
        description: "Failed to copy",
        variant: "destructive",
      }),
    [toast],
  );

  const getIframeCode = (token: string) =>
    `<iframe\n  src="${clientBaseUrl}/support-widget/${token}"\n  width="100%"\n  height="600"\n  style="max-width: 400px; border: none; border-radius: 12px;"\n  allow="clipboard-write"\n  title="Support Chat"\n></iframe>`;

  const getScriptCode = (token: string) =>
    `<script src="${supportWidgetEmbedScriptUrl(apiBaseUrl, clientBaseUrl, token)}"></script>`;

  const getDirectUrl = (token: string) =>
    `${clientBaseUrl}/support-widget/${token}`;

  return (
    <ScrollArea
      className="h-full min-w-0 bg-background"
      viewportClassName="[&>div]:!block"
    >
      <SupportAIPageShell>
        <PageHeader
          icon={Code}
          title="Embed & integrate"
          subtitle="Add your support assistant to your website, or share a direct chat link."
          actions={
            <>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/dashboard/settings/outreach">
                  <SlidersHorizontal />
                  Assistant settings
                </Link>
              </Button>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/dashboard/support/teams">
                  <Users />
                  Support teams
                </Link>
              </Button>
            </>
          }
        />

        {generatingToken !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            Updating widget key… Wait for this change to finish before changing
            another key or checking installation.
          </p>
        )}
        {loadError && (
          <Alert variant="destructive">
            <AlertTitle>Widget integrations could not be loaded</AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="break-words">{loadError}</span>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={loadingTokens || generatingToken !== null}
                onClick={() => void loadWidgetTokens()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {loadingTokens && widgetTeams.length === 0 ? (
          <div
            role="status"
            aria-label="Loading widget integrations"
            className="space-y-4 rounded-[14px] border border-border bg-card p-5 sm:p-6"
          >
            <span className="sr-only">Loading widget integrations…</span>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-12 w-full" />
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <Skeleton className="h-72 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          </div>
        ) : widgetTeams.length === 0 &&
          loadError ? null : widgetTeams.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-border bg-card px-6 py-12 text-center">
            <Globe
              className="mx-auto mb-4 h-7 w-7 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="text-lg font-semibold">No support teams yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              Create a support team to generate a widget key and add chat to
              your website.
            </p>
            <Button asChild className="mt-5 min-h-11">
              <Link href="/dashboard/support/teams">Set up support team</Link>
            </Button>
          </div>
        ) : (
          widgetTeams.map((team) => (
            <section
              key={team.teamId}
              aria-labelledby={`widget-team-${team.teamId}`}
              className={`${styles.team} min-w-0 overflow-hidden rounded-[14px] border border-border bg-card shadow-sm`}
            >
              <div className="border-b border-border p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <Button asChild variant="outline" className="min-h-11">
                    <Link
                      href={`/dashboard/support-ai/widget-settings?team=${team.teamId}`}
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      Customize widget
                    </Link>
                  </Button>
                  {team.token && (
                    <Button
                      variant="ghost"
                      className="min-h-11 text-destructive"
                      disabled={generatingToken !== null}
                      onClick={(event) => {
                        if (writeInProgress.current) return;
                        rememberConfirmationFocus(event.currentTarget);
                        setRevokingTeam(team);
                      }}
                    >
                      Revoke key
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={loadingTokens || generatingToken !== null}
                    onClick={() => void loadWidgetTokens()}
                  >
                    {loadingTokens ? "Checking…" : "Check installation"}
                  </Button>
                </div>
                <div
                  className="mb-5 rounded-lg border bg-muted/30 p-3 text-sm"
                  role="status"
                >
                  {team.installation ? (
                    <>
                      <span className="font-medium">
                        Loader detected on {team.installation.hostname}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Last detected{" "}
                        {new Date(
                          team.installation.lastSeenAt,
                        ).toLocaleString()}
                        . Open chat on your website to confirm replies work.
                        This signal confirms the script loaded, not the full
                        conversation.
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">
                        Waiting for your website
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Publish the floating-button code, visit your website,
                        then check again. Inline embeds and direct links do not
                        send an installation signal.
                      </p>
                    </>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2
                        id={`widget-team-${team.teamId}`}
                        tabIndex={-1}
                        className="break-words text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {team.teamName}
                      </h2>
                      <Badge
                        variant="secondary"
                        className={
                          team.token ? "bg-primary/10 text-primary" : ""
                        }
                      >
                        {team.token ? "Key generated" : "Key needed"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Website widget for this support team
                    </p>
                  </div>
                  <Button
                    variant={team.token ? "outline" : "default"}
                    onClick={(event) => {
                      if (writeInProgress.current) return;
                      if (team.token) {
                        rememberConfirmationFocus(event.currentTarget);
                        setRotatingTeam(team);
                      } else void generateToken(team.teamId);
                    }}
                    disabled={generatingToken !== null}
                    aria-label={`${team.token ? "Rotate" : "Generate"} widget key for ${team.teamName}`}
                    className="min-h-11 shrink-0"
                  >
                    {generatingToken === team.teamId ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {team.token ? "Rotate key" : "Generate key"}
                  </Button>
                </div>

                {team.token && (
                  <div className="mt-5">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Widget key
                    </p>
                    <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-muted/40 pl-3 pr-1 sm:pl-4">
                      <code
                        className="min-w-0 flex-1 truncate py-3 font-mono text-xs text-foreground"
                        title={team.token}
                      >
                        {team.token}
                      </code>
                      <CopyButton
                        iconOnly
                        variant="ghost"
                        className="h-11 w-11 shrink-0"
                        aria-label={`Copy widget key for ${team.teamName}`}
                        value={team.token}
                        onError={showCopyError}
                      />
                    </div>
                  </div>
                )}
              </div>

              {team.token ? (
                <div className={`${styles.layout} grid min-w-0`}>
                  <div className="min-w-0 space-y-6 p-5 sm:p-6">
                    <EmbedCodeBlock
                      icon={<Code className="h-4 w-4" />}
                      title="Floating chat button"
                      description={
                        <>
                          Paste this script before the closing{" "}
                          <code className="font-mono text-xs text-foreground">
                            &lt;/body&gt;
                          </code>{" "}
                          tag. It adds a chat button to your website.
                        </>
                      }
                      code={getScriptCode(team.token)}
                      copyLabel={`Copy floating chat button code for ${team.teamName}`}
                      onCopyError={showCopyError}
                      recommended
                    />
                    <div className="border-t border-border pt-6">
                      <EmbedCodeBlock
                        icon={<FileCode className="h-4 w-4" />}
                        title="Inline chat widget"
                        description="Place this iframe where you want chat to appear within a page. Its width adapts to the available space."
                        code={getIframeCode(team.token)}
                        copyLabel={`Copy inline chat widget code for ${team.teamName}`}
                        onCopyError={showCopyError}
                      />
                    </div>
                  </div>

                  <aside
                    aria-label={`Sharing and installation for ${team.teamName}`}
                    className={`${styles.aside} min-w-0 space-y-6 border-t border-border bg-muted/20 p-5 sm:p-6`}
                  >
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <Link2 className="h-4 w-4 text-primary" />
                        Direct chat link
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Share this link to open chat without adding it to a
                        website.
                      </p>
                      <code className="mt-4 block break-all rounded-[10px] border border-border bg-background p-3 font-mono text-xs leading-6">
                        {getDirectUrl(team.token)}
                      </code>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <CopyButton
                          size="default"
                          className="min-h-11 px-3 text-xs"
                          aria-label={`Copy direct chat link for ${team.teamName}`}
                          label="Copy link"
                          value={getDirectUrl(team.token)}
                          onError={showCopyError}
                        />
                        <Button
                          asChild
                          variant="ghost"
                          className="min-h-11 px-3 text-xs"
                        >
                          <a
                            href={getDirectUrl(team.token)}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${team.teamName} chat in a new tab`}
                          >
                            Open chat
                            <ArrowUpRight />
                          </a>
                        </Button>
                      </div>
                    </div>
                    <WidgetPreview
                      settings={normalizeWidgetSettings(team.settings)}
                      teamName={team.teamName}
                    />
                    <div className="border-t border-border pt-5">
                      <h3 className="text-sm font-semibold">
                        Install on your website
                      </h3>
                      <ol className="mt-4 space-y-4 text-sm text-muted-foreground">
                        {[
                          "Choose the floating button or inline widget.",
                          "Copy the code into your website’s HTML.",
                          "Publish the page and open chat to check it.",
                        ].map((step, index) => (
                          <li key={step} className="flex items-start gap-3">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-card font-mono text-xs text-foreground">
                              {index + 1}
                            </span>
                            <span className="leading-5">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </aside>
                </div>
              ) : (
                <div className="px-5 py-10 text-center sm:px-6">
                  <Code
                    className="mx-auto mb-3 h-6 w-6 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h3 className="text-sm font-semibold">
                    Generate a key to get started
                  </h3>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                    Your embed code and direct chat link will appear here once
                    this team has a widget key.
                  </p>
                </div>
              )}
            </section>
          ))
        )}
        <AlertDialog
          open={!!revokingTeam}
          onOpenChange={(open) => {
            if (!open) setRevokingTeam(null);
          }}
        >
          <AlertDialogContent onCloseAutoFocus={restoreConfirmationFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>Disable this widget key?</AlertDialogTitle>
              <AlertDialogDescription>
                Revoking the key for {revokingTeam?.teamName} immediately
                disables its website widgets and direct links. Generate and
                install a new key when you are ready to enable chat again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep current key</AlertDialogCancel>
              <AlertDialogAction
                disabled={generatingToken !== null}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (revokingTeam) void revokeToken(revokingTeam);
                  setRevokingTeam(null);
                }}
              >
                Revoke key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={!!rotatingTeam}
          onOpenChange={(open) => {
            if (!open) setRotatingTeam(null);
          }}
        >
          <AlertDialogContent onCloseAutoFocus={restoreConfirmationFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate the widget key?</AlertDialogTitle>
              <AlertDialogDescription>
                This replaces the key for {rotatingTeam?.teamName}. Existing
                website installations and direct links will stop working. Copy
                the new code and update every website after rotation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep current key</AlertDialogCancel>
              <AlertDialogAction
                disabled={generatingToken !== null}
                onClick={() => {
                  if (rotatingTeam) void generateToken(rotatingTeam.teamId);
                  setRotatingTeam(null);
                }}
              >
                Rotate key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SupportAIPageShell>
    </ScrollArea>
  );
}

function EmbedCodeBlock({
  icon,
  title,
  description,
  code,
  copyLabel,
  onCopyError,
  recommended,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  code: string;
  copyLabel: string;
  onCopyError: () => void;
  recommended?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-primary" aria-hidden="true">
          {icon}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {recommended && (
          <Badge variant="secondary" className="text-xs">
            Recommended
          </Badge>
        )}
      </div>
      <p className="mt-2 max-w-[65ch] text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      <div className="mt-4 min-w-0 overflow-hidden rounded-[10px] border border-border bg-muted/40">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-1">
          <span className="font-mono text-xs text-muted-foreground">HTML</span>
          <CopyButton
            variant="ghost"
            size="default"
            className="min-h-11 px-2 text-xs"
            aria-label={copyLabel}
            label="Copy code"
            value={code}
            onError={onCopyError}
          />
        </div>
        <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs leading-6 text-foreground">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
