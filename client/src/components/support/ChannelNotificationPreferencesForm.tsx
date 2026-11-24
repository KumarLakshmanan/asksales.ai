"use client";

import { useEffect, useId, useState } from "react";
import { BellRing, Mail, MessageCircle, Save, ShieldCheck, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface SupportChannelPreference {
  enabled: boolean;
  recipient: string;
  destinationHint?: string;
  verificationStatus?: "unverified" | "pending" | "verified" | "owner_verified" | "failed";
  availability?: "available" | "configuration_required" | "verification_required" | "policy_blocked" | "provider_unavailable";
  events: {
    ticketCreatedUnassigned: boolean;
    ticketAssigned: boolean;
    ticketReassigned: boolean;
    humanHandoff: boolean;
    customerReplied: boolean;
    ticketReopened: boolean;
    slaAtRisk: boolean;
    slaBreached: boolean;
    approvalRequired: boolean;
    deliveryFailed: boolean;
    ticketResolved: boolean;
  };
}

export interface SupportMemberNotificationPreferences {
  email: SupportChannelPreference;
  whatsapp: SupportChannelPreference;
  slack: SupportChannelPreference;
  teams: SupportChannelPreference;
}

const DEFAULT_EVENTS = {
  ticketCreatedUnassigned: false, ticketAssigned: true, ticketReassigned: true, humanHandoff: true,
  customerReplied: true, ticketReopened: true, slaAtRisk: true, slaBreached: true,
  approvalRequired: true, deliveryFailed: true, ticketResolved: false,
};

export const EMPTY_SUPPORT_NOTIFICATION_PREFERENCES: SupportMemberNotificationPreferences = {
  email: {
    enabled: false,
    recipient: "",
    verificationStatus: "unverified",
    events: { ...DEFAULT_EVENTS },
  },
  whatsapp: {
    enabled: false,
    recipient: "",
    verificationStatus: "unverified",
    events: { ...DEFAULT_EVENTS },
  },
  slack: {
    enabled: false,
    recipient: "",
    verificationStatus: "unverified",
    events: { ...DEFAULT_EVENTS },
  },
  teams: {
    enabled: false,
    recipient: "",
    verificationStatus: "unverified",
    events: { ...DEFAULT_EVENTS },
  },
};

const CHANNELS = [
  {
    key: "email" as const,
    label: "Email",
    description: "Use email for direct operational alerts selected by the owner.",
    placeholder: "agent@example.com",
    icon: Mail,
  },
  {
    key: "whatsapp" as const,
    label: "WhatsApp",
    description: "Optional employee alerts using an approved WhatsApp template.",
    placeholder: "Country code and number, e.g. +919876543210",
    icon: MessageCircle,
  },
  {
    key: "slack" as const,
    label: "Slack",
    description: "Send support alerts to a verified team webhook.",
    placeholder: "https://hooks.slack.com/services/...",
    icon: Webhook,
  },
  {
    key: "teams" as const,
    label: "Microsoft Teams",
    description: "Send support alerts to a verified Teams workflow webhook.",
    placeholder: "https://...webhook.office.com/...",
    icon: Webhook,
  },
];

export function toWritableSupportNotificationPreferences(
  preferences: SupportMemberNotificationPreferences,
): SupportMemberNotificationPreferences {
  return Object.fromEntries(CHANNELS.map(({ key }) => {
    const { enabled, recipient, events } = preferences[key];
    return [key, { enabled, recipient, events: { ...events } }];
  })) as unknown as SupportMemberNotificationPreferences;
}

export function ChannelNotificationPreferencesForm({
  value,
  onSave,
  onRequestVerification,
  onConfirmVerification,
  ownerAttestationMode = false,
  visibleChannels,
  compact = false,
}: {
  value?: SupportMemberNotificationPreferences | null;
  onSave: (
    preferences: SupportMemberNotificationPreferences,
    options?: { ownerConsentAcknowledged: boolean },
  ) => Promise<void>;
  onRequestVerification?: (channel: keyof SupportMemberNotificationPreferences) => Promise<{ developmentCode?: string }>;
  onConfirmVerification?: (channel: keyof SupportMemberNotificationPreferences, code: string) => Promise<void>;
  ownerAttestationMode?: boolean;
  visibleChannels?: Array<keyof SupportMemberNotificationPreferences>;
  compact?: boolean;
}) {
  const [preferences, setPreferences] = useState<SupportMemberNotificationPreferences>(
    value || EMPTY_SUPPORT_NOTIFICATION_PREFERENCES,
  );
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<keyof SupportMemberNotificationPreferences | null>(null);
  const [verificationCodes, setVerificationCodes] = useState<Partial<Record<keyof SupportMemberNotificationPreferences, string>>>({});
  const [ownerConsentAcknowledged, setOwnerConsentAcknowledged] = useState(false);
  const formId = useId();

  useEffect(() => {
    setPreferences(value || EMPTY_SUPPORT_NOTIFICATION_PREFERENCES);
    setOwnerConsentAcknowledged(false);
  }, [value]);

  const displayedChannels = CHANNELS.filter(({ key }) => !visibleChannels || visibleChannels.includes(key));
  const missingDestination = displayedChannels.some(({ key }) =>
    preferences[key].enabled
      && !preferences[key].recipient.trim()
      && !preferences[key].destinationHint?.trim(),
  );

  const save = async () => {
    setSaving(true);
    try {
      await onSave(toWritableSupportNotificationPreferences(preferences), { ownerConsentAcknowledged });
    } catch {
      // The parent surface owns the error toast. Keep the form interactive
      // without producing an unhandled rejected promise in the browser.
    } finally {
      setSaving(false);
    }
  };

  const requestVerification = async (channel: keyof SupportMemberNotificationPreferences) => {
    if (!onRequestVerification) return;
    setVerifying(channel);
    try {
      const result = await onRequestVerification(channel);
      if (result.developmentCode) {
        setVerificationCodes((current) => ({ ...current, [channel]: result.developmentCode }));
      }
      setPreferences((current) => ({
        ...current,
        [channel]: { ...current[channel], verificationStatus: "pending" },
      }));
    } finally {
      setVerifying(null);
    }
  };

  const confirmVerification = async (channel: keyof SupportMemberNotificationPreferences) => {
    const code = verificationCodes[channel]?.trim() || "";
    if (!onConfirmVerification || !/^\d{6}$/.test(code)) return;
    setVerifying(channel);
    try {
      await onConfirmVerification(channel, code);
      setPreferences((current) => ({
        ...current,
        [channel]: { ...current[channel], verificationStatus: "verified" },
      }));
      setVerificationCodes((current) => ({ ...current, [channel]: "" }));
    } finally {
      setVerifying(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className={compact ? "space-y-2" : "grid gap-3 lg:grid-cols-3"}>
        {displayedChannels.map(({ key, label, description, placeholder, icon: Icon }) => {
          const channel = preferences[key];
          return (
            <div key={key} className="rounded-xl border border-border/60 bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <Label htmlFor={`${formId}-${key}-support-notification`} className="text-xs font-semibold">
                      Enable notifications in {label}
                    </Label>
                    {!compact && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>}
                    <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                      {channel.availability && channel.availability !== "available"
                        ? channel.availability.replaceAll("_", " ")
                        : channel.verificationStatus === "verified" || channel.verificationStatus === "owner_verified"
                          ? channel.verificationStatus === "owner_verified" ? "Owner verified and available" : "Verified and available"
                          : channel.verificationStatus === "pending"
                            ? "Verification pending"
                            : "Verification required"}
                    </p>
                  </div>
                </div>
                <Switch
                  id={`${formId}-${key}-support-notification`}
                  checked={channel.enabled}
                  onCheckedChange={(enabled) => setPreferences((current) => ({
                    ...current,
                    [key]: { ...current[key], enabled },
                  }))}
                  aria-label={`Enable support notifications in ${label}`}
                />
              </div>
              <Input
                className="mt-3 h-9 text-xs"
                value={channel.recipient}
                onChange={(event) => setPreferences((current) => ({
                  ...current,
                  [key]: { ...current[key], recipient: event.target.value },
                }))}
                placeholder={channel.destinationHint || placeholder}
                aria-label={`${label} notification destination`}
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch
                    checked={channel.events.ticketAssigned}
                    onCheckedChange={(enabled) => setPreferences((current) => ({
                      ...current,
                      [key]: {
                        ...current[key],
                        events: { ...current[key].events, ticketAssigned: enabled, ticketReassigned: enabled },
                      },
                    }))}
                    aria-label={`${label} ticket assignments`}
                  />
                  Assignments
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch
                    checked={channel.events.humanHandoff}
                    onCheckedChange={(enabled) => setPreferences((current) => ({
                      ...current,
                      [key]: {
                        ...current[key],
                        events: { ...current[key].events, humanHandoff: enabled },
                      },
                    }))}
                    aria-label={`${label} human handoffs`}
                  />
                  Human handoffs
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch checked={channel.events.customerReplied} onCheckedChange={(enabled) => setPreferences((current) => ({
                    ...current, [key]: { ...current[key], events: { ...current[key].events, customerReplied: enabled, ticketReopened: enabled } },
                  }))} aria-label={`${label} customer replies`} />
                  Customer replies
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch checked={channel.events.slaBreached} onCheckedChange={(enabled) => setPreferences((current) => ({
                    ...current, [key]: { ...current[key], events: { ...current[key].events, slaAtRisk: enabled, slaBreached: enabled } },
                  }))} aria-label={`${label} SLA alerts`} />
                  SLA alerts
                </label>
              </div>
              {!ownerAttestationMode && onRequestVerification && channel.enabled
                && channel.verificationStatus !== "verified" && channel.verificationStatus !== "owner_verified" && (
                <div className="mt-2 flex gap-2">
                  {channel.verificationStatus === "pending" ? (
                    <>
                      <Input
                        className="h-8 text-xs"
                        inputMode="numeric"
                        maxLength={6}
                        value={verificationCodes[key] || ""}
                        onChange={(event) => setVerificationCodes((current) => ({
                          ...current,
                          [key]: event.target.value.replace(/\D/g, ""),
                        }))}
                        placeholder="6-digit code"
                        aria-label={`${label} verification code`}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={verifying === key || !/^\d{6}$/.test(verificationCodes[key] || "")}
                        onClick={() => void confirmVerification(key)}
                      >
                        <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                        Verify
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={verifying === key}
                      disabled={!channel.recipient.trim() && !channel.destinationHint?.trim()}
                      onClick={() => void requestVerification(key)}
                    >
                      Send verification
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {ownerAttestationMode && preferences.whatsapp.enabled && (
        <label className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border"
            checked={ownerConsentAcknowledged}
            onChange={(event) => setOwnerConsentAcknowledged(event.target.checked)}
            aria-label="Confirm WhatsApp notification authorization"
          />
          <span>
            I confirm this support member is authorized to receive operational WhatsApp ticket alerts at the configured number.
          </span>
        </label>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <BellRing className="h-3.5 w-3.5" />
          In-app alerts are always available. External alerts require a verified destination and explicit event opt-in.
        </p>
        <Button
          size="sm"
          onClick={() => void save()}
          loading={saving}
          loadingText="Saving…"
          disabled={missingDestination || (ownerAttestationMode && preferences.whatsapp.enabled && !ownerConsentAcknowledged)}
        >
          <Save className="mr-2 h-3.5 w-3.5" />
          Save notifications
        </Button>
      </div>
    </div>
  );
}
