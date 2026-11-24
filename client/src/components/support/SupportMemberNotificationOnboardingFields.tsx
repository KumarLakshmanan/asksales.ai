"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SupportMemberNotificationOnboardingValue {
  whatsappNumber: string;
  whatsappConsentAcknowledged: boolean;
}

export const EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING: SupportMemberNotificationOnboardingValue = {
  whatsappNumber: "",
  whatsappConsentAcknowledged: false,
};

export function SupportMemberNotificationOnboardingFields({
  value,
  onChange,
}: {
  value: SupportMemberNotificationOnboardingValue;
  onChange: (value: SupportMemberNotificationOnboardingValue) => void;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/15 p-3">
      <div>
        <p className="text-xs font-semibold">Notification contacts</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">The required login email is automatically used for email alerts. Add WhatsApp only if this member should be reachable there when the workspace-wide channel is enabled.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="support-member-whatsapp" className="text-xs text-muted-foreground">WhatsApp number with country code <span className="font-normal">(optional)</span></Label>
        <Input id="support-member-whatsapp" value={value.whatsappNumber} onChange={(event) => onChange({ ...value, whatsappNumber: event.target.value })} placeholder="+919876543210" inputMode="tel" className="h-9 text-xs" />
      </div>
      {value.whatsappNumber.trim() && (
        <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border"
            checked={value.whatsappConsentAcknowledged}
            onChange={(event) => onChange({ ...value, whatsappConsentAcknowledged: event.target.checked })}
          />
          I confirm this member is authorized to receive operational WhatsApp ticket-assignment alerts.
        </label>
      )}
    </section>
  );
}
