import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ChannelNotificationPreferencesForm,
  EMPTY_SUPPORT_NOTIFICATION_PREFERENCES,
} from "@/components/support/ChannelNotificationPreferencesForm";
import {
  EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING,
  SupportMemberNotificationOnboardingFields,
} from "@/components/support/SupportMemberNotificationOnboardingFields";

describe("support notification preference UI state", () => {
  it("captures operational destinations and lifecycle event switches", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelNotificationPreferencesForm
        value={EMPTY_SUPPORT_NOTIFICATION_PREFERENCES}
        onSave={onSave}
      />,
    );

    expect(screen.getAllByText("Assignments")).toHaveLength(4);
    expect(screen.getAllByText("Human handoffs")).toHaveLength(4);

    fireEvent.change(screen.getByLabelText("Email notification destination"), {
      target: { value: "agent@example.com" },
    });
    fireEvent.click(screen.getByLabelText("Enable support notifications in Email"));
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].email).toMatchObject({
      enabled: true,
      recipient: "agent@example.com",
      events: { ticketAssigned: true, humanHandoff: true },
    });
  });

  it("shows verification controls only for an enabled unverified destination", () => {
    render(
      <ChannelNotificationPreferencesForm
        value={{
          ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES,
          email: {
            ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES.email,
            enabled: true,
            recipient: "agent@example.com",
          },
        }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onRequestVerification={vi.fn().mockResolvedValue({ developmentCode: "123456" })}
        onConfirmVerification={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "Send verification" })).toBeInTheDocument();
  });

  it("omits read-only destination metadata from the save payload", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelNotificationPreferencesForm
        value={{
          ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES,
          email: {
            ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES.email,
            destinationHint: "s***@example.com",
            verificationStatus: "verified",
            availability: "available",
          },
        }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].email).toEqual({
      enabled: false,
      recipient: "",
      events: EMPTY_SUPPORT_NOTIFICATION_PREFERENCES.email.events,
    });
  });

  it("requires owner authorization before saving enabled WhatsApp alerts", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ChannelNotificationPreferencesForm
      ownerAttestationMode
      value={{ ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES, whatsapp: {
        ...EMPTY_SUPPORT_NOTIFICATION_PREFERENCES.whatsapp, enabled: true, recipient: "+919876543210",
      } }}
      onSave={onSave}
    />);
    const save = screen.getByRole("button", { name: "Save notifications" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Confirm WhatsApp notification authorization"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.any(Object), { ownerConsentAcknowledged: true }));
  });

  it("collects a WhatsApp contact without per-member notification switches", () => {
    const onChange = vi.fn();
    render(<SupportMemberNotificationOnboardingFields value={EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING} onChange={onChange} />);
    expect(screen.queryByLabelText("Enable WhatsApp notifications")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Enable email notifications")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/WhatsApp number with country code/i), { target: { value: "+919876543210" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      whatsappNumber: "+919876543210",
    }));
  });
});
