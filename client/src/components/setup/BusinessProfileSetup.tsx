"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { useToast } from "@/hooks/use-toast";
import api, { ApiError } from "@/lib/api";
import {
  BUSINESS_PROFILE_HEADER,
  selectedBusinessProfileId,
  selectBusinessProfile,
} from "@/lib/business-profile";
import {
  applyWebsiteToProfile,
  emptyWorkspaceProfile,
  workspaceCreationKey,
  workspaceProfileData,
  workspaceProfilePayload,
  type SavedWorkspaceProfile,
  type WorkspaceCreationDraft,
  type WorkspaceProfileData,
  type WorkspaceWebsiteAnalysis,
} from "@/lib/workspace-profile";
import { Button } from "@/components/ui/button";
import { PageLoadingState } from "@/components/ui/page-state";
import { WorkspaceProfileForm } from "./WorkspaceProfileForm";
import { WebsiteAnalyzer } from "./WebsiteAnalyzer";
import { loadSetupDraft, useSetupDraft, type SetupDraftBootstrap } from "./useSetupDraft";
import { trackSetupEvent } from "@/lib/setup-analytics";
import { SetupDraftStatus } from "./SetupDraftStatus";

export function BusinessProfileSetup({
  addingProfile = false,
}: {
  addingProfile?: boolean;
}) {
  const { user, logout } = useAuth();
  const { isLoading: setupLoading, setHasBusinessProfile } = useSetupComplete();
  const { toast } = useToast();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const [phase, setPhase] = useState<"website" | "profile">("website");
  const [step, setStep] = useState(1);
  const [data, setData] = useState<WorkspaceProfileData>(emptyWorkspaceProfile);
  const [analysis, setAnalysis] = useState<WorkspaceWebsiteAnalysis | null>(
    null,
  );
  const [profileId, setProfileId] = useState<number | null>(null);
  const createdId = useRef<number | null>(null);
  const creating = useRef<Promise<number> | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const key = workspaceCreationKey(user?.id, addingProfile);
  const remoteKey = addingProfile ? "workspace:new" : "workspace:first";
  const [bootstrap, setBootstrap] = useState<SetupDraftBootstrap<WorkspaceCreationDraft>>();
  const [requestKey, setRequestKey] = useState("");
  const version = useRef<number | undefined>(undefined);
  const [profileVersion, setProfileVersion] = useState<number>();

  useEffect(() => {
    if (setupLoading || !user?.id) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    const load = async () => {
      try {
        const recovered = await loadSetupDraft<WorkspaceCreationDraft>(key, remoteKey);
        if (!active) return;
        setBootstrap(recovered);
        const draft = recovered.draft?.data;
        setRequestKey(draft?.requestKey || crypto.randomUUID());
        let saved: SavedWorkspaceProfile | undefined;
        if (draft?.profileId) {
          saved = await api.get<SavedWorkspaceProfile>(
            `/api/settings/business-profiles/${draft.profileId}`,
          );
        } else if (!addingProfile) {
          const profiles = await api.get<SavedWorkspaceProfile[]>(
            "/api/settings/business-profiles",
          );
          const owned = profiles.filter(
            (profile) => !profile.role || profile.role === "owner",
          );
          saved =
            owned.find(
              (profile) => profile.id === selectedBusinessProfileId(),
            ) ||
            owned.find((profile) => profile.isDefault) ||
            owned[0];
        }
        if (draft && !draft.profileId && saved?.id && !addingProfile && recovered.draft) {
          recovered.draft = { ...recovered.draft, data: { ...draft, profileId: saved.id } };
        }
        setBootstrap(recovered);
        if (saved?.role && saved.role !== "owner")
          throw new Error("Only the workspace owner can finish its setup.");
        if (!active) return;
        const base = saved
          ? workspaceProfileData(saved)
          : emptyWorkspaceProfile();
        const sourceVersion = recovered.draft?.data && typeof recovered.draft.data === "object" && "__setupSourceVersion" in recovered.draft.data ? recovered.draft.data.__setupSourceVersion : undefined;
        const changedSavedProfile = sourceVersion !== undefined && saved?.version !== undefined && sourceVersion !== saved.version;
        const recoveredAnalysis = changedSavedProfile
          ? saved?.websiteAnalysis || null
          : draft?.analysis || saved?.websiteAnalysis || null;
        setData(
          changedSavedProfile
            ? base
            : draft
            ? { ...base, ...draft.data }
            : recoveredAnalysis
              ? applyWebsiteToProfile(base, recoveredAnalysis)
              : base,
        );
        version.current = typeof saved?.version === "number" ? saved.version : undefined;
        setProfileVersion(version.current);
        createdId.current = saved?.id || null;
        setProfileId(createdId.current);
        if (saved?.id) selectBusinessProfile(saved.id);
        setAnalysis(recoveredAnalysis);
        setStep(Math.min(4, Math.max(1, draft?.step || 1)));
        setPhase(draft?.phase || "website");
      } catch (failure) {
        if (active)
          setLoadError(
            failure instanceof Error
              ? failure.message
              : "Your saved workspace could not be loaded.",
          );
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [user?.id, setupLoading, addingProfile, attempt, key, remoteKey]);

  const draftValue = useMemo<WorkspaceCreationDraft>(() => ({
    profileId, phase, data, step, analysis, updatedAt: 0, requestKey,
  }), [profileId, phase, data, step, analysis, requestKey]);
  const draft = useSetupDraft<WorkspaceCreationDraft>({
    storageKey: key,
    remoteKey,
    ready: !loading && !loadError && !setupLoading && !!user?.id,
    bootstrap,
    sourceVersion: profileVersion,
    data: draftValue,
    step,
    maxStep: 4,
    restore: (value, savedStep) => {
      setData(value.data);
      setPhase(value.phase);
      setStep(savedStep);
      setAnalysis(value.analysis || null);
      createdId.current = value.profileId;
      setProfileId(value.profileId);
      if (value.requestKey) setRequestKey(value.requestKey);
    },
  });
  useEffect(() => {
    if (!loading && draft.ready) trackSetupEvent("setup_step_viewed", { phase, step });
  }, [loading, draft.ready, phase, step]);
  const persist = async (value: WorkspaceCreationDraft) => {
    await draft.flush({ data: { ...value, updatedAt: 0, requestKey }, step: value.step, sourceVersion: version.current });
  };

  const ensureProfile = async (url: string): Promise<number> => {
    if (createdId.current) {
      selectBusinessProfile(createdId.current);
      return createdId.current;
    }
    if (creating.current) return creating.current;
    creating.current = (async () => {
      await draft.flush();
      const name =
        data.name.trim() || new URL(url).hostname.replace(/^www\./, "");
      const saved = await api.post<SavedWorkspaceProfile>(
        "/api/settings/business-profiles",
        { name, companyName: name, website: url, idempotencyKey: requestKey },
      );
      if (!Number.isSafeInteger(saved.id) || saved.id <= 0)
        throw new Error("The workspace could not be saved. Please try again.");
      version.current = typeof saved.version === "number" ? saved.version : undefined;
      setProfileVersion(version.current);
      createdId.current = saved.id;
      setProfileId(saved.id);
      selectBusinessProfile(saved.id);
      await persist({
        profileId: saved.id,
        phase: "website",
        data: { ...data, website: url },
        step,
        analysis,
        updatedAt: Date.now(),
      });
      return saved.id;
    })();
    try {
      return await creating.current;
    } finally {
      creating.current = null;
    }
  };
  const save = async (value: WorkspaceProfileData) => {
    if (saveInFlight.current || loading || loadError) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await draft.flush();
      const payload = { ...workspaceProfilePayload(value), ...(version.current ? { expectedVersion: version.current } : {}), idempotencyKey: requestKey };
      const saved = createdId.current
        ? await api.put<SavedWorkspaceProfile>(
            `/api/settings/business-profiles/${createdId.current}`,
            payload,
            {
              headers: { [BUSINESS_PROFILE_HEADER]: String(createdId.current) },
            },
          )
        : await api.post<SavedWorkspaceProfile>(
            "/api/settings/business-profiles",
            payload,
          );
      const id = createdId.current || saved.id;
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("The workspace could not be saved. Please try again.");
      version.current = typeof saved.version === "number" ? saved.version : version.current;
      setProfileVersion(version.current);
      createdId.current = id;
      setProfileId(id);
      selectBusinessProfile(id);
      setData(value);
      await persist({
        profileId: id,
        phase: "profile",
        data: value,
        step: 4,
        analysis,
        updatedAt: Date.now(),
      });
      setHasBusinessProfile(true);
      router.push(`/setup/brand-toolkit/${id}`);
    } catch (failure) {
      toast({
        title: "Workspace could not be saved",
        description:
          failure instanceof Error
            ? failure.message
            : "Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  const cancel = () => {
    if (addingProfile) router.push("/dashboard/home?workspace=choose");
    else logout();
  };
  const discardUnfinishedSetup = async () => {
    if (!bootstrap?.draft || discarding || !window.confirm("Discard this unfinished setup? Saved workspaces, toolkits, and files stay in your account.")) return;
    setDiscarding(true);
    try {
      try {
        await api.delete(`/api/setup/drafts/${encodeURIComponent(remoteKey)}`, { body: JSON.stringify({ expectedRevision: bootstrap.draft.revision }), headers: { "Content-Type": "application/json" } });
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 409 && failure.data && typeof failure.data === "object" && "draft" in failure.data && failure.data.draft === null)) throw failure;
      }
      try { sessionStorage.removeItem(key); } catch { /* The account copy is cleared. */ }
      setBootstrap({ draft: null });
      setAttempt(value => value + 1);
    } catch (failure) {
      setLoadError(failure instanceof ApiError && failure.status === 409 ? "This draft changed. Retry loading it before discarding it." : "The unfinished setup could not be discarded. Check your connection and retry.");
    } finally { setDiscarding(false); }
  };
  if (loading || setupLoading || (!loadError && !draft.ready))
    return (
      <PageLoadingState
        className="min-h-svh"
        label="Preparing your workspace…"
      />
    );
  if (loadError)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10" role="alert">
        <h1 className="text-xl font-semibold">
          We couldn’t load your saved profile
        </h1>
        <p className="text-sm text-muted-foreground">
          {loadError} Retry before continuing so an existing workspace is not
          duplicated.
        </p>
        <Button disabled={discarding} onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
        {bootstrap?.draft && <Button variant="outline" disabled={discarding} onClick={() => void discardUnfinishedSetup()}>{discarding ? "Discarding…" : "Discard unfinished setup"}</Button>}
        {addingProfile && <Button variant="ghost" disabled={discarding} onClick={cancel}>Return to workspaces</Button>}
      </div>
    );
  if (phase === "website")
    return (
      <>
      <SetupDraftStatus draft={draft} />
      <WebsiteAnalyzer
        profileId={profileId}
        website={data.website}
        analysis={analysis}
        ensureProfile={ensureProfile}
        onWebsite={(website) => setData((current) => ({ ...current, website }))}
        onAnalysis={(saved) => {
          setAnalysis(saved);
          setData((current) => applyWebsiteToProfile(current, saved));
          try {
            sessionStorage.removeItem(
              `setup:brand-toolkit:${user?.id}:${createdId.current}`,
            );
          } catch {
            /* Draft storage is optional. */
          }
        }}
        onContinue={() => setPhase("profile")}
        onCancel={cancel}
        showInvitations={!addingProfile && !profileId}
        hasSavedDetails={!!data.name}
      />
      </>
    );
  return (
    <>
    <SetupDraftStatus draft={draft} />
    <WorkspaceProfileForm
      data={data}
      onChange={setData}
      step={step}
      onStep={setStep}
      onSave={(value) => void save(value)}
      onBack={() => setPhase("website")}
      saving={saving}
    />
    </>
  );
}
