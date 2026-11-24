import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CampaignDeliveryReview from "@/components/outreach/CampaignDeliveryReview";
import { ApiError } from '@/lib/api-client';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));
const campaign = { id: 22, campaign_name: "Spring", campaign_type: "both", status: "draft" };
const emailAccount = { id: "email-7", label: "Sales Gmail", senderId: 7, providerAccountId: "g-7", ready: true, isDefault: true, reason: null, assistant: { ready: true, assistantId: 'reviewed-email', assistantName: 'Reviewed email assistant', setupUrl: '/dashboard/settings/outreach/assistants/reviewed-email', channel: 'email', accountId: 'g-7' } };
const smsAccount = { id: "sms-4", label: "MSG91 Sales", providerAccountId: "s-4", ready: true, isDefault: true, reason: null, assistant: { ready: true, assistantId: 'reviewed-sms', assistantName: 'Reviewed SMS assistant', setupUrl: '/dashboard/settings/outreach/assistants/reviewed-sms', channel: 'sms', accountId: 's-4' } };
const preview = {
  campaign, reviewHash: "current-hash",
  summaries: [{ channel: "email", account: "Sales Gmail", recipientCount: 1, stepCount: 1 }, { channel: "sms", account: "MSG91 Sales", recipientCount: 1, stepCount: 1 }],
  skipped: [{ leadId: 42, channel: "email", reason: "Opted out" }],
  messages: [{ leadId: 10, channel: "email", stepNumber: 1, recipient: "maya@example.test", subject: "Hello Maya", content: "Maya, we can help Acme.", scheduledFor: "2026-10-05T12:00:00Z" }, { leadId: 10, channel: "sms", stepNumber: 1, recipient: "+15555550100", content: "Hello Maya", scheduledFor: "2026-10-05T12:00:00Z" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => url.includes("options") ? { channel: url.endsWith("email") ? "email" : "sms", accounts: url.endsWith("email") ? [emailAccount] : [smsAccount] } : { campaign });
  mocks.post.mockImplementation(async (url: string) => url.endsWith("preview") ? preview : { campaign: { ...campaign, status: "scheduled" } });
});
afterEach(cleanup);
async function selectAccounts() {
  await screen.findByLabelText("Email sending account");
  fireEvent.change(screen.getByLabelText("Email sending account"), { target: { value: "email-7" } });
  fireEvent.change(screen.getByLabelText("SMS sending account"), { target: { value: "sms-4" } });
}
async function getPreview() {
  await selectAccounts();
  fireEvent.click(screen.getByRole("button", { name: "Preview recipients and messages" }));
  await screen.findByText("Maya, we can help Acme.");
}
describe("campaign delivery review", () => {
  it.each([true, false])('shows whether automatic email replies are enabled: %s', async (enabled) => {
    mocks.get.mockImplementation(async (url: string) => url.includes('options')
      ? { channel: url.endsWith('email') ? 'email' : 'sms', accounts: url.endsWith('email') ? [emailAccount] : [smsAccount] }
      : { campaign: { ...campaign, settings: { replyPolicy: { autoSend: enabled } } } });
    render(<CampaignDeliveryReview campaignId={22} />);
    expect(await screen.findByText(enabled ? /Automatic email replies: On/ : /Automatic email replies: Off/)).toBeInTheDocument();
  });
  it('shows assistant setup and blocks preview while a connected account is not ready', async () => {
    mocks.get.mockImplementation(async (url: string) => url.includes('options') ? { channel: url.endsWith('email') ? 'email' : 'sms', accounts: [{ ...(url.endsWith('email') ? emailAccount : smsAccount), ready: false, reason: 'An assistant is required.', assistant: { ready: false, error: 'An assistant is required.', setupUrl: '/dashboard/settings/outreach', channel: 'email', accountId: 'g-7' } }] } : { campaign });
    render(<CampaignDeliveryReview campaignId={22} />);
    await screen.findByLabelText('Email sending account');
    expect(screen.getAllByRole('link', { name: 'Set up required assistant' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Preview recipients and messages' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('invalidates approval and exposes setup after a stale final scheduling gate', async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('schedule')) throw new ApiError('Assistant paused.', 409, { code: 'ASSISTANT_SETUP_REQUIRED', error: 'Assistant paused.', setupUrl: '/dashboard/settings/outreach' });
      return preview;
    });
    render(<CampaignDeliveryReview campaignId={22} />);
    await getPreview(); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Schedule reviewed campaign' }));
    expect(await screen.findByRole('link', { name: 'Set up required assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview recipients and messages' })).toBeDisabled();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("requires explicit accounts, exact preview and consent before scheduling", async () => {
    const onScheduled = vi.fn();
    render(<CampaignDeliveryReview campaignId={22} onScheduled={onScheduled} />);
    await screen.findByLabelText("Email sending account");
    expect(screen.getByLabelText("Email sending account")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Preview recipients and messages" })).toBeDisabled();
    await getPreview();
    expect(screen.getByText("Hello Maya", { selector: "p.font-medium" })).toBeInTheDocument();
    expect(screen.getByText(/Opted out/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule reviewed campaign" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Schedule reviewed campaign" }));
    await waitFor(() => expect(onScheduled).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled" })));
    expect(mocks.post).toHaveBeenLastCalledWith("/api/outreach/campaigns/22/schedule", {
      accounts: { email: { senderId: 7, providerAccountId: "g-7" }, sms: { senderId: undefined, providerAccountId: "s-4" } },
      start_date: undefined, review_hash: "current-hash",
    });
  });
  it.each(["account", "date"])("invalidates approval when the %s changes", async (field) => {
    render(<CampaignDeliveryReview campaignId={22} />);
    await getPreview(); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(field === "account" ? "Email sending account" : "Start time (your local time)"), { target: { value: field === "account" ? "" : "2026-10-06T15:00" } });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule reviewed campaign" })).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh preview after a server stale-review rejection", async () => {
    mocks.post.mockImplementation(async (url: string) => { if (url.endsWith("schedule")) throw new Error("Recipients changed. Review again."); return preview; });
    render(<CampaignDeliveryReview campaignId={22} />);
    await getPreview(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Schedule reviewed campaign" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview recipients and messages" })).toBeEnabled();
  });
  it("does not offer to resume historical paused jobs", async () => {
    mocks.get.mockResolvedValue({ campaign: { ...campaign, status: "paused", settings: { accountReviewRequired: true } } });
    render(<CampaignDeliveryReview campaignId={22} />);
    await screen.findByText(/Historical deliveries remain paused/);
    expect(screen.queryByLabelText("Email sending account")).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("discards a preview returned for a campaign that was replaced", async () => {
    let resolvePreview!: (value: typeof preview) => void;
    mocks.post.mockImplementation(() => new Promise(resolve => { resolvePreview = resolve; }));
    const view = render(<CampaignDeliveryReview campaignId={22} />);
    await selectAccounts(); fireEvent.click(screen.getByRole("button", { name: "Preview recipients and messages" }));
    view.rerender(<CampaignDeliveryReview campaignId={23} />);
    await screen.findByLabelText("Email sending account");
    resolvePreview(preview);
    await waitFor(() => expect(screen.getByLabelText("Email sending account")).toHaveValue(""));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("does not replace the current draft when an earlier launch finishes", async () => {
    let resolveSchedule!: (value: { campaign: typeof campaign }) => void;
    mocks.post.mockImplementation((url: string) => url.endsWith("preview") ? Promise.resolve(preview) : new Promise(resolve => { resolveSchedule = resolve; }));
    const onScheduled = vi.fn();
    const view = render(<CampaignDeliveryReview campaignId={22} onScheduled={onScheduled} />);
    await getPreview(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Schedule reviewed campaign" }));
    view.rerender(<CampaignDeliveryReview campaignId={23} onScheduled={onScheduled} />);
    await screen.findByLabelText("Email sending account");
    resolveSchedule({ campaign: { ...campaign, status: "scheduled" } });
    await waitFor(() => expect(screen.getByLabelText("Email sending account")).toHaveValue(""));
    expect(screen.queryByText(/Reviewed campaign scheduled/)).not.toBeInTheDocument();
    expect(onScheduled).not.toHaveBeenCalled();
  });
});
