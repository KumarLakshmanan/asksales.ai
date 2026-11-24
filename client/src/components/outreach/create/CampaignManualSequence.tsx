"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import api from "@/lib/api";
import { loadReusableTemplates } from "@/lib/contentTemplateLibrary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InboxChannel } from "../../../../../shared/outreachInbox";
import type {
  ManualCampaignIdentity,
  ManualSequence,
  ManualSequenceStep,
} from "../../../../../shared/campaignManualFollowUps";
import type { ManualReview } from "../../../../../shared/campaignManualFollowUps";
import { manualSequenceStepsProblem } from "../../../../../shared/campaignManualFollowUps";
import { EmailMessageContent } from "../EmailMessageContent";
import { disambiguateOptionLabels } from '@/lib/selectOptionLabels';

type Campaign = ManualCampaignIdentity & { name: string };

/** "4320" minutes reads as "3 days". Short delays need no hint. */
export function formatDelayHint(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 60) return "";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [
    days ? `${days} ${days === 1 ? "day" : "days"}` : "",
    hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "",
    rest ? `${rest} min` : "",
  ].filter(Boolean);
  return parts.join(" ");
}
export function useCampaignManualSequence(
  channel: InboxChannel,
  ownerScope: string,
  initialCampaign?: ManualCampaignIdentity,
  /** The campaign this composer was opened from. It is preselected when the
   * sequence is turned on, but does not turn the sequence on by itself. */
  suggestedCampaign?: ManualCampaignIdentity,
) {
  const [enabled, setEnabled] = useState(Boolean(initialCampaign));
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState(
    initialCampaign ? `${initialCampaign.kind}:${initialCampaign.id}` : "",
  );
  const [sequence, setSequence] = useState<ManualSequence | null>(null);
  const [steps, setSteps] = useState<ManualSequenceStep[]>([]);
  const [mode, setMode] = useState<"manual" | "off">("manual");
  const [templates, setTemplates] = useState<
    Array<{ id: number; name: string; isApproved: boolean }>
  >([]);
  const [loading, setLoading] = useState(false),
    [loadFailed, setLoadFailed] = useState(false),
    [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  // Editing a draft invalidates mutation receipts, but must not discard the
  // pending read that establishes its saved head version or clears loading.
  const loadRequest = useRef(0);
  const editRevision = useRef(0);
  const listRequest = useRef(0);
  const contextKey = `${ownerScope}:${channel}:${selected}`;
  const activeKey = useRef(contextKey);
  activeKey.current = contextKey;
  const [loadedContext, setLoadedContext] = useState("");
  const campaign = campaigns.find(
    (item) => `${item.kind}:${item.id}` === selected,
  );
  useEffect(() => {
    let active = true;
    const generation = ++listRequest.current;
    api
      .get<{ campaigns: Campaign[] }>(
        "/api/outreach/manual-follow-ups/campaign-options",
      )
      .then((value) => {
        if (!Array.isArray(value.campaigns))
          throw new Error("Invalid campaign response");
        if (active && generation === listRequest.current)
          setCampaigns(value.campaigns);
      })
      .catch(() => {
        if (active && generation === listRequest.current)
          setError("Campaigns could not be loaded. Retry.");
      });
    return () => {
      active = false;
    };
  }, [ownerScope, reload]);
  useEffect(() => {
    let active = true;
    loadReusableTemplates<{ id: number; name: string; isApproved: boolean }>(
      channel === "instagram" || channel === "facebook"
        ? "social_message"
        : channel,
    )
      .then((value) => {
        if (active) setTemplates(value.filter((item) => item.isApproved));
      })
      .catch(() => {
        if (active) setTemplates([]);
      });
    return () => {
      active = false;
    };
  }, [channel, ownerScope, reload]);
  useEffect(() => {
    ++request.current;
    const generation = ++loadRequest.current;
    const initialEditRevision = editRevision.current;
    let active = true;
    const currentLoad = () =>
      active &&
      loadRequest.current === generation &&
      activeKey.current === contextKey;
    setLoadedContext(contextKey);
    setSaving(false);
    setSequence(null);
    setSteps([]);
    setDirty(false);
    setError("");
    setLoadFailed(false);
    setMode("manual");
    if (!campaign) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .get<ManualSequence>(
        `/api/outreach/manual-follow-ups?kind=${campaign.kind}&campaignId=${campaign.id}&channel=${channel}`,
      )
      .then((value) => {
        if (currentLoad()) {
          setSequence(value);
          if (editRevision.current === initialEditRevision) {
            setSteps(value.steps);
            setMode(value.mode);
          }
        }
      })
      .catch((error) => {
        if (currentLoad()) {
          if (error?.status !== 404) {
            setLoadFailed(true);
            setError(
              error instanceof Error
                ? error.message
                : "Sequence could not be loaded.",
            );
          }
        }
      })
      .finally(() => {
        if (currentLoad()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaign?.kind, campaign?.id, channel, ownerScope, reload, contextKey]);
  const save = async (copyGlobalPreset = false) => {
    if (
      !campaign ||
      saving ||
      loading ||
      loadFailed ||
      loadedContext !== contextKey
    )
      return;
    const generation = request.current,
      key = contextKey;
    setSaving(true);
    setError("");
    try {
      const value = await api.put<ManualSequence>(
        "/api/outreach/manual-follow-ups",
        {
          campaign: { kind: campaign.kind, id: campaign.id },
          channel,
          expectedVersion: sequence?.version || 0,
          mode,
          steps: mode === "off" ? [] : steps,
          ...(copyGlobalPreset ? { copyGlobalPreset: true } : {}),
        },
      );
      if (generation === request.current && key === activeKey.current) {
        setSequence(value);
        setSteps(value.steps);
        setMode(value.mode);
        setDirty(false);
      }
    } catch (error) {
      if (generation === request.current && key === activeKey.current)
        setError(
          error instanceof Error
            ? error.message
            : "Campaign sequence save could not be confirmed. Reload before retrying.",
        );
    } finally {
      if (key === activeKey.current) setSaving(false);
    }
  };
  const create = async (name: string) => {
    if (saving) return;
    const key = contextKey,
      generation = ++request.current;
    ++listRequest.current;
    setSaving(true);
    setError("");
    try {
      const value = await api.post<Campaign>(
        "/api/outreach/manual-follow-ups/campaign-options",
        { name },
      );
      if (key === activeKey.current && generation === request.current) {
        setSaving(false);
        setCampaigns((current) => [...current, value]);
        setSelected(`${value.kind}:${value.id}`);
      }
    } catch (error) {
      if (key === activeKey.current && generation === request.current)
        setError(
          error instanceof Error
            ? error.message
            : "Campaign could not be created.",
        );
    } finally {
      if (key === activeKey.current) setSaving(false);
    }
  };
  const updateSteps = (value: ManualSequenceStep[]) => {
    ++request.current;
    ++editRevision.current;
    setSteps(value);
    setDirty(true);
  };
  return {
    channel,
    enabled,
    setEnabled: (value: boolean) => {
      setEnabled(value);
      if (value && !selected && suggestedCampaign) {
        ++request.current;
        setSelected(`${suggestedCampaign.kind}:${suggestedCampaign.id}`);
      }
    },
    campaigns,
    selected,
    setSelected: (value: string) => {
      ++request.current;
      setSelected(value);
      setSaving(false);
    },
    campaign,
    sequence: loadedContext === contextKey ? sequence : null,
    steps,
    setSteps: updateSteps,
    mode,
    setMode: (value: "manual" | "off") => {
      ++request.current;
      ++editRevision.current;
      setMode(value);
      setDirty(true);
    },
    templates,
    loading,
    loadFailed,
    saving,
    dirty,
    error,
    save,
    create,
    retry: () => {
      ++request.current;
      setReload((value) => value + 1);
    },
    // Same rule the server applies on save, checked before anyone clicks Save.
    stepsProblem: campaign ? manualSequenceStepsProblem(mode, mode === "off" ? [] : steps) : null,
    unsaved: Boolean(campaign && loadedContext === contextKey && !sequence && !loading && !loadFailed),
    fingerprint: JSON.stringify({
      campaign: campaign ? { kind: campaign.kind, id: campaign.id } : null,
      channel,
      version: sequence?.version,
      mode,
      steps,
      dirty,
    }),
    ready: Boolean(
      loadedContext === contextKey &&
      campaign &&
      sequence &&
      !dirty &&
      !loading &&
      !saving &&
      !error,
    ),
  };
}
export function CampaignManualSequencePanel({
  model,
  readOnly = false,
}: {
  model: ReturnType<typeof useCampaignManualSequence>;
  readOnly?: boolean;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<
    Array<
      ManualReview & {
        originId: number;
        previousVersion: number;
        previousReviewId: string;
      }
    >
  >([]);
  const [pendingBusy, setPendingBusy] = useState(false),
    [pendingError, setPendingError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const pendingContext = useRef(model.fingerprint);
  pendingContext.current = model.fingerprint;
  useEffect(() => {
    setPending([]);
    setConfirmed(false);
    setPendingError("");
    setPendingBusy(false);
  }, [model.fingerprint]);
  const previewPending = async () => {
    if (!model.campaign || !model.sequence) return;
    const key = model.fingerprint;
    setPendingBusy(true);
    setPendingError("");
    setConfirmed(false);
    try {
      const value = await api.post<{ items: typeof pending }>(
        "/api/outreach/manual-follow-ups/pending-preview",
        {
          campaign: { kind: model.campaign.kind, id: model.campaign.id },
          channel: model.sequence.channel,
          expectedVersion: model.sequence.version,
        },
      );
      if (key !== pendingContext.current) return;
      setPending(value.items);
      if (!value.items.length)
        setPendingError(
          "No safe unsent enrollments are available for this campaign. Sent, processing, held, replied, and uncertain work require separate review.",
        );
    } catch (error) {
      if (key === pendingContext.current)
        setPendingError(
          error instanceof Error
            ? error.message
            : "Pending enrollments could not be reviewed.",
        );
    } finally {
      if (key === pendingContext.current) setPendingBusy(false);
    }
  };
  const applyPending = async () => {
    if (!confirmed || !pending.length) return;
    const key = model.fingerprint;
    setPendingBusy(true);
    setPendingError("");
    try {
      for (const item of pending) {
        if (key !== pendingContext.current) return;
        await api.post("/api/outreach/manual-follow-ups/apply-reviewed", {
          originId: item.originId,
          reviewId: item.reviewId,
          previousReviewId: item.previousReviewId,
        });
      }
      if (key !== pendingContext.current) return;
      setPending([]);
      setConfirmed(false);
      setPendingError(
        "The reviewed revisions were applied. Each delivery still requires its original account assistant and delivery checks.",
      );
    } catch (error) {
      if (key === pendingContext.current)
        setPendingError(
          error instanceof Error
            ? error.message
            : "Some enrollment changes could not be confirmed. Reload pending enrollments before retrying.",
        );
    } finally {
      if (key === pendingContext.current) setPendingBusy(false);
    }
  };
  const selectClass =
    "min-h-11 w-full rounded-md border bg-background px-3 text-sm";
  const campaignLabels = disambiguateOptionLabels(model.campaigns,
    item => `${item.name} · ${item.kind === 'chat_thread' ? 'Campaign workspace' : 'Outreach campaign'}`,
    (item, label) => `${label} #${item.id}`);
  const templateLabels = disambiguateOptionLabels(model.templates,
    item => item.name, (item, label) => `${label} · Template #${item.id}`);
  return (
    <section
      aria-label="Campaign manual follow-ups"
      className="space-y-3 rounded-md border p-4"
    >
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={model.enabled}
          disabled={readOnly}
          onChange={(event) => model.setEnabled(event.target.checked)}
        />
        Use a campaign manual sequence
      </label>
      {model.enabled && (
        <>
          <p className="text-xs text-muted-foreground">
            The campaign sequence replaces the follow-ups set for this
            outreach. Turn this off to use those again; they are kept.
          </p>
          <p className="text-xs text-muted-foreground">
            Save once for this campaign and channel. Later batches reuse its
            saved revision. Saving changes applies to new enrollments; pending
            deliveries keep their reviewed revision.
          </p>
          <label className="block space-y-1 text-sm">
            <span>Manual follow-up campaign</span>
            <select
              aria-label="Manual follow-up campaign"
              className={selectClass}
              value={model.selected}
              disabled={readOnly || model.saving}
              onChange={(event) => model.setSelected(event.target.value)}
            >
              <option value="">Choose a campaign</option>
              {model.campaigns.map((item, index) => (
                <option
                  key={`${item.kind}:${item.id}`}
                  value={`${item.kind}:${item.id}`}
                >
                  {campaignLabels[index]}
                </option>
              ))}
            </select>
          </label>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="New manual campaign name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New campaign name"
                className="min-w-40 flex-1"
              />
              <Button
                variant="outline"
                disabled={!name.trim() || model.saving}
                onClick={() => void model.create(name)}
              >
                Create campaign
              </Button>
            </div>
          )}
          {model.campaign && (
            <>
              <label className="block space-y-1 text-sm">
                <span>Campaign follow-up mode</span>
                <select
                  aria-label="Campaign follow-up mode"
                  className={selectClass}
                  disabled={readOnly || model.saving}
                  value={model.mode}
                  onChange={(event) =>
                    model.setMode(event.target.value as "manual" | "off")
                  }
                >
                  <option value="manual">Manual templates</option>
                  <option value="off">Off for this campaign</option>
                </select>
              </label>
              <ol className="space-y-3">
                {model.steps.map((step, index) => (
                  <li
                    key={index}
                    className="flex flex-wrap items-end gap-2 border-t pt-3"
                  >
                    <label className="min-w-32 flex-1 space-y-1 text-xs">
                      <span>
                        Step {index + 1} · minutes after initial message
                        {formatDelayHint(step.delayMinutes) && (
                          <span className="text-muted-foreground"> ({formatDelayHint(step.delayMinutes)})</span>
                        )}
                      </span>
                      <Input
                        aria-label={`Step ${index + 1} delay minutes`}
                        type="number"
                        min="1"
                        max="129600"
                        value={step.delayMinutes}
                        disabled={readOnly || model.saving}
                        onChange={(event) =>
                          model.setSteps(
                            model.steps.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    delayMinutes: Number(event.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="min-w-40 flex-1 space-y-1 text-xs">
                      <span>Approved template</span>
                      <select
                        aria-label={`Step ${index + 1} template`}
                        className={selectClass}
                        value={step.templateId || ""}
                        disabled={readOnly || model.saving}
                        onChange={(event) =>
                          model.setSteps(
                            model.steps.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    templateId: Number(event.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="">Choose a template</option>
                        {model.templates.map((item, index) => (
                          <option key={item.id} value={item.id}>
                            {templateLabels[index]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        disabled={model.saving}
                        onClick={() =>
                          model.setSteps(
                            model.steps.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove step {index + 1}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      model.mode === "off" ||
                      model.steps.length >= 3 ||
                      model.saving
                    }
                    onClick={() =>
                      model.setSteps([
                        ...model.steps,
                        {
                          delayMinutes:
                            (model.steps.at(-1)?.delayMinutes || 0) + 1440,
                          templateId: 0,
                        },
                      ])
                    }
                  >
                    Add manual step
                  </Button>
                  <Button
                    disabled={model.loading || model.saving || model.loadFailed || Boolean(model.stepsProblem)}
                    onClick={() => void model.save()}
                  >
                    Save campaign sequence
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      model.loading ||
                      model.saving ||
                      model.loadFailed ||
                      model.mode === "off"
                    }
                    onClick={() => void model.save(true)}
                  >
                    Copy global defaults as preset
                  </Button>
                </div>
              )}
              {!readOnly && model.stepsProblem && !model.loading && !model.loadFailed && (
                <p role="status" className="text-xs text-muted-foreground">
                  {model.stepsProblem === "steps"
                    ? "Add at least one step, or set this campaign to Off, before saving."
                    : model.stepsProblem === "delay"
                      ? "Give each step a later time than the one before, within 90 days (129,600 minutes)."
                      : model.templates.length
                        ? "Choose an approved template for every step before saving."
                        : <>There are no approved templates for this channel yet. Approve one in the{" "}
                          <Link className="underline" href={`/dashboard/saved-templates/${model.channel === "email" || model.channel === "sms" || model.channel === "whatsapp" ? model.channel : "dm"}`}>template library</Link>
                          , or set this campaign to Off.</>}
                </p>
              )}
              {model.unsaved && (
                <p role="status" className="text-xs">
                  This campaign has no saved sequence yet. Save it to continue to review.
                </p>
              )}
              {model.sequence && (
                <p role="status" className="text-xs">
                  Saved campaign revision {model.sequence.version}
                  {model.dirty ? " · Unsaved edits; save before review" : ""}
                </p>
              )}
              {!readOnly && (
                <div className="space-y-3 border-t pt-3">
                  <Button
                    variant="outline"
                    disabled={!model.ready || pendingBusy}
                    onClick={() => void previewPending()}
                  >
                    Preview revision for unsent enrollments
                  </Button>
                  {pending.map((item) => (
                    <div
                      key={item.originId}
                      className="space-y-2 rounded border p-3 text-sm"
                    >
                      <p>
                        Enrollment {item.originId} · revision{" "}
                        {item.previousVersion} → {item.sequence.version}
                      </p>
                      {Object.values(item.recipients).map(
                        (recipient, index) => (
                          <div key={index}>
                            <p>To: {recipient.recipient}</p>
                            {recipient.steps.map((step, stepIndex) => (
                              <div
                                key={stepIndex}
                                className="my-2 border-t pt-2"
                              >
                                <p className="text-xs">
                                  Step {stepIndex + 1} · {step.delayMinutes}{" "}
                                  minutes after initial message · template
                                  revision {step.sourceTemplateVersion}
                                </p>
                                {step.subject && <p>{step.subject}</p>}
                                <EmailMessageContent
                                  content={step.message}
                                  htmlContent={step.htmlContent}
                                />
                              </div>
                            ))}
                          </div>
                        ),
                      )}
                    </div>
                  ))}
                  {pending.length > 0 && (
                    <>
                      <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={pendingBusy}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                        />
                        I reviewed these recipients, timings, and messages for
                        the new campaign revision.
                      </label>
                      <Button
                        disabled={!confirmed || pendingBusy}
                        onClick={() => void applyPending()}
                      >
                        Apply reviewed revision to {pending.length} unsent
                        enrollments
                      </Button>
                    </>
                  )}
                  {pendingError && (
                    <p role="status" className="text-sm">
                      {pendingError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {model.loading && <p role="status">Loading campaign sequence…</p>}
          {model.error && (
            <p role="alert" className="text-sm text-destructive">
              {model.error}
            </p>
          )}
          {!readOnly && (
            <Button
              variant="ghost"
              disabled={model.saving}
              onClick={model.retry}
            >
              Reload saved campaign sequence
            </Button>
          )}
        </>
      )}
    </section>
  );
}
