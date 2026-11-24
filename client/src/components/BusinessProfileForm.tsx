"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import {
  emptyWorkspaceProfile,
  workspaceProfileData,
  workspaceProfilePayload,
  type SavedWorkspaceProfile,
  type WorkspaceProfileData,
} from "@/lib/workspace-profile";
import { WorkspaceProfileForm } from "@/components/setup/WorkspaceProfileForm";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { PageLoadingState } from "@/components/ui/page-state";

/** Editing uses the same four sections as onboarding; analyzer and toolkit stay in creation. */
export function BusinessProfileForm({
  profileId,
  saveButtonLabel = "Save changes",
  onSaveSuccess,
}: {
  profileId: number;
  saveButtonLabel?: string;
  onSaveSuccess?: () => void;
}) {
  const [data, setData] = useState<WorkspaceProfileData>(emptyWorkspaceProfile);
  const [savedData, setSavedData] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveFailure, setSaveFailure] = useState("");
  const [saveConflict, setSaveConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const cache = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const dirty = savedData !== null && JSON.stringify(data) !== savedData;
  const { confirmLeave, clearGuard } = useUnsavedChanges(dirty);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSaveFailure("");
    setSaveConflict(false);
    api
      .get<SavedWorkspaceProfile>(
        `/api/settings/business-profiles/${profileId}`,
      )
      .then((profile) => {
        if (profile.role && profile.role !== "owner")
          throw new Error("Only the workspace owner can edit this profile.");
        if (active) {
          const loaded = workspaceProfileData(profile);
          setData(loaded);
          setSavedData(JSON.stringify(loaded));
          setRevision(typeof profile.version === "number" ? profile.version : null);
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "The profile could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [profileId, attempt]);
  const save = async (value: WorkspaceProfileData) => {
    if (saving || loading || error) return;
    setSaving(true);
    setSaveFailure("");
    setSaveConflict(false);
    try {
      const saved = await api.put<SavedWorkspaceProfile>(
        `/api/settings/business-profiles/${profileId}`,
        { ...workspaceProfilePayload(value), ...(revision !== null ? { expectedVersion: revision } : {}) },
        { headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) } },
      );
      setRevision(typeof saved?.version === "number" ? saved.version : revision !== null ? revision + 1 : null);
      setSavedData(JSON.stringify(value));
      clearGuard();
      await cache.invalidateQueries({ queryKey: ["business-profiles"] });
      toast({ title: "Workspace profile saved" });
      onSaveSuccess?.();
    } catch (failure) {
      setSaveConflict(Boolean(failure && typeof failure === "object" && "status" in failure && failure.status === 409));
      setSaveFailure(failure instanceof Error ? failure.message : "Check your connection and try again. Your edits are still here.");
      toast({
        title: "Workspace profile could not be saved",
        description:
          failure instanceof Error
            ? failure.message
            : "Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };
  if (loading) return <PageLoadingState label="Loading workspace profile…" />;
  if (error)
    return (
      <div role="alert" className="space-y-4 rounded-xl border p-6">
        <p>{error}</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </div>
    );
  return (
    <div>
    <p className="mb-3 text-xs text-muted-foreground" role="status">{dirty ? "Unsaved changes" : "All changes saved"}</p>
    {saveFailure && <Callout tone="danger" className="mb-3" actions={saveConflict ? <Button type="button" variant="outline" onClick={() => { if (window.confirm("Load the latest saved profile? Your unsaved edits will be discarded.")) { clearGuard(); setSavedData(null); setAttempt(value => value + 1); } }}>Load latest saved profile</Button> : undefined}><p>{saveFailure} Your edits have been kept.</p></Callout>}
    <WorkspaceProfileForm
      data={data}
      onChange={setData}
      step={step}
      onStep={setStep}
      onSave={(value) => void save(value)}
      onBack={() => { if (confirmLeave()) router.push("/dashboard/home?workspace=choose"); }}
      saving={saving}
      editing
      saveButtonLabel={saveButtonLabel}
    />
    </div>
  );
}
