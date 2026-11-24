import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailIntegration } from "@/app/dashboard/(main)/integrations/email/components/GmailIntegration";
import { ResendDomains } from "@/app/dashboard/(main)/integrations/email/components/ResendDomains";
import { ActiveSenders } from "@/app/dashboard/(main)/integrations/email/components/ActiveSenders";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { EmailStatusHeader } from "@/components/integrations/StatusHeader";
import type { ResendDomain } from "@/app/dashboard/(main)/integrations/email/components/types";

afterEach(cleanup);

const pendingDomain: ResendDomain = {
  id: 7, resendDomainId: "re_7", name: "mail.example.com", status: "pending", region: "us-east-1", createdAt: "2026-09-27",
  dnsRecords: [{ record: "DKIM", name: "mail", type: "TXT", ttl: "Auto", status: "pending", value: "verification-value" }],
};

describe("email connection options", () => {
  it("labels retained Gmail data as last known while a failed refresh is retried", () => {
    const props = { connecting: false, disconnecting: false, refreshing: false, settingUpWatch: false, onConnect: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onSetupWatch: vi.fn() };
    const status = { connected: true, email: "mailbox@example.test", watchStatus: "active" as const };
    const { rerender } = render(<GmailIntegration {...props} gmailStatus={status} refreshError="Gmail status could not be refreshed." />);
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.getByText("Previously connected through Google")).toBeInTheDocument();
    expect(screen.getByText("Last known reply sync is active")).toBeInTheDocument();
    expect(screen.queryByText("New replies from this Gmail account are being monitored.")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry Gmail status" });
    expect(retry).toHaveAccessibleDescription(/last known Gmail status/);
    expect(retry).toBeEnabled();
    rerender(<GmailIntegration {...props} gmailStatus={status} refreshing refreshError="Gmail status could not be refreshed." />);
    expect(retry).toBeDisabled();
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("shows email connection options inside the main card", () => {
    render(<IntegrationWorkspace provider="email" state="disconnected" onConnect={vi.fn()} settingsLabel="Email connections" settings={<div>Gmail and sending domains</div>} />);
    expect(screen.getByRole("region", { name: "Email connection" })).toContainElement(screen.getByText("Gmail and sending domains"));
    expect(screen.getByText("Gmail and sending domains")).toBeVisible();
    expect(screen.queryByText("Advanced connection settings")).not.toBeInTheDocument();
  });

  it("makes expired Gmail authorization and reply sync actions clear", async () => {
    const connect = vi.fn();
    const setupWatch = vi.fn();
    const props = { connecting: false, disconnecting: false, refreshing: false, settingUpWatch: false, onConnect: connect, onDisconnect: vi.fn(), onRefresh: vi.fn(), onSetupWatch: setupWatch };
    const { rerender } = render(<GmailIntegration {...props} gmailStatus={{ connected: true, email: "hello@example.com", tokenExpired: true }} />);
    expect(screen.getByText("Gmail authorization expired")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Gmail" }));
    expect(connect).toHaveBeenCalledOnce();

    rerender(<GmailIntegration {...props} gmailStatus={{ connected: true, email: "hello@example.com", watchStatus: "expired" }} />);
    expect(screen.getByText("Reply sync needs attention")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restart sync" }));
    expect(setupWatch).toHaveBeenCalledOnce();
  });

  it("offers reconnection for a saved Gmail sender without claiming it is connected", async () => {
    const connect = vi.fn();
    render(<>
      <EmailStatusHeader gmailConnected={false} gmailNeedsReconnect resendConnected={false} />
      <GmailIntegration gmailStatus={{ connected: false, email: null }} reconnectEmail="hello@example.com" connecting={false} disconnecting={false} refreshing={false} settingUpWatch={false} onConnect={connect} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSetupWatch={vi.fn()} />
    </>);
    expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.getByText("hello@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Connected through Google")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Gmail" }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it("explains when Gmail sign-in is not configured and prevents a failed reconnect", () => {
    render(<GmailIntegration gmailStatus={{ connected: false, email: null, configSource: "none" }} reconnectEmail="hello@example.com" connecting={false} disconnecting={false} refreshing={false} settingUpWatch={false} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSetupWatch={vi.fn()} />);
    expect(screen.getByText(/Ask the app administrator to configure Gmail sign-in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect Gmail" })).toBeDisabled();
  });

  it("shows pending DNS records and keeps verification available", async () => {
    const verify = vi.fn();
    render(<ResendDomains domains={[pendingDomain]} domainName="" addingDomain={false} verifyingId={null} deletingId={null} sendingTest={false} testEmail="" copiedValue={null} expandedDomainId="re_7" onAddDomain={vi.fn()} onDeleteDomain={vi.fn()} onVerifyDomain={verify} onSendTest={vi.fn()} onSetDomainName={vi.fn()} onSetTestEmail={vi.fn()} onSetExpandedDomainId={vi.fn()} onRefreshDns={vi.fn()} refreshingDnsId={null} copyToClipboard={vi.fn()} />);
    expect(screen.getByText("verification-value")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check verification" }));
    expect(verify).toHaveBeenCalledWith("re_7");
  });

  it("requires a verified domain before creating a sender", () => {
    const props = { emailSenders: [], showAddSender: false, newSenderEmail: "", newSenderLabel: "", newSenderDisplayName: "", addingSender: false, selectedDomainId: null, settingDefaultId: null, deletingSenderId: null, onSetShowAddSender: vi.fn(), onSetNewSenderEmail: vi.fn(), onSetNewSenderLabel: vi.fn(), onSetNewSenderDisplayName: vi.fn(), onSetSelectedDomainId: vi.fn(), onAddSender: vi.fn(), onDeleteSender: vi.fn(), onSetDefaultSender: vi.fn() };
    const { rerender } = render(<ActiveSenders {...props} domains={[pendingDomain]} />);
    expect(screen.getByRole("button", { name: "Add sender" })).toBeDisabled();
    rerender(<ActiveSenders {...props} domains={[{ ...pendingDomain, status: "verified" }]} />);
    expect(screen.getByRole("button", { name: "Add sender" })).toBeEnabled();
  });

  it("marks only Gmail senders with their own active connection ready", () => {
    const sender = { id: 12, type: "gmail" as const, email: "hello@example.com", label: "Gmail", displayName: null, isVerified: true, isDefault: false, createdAt: "2026-09-27", connectionActive: false };
    const props = { emailSenders: [sender], domains: [], showAddSender: false, newSenderEmail: "", newSenderLabel: "", newSenderDisplayName: "", addingSender: false, selectedDomainId: null, settingDefaultId: null, deletingSenderId: null, onSetShowAddSender: vi.fn(), onSetNewSenderEmail: vi.fn(), onSetNewSenderLabel: vi.fn(), onSetNewSenderDisplayName: vi.fn(), onSetSelectedDomainId: vi.fn(), onAddSender: vi.fn(), onDeleteSender: vi.fn(), onSetDefaultSender: vi.fn() };
    const { rerender } = render(<ActiveSenders {...props} />);
    expect(screen.getByText("Gmail · Reconnect Gmail to send")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make default" })).toBeDisabled();
    rerender(<ActiveSenders {...props} emailSenders={[{ ...sender, connectionActive: true }]} />);
    expect(screen.getByText("Gmail · Ready to send")).toBeInTheDocument();
  });
});

it('shows an issuing-client mismatch as reconnect required without a saved sender', () => {
  render(<GmailIntegration gmailStatus={{connected:false,email:'fixture@example.test',requiresReconnect:true}} connecting={false} disconnecting={false} refreshing={false} settingUpWatch={false} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSetupWatch={vi.fn()} />);
  expect(screen.getByRole('button',{name:'Reconnect Gmail'})).toBeEnabled();
  expect(screen.queryByText('Connected through Google')).not.toBeInTheDocument();
});
it('makes Gmail cooldown and delayed reply sync visible without claiming lost authorization', () => {
  render(<GmailIntegration gmailStatus={{connected:true,email:'fixture@example.test',connectionState:'rate_limited',cooldownUntil:'2099-01-01T00:00:00Z',syncFailures:2,syncRetryAt:'2099-01-01T00:00:00Z'}} connecting={false} disconnecting={false} refreshing={false} settingUpWatch={false} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSetupWatch={vi.fn()} />);
  expect(screen.getByText(/Google temporarily limited this mailbox/)).toBeInTheDocument();
  expect(screen.getByText(/Reply sync is delayed/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Reconnect Gmail'})).not.toBeInTheDocument();
});

it('shows queued reply sync without claiming completed synchronization or hiding retry failures', () => {
  const props = { connecting: false, disconnecting: false, refreshing: false, settingUpWatch: false, onConnect: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onSetupWatch: vi.fn() };
  const { rerender } = render(<GmailIntegration {...props} gmailStatus={{ connected: true, email: 'mailbox@example.test', syncPending: true }} />);
  expect(screen.getByText(/Reply sync is queued or processing/)).toBeInTheDocument();
  rerender(<GmailIntegration {...props} gmailStatus={{ connected: true, email: 'mailbox@example.test', syncPending: true, syncFailures: 1 }} />);
  expect(screen.getByText(/Reply sync is delayed/)).toBeInTheDocument();
  expect(screen.queryByText(/Reply sync is queued or processing/)).not.toBeInTheDocument();
  rerender(<GmailIntegration {...props} gmailStatus={{ connected: true, email: 'mailbox@example.test', syncPending: false }} />);
  expect(screen.queryByText(/Reply sync is queued or processing/)).not.toBeInTheDocument();
});
