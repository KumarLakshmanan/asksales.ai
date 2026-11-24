import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FollowUpHistory, followUpMessageText } from "@/components/follow-ups/FollowUpHistory";
import { OutreachMessageBubble } from '@/components/outreach/OutreachMessageBubble';
import type { OutreachMessage } from '@/components/outreach/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn() }));

vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/contexts/PreferencesContext", () => ({ usePreferences: () => ({ formatDate: (value: string) => value }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/outreach/TemplateSelector", () => ({ TemplateSelector: () => null }));
vi.mock('@/components/outreach/useOutreachPage', () => ({ parseMessageContent: (text: string) => text }));

const activity = {
  id: 12,
  leadName: "Asha Rao",
  message: "Following up on the launch plan",
  status: "sent",
  deliveryStatus: "sent",
  followUpStep: 2,
  sentAt: "2026-09-21T10:00:00.000Z",
};

describe("follow-up activity log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes("/api/settings/integrations/")) return { enableAutoFollowUp: true, followUpSteps: [] };
      if (url.includes("followUps=true")) return [activity];
      return [];
    });
  });

  it('shows readable legacy HTML without executable or tracking content', () => {
    expect(followUpMessageText('<html><body><p>Hi &amp; hello</p><script>alert(1)</script><img src="https://example.com/tracker"><p>Need help?</p></body></html>')).toBe('Hi & hello\nNeed help?');
  });

  it('paginates older history without losing the first page', async () => {
    mocks.get.mockResolvedValueOnce(Array.from({ length: 25 }, (_, id) => ({ ...activity, id }))).mockResolvedValueOnce([{ ...activity, id: 99, leadName: 'Older customer' }]);
    render(<FollowUpHistory channel="email" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older follow-ups' }));
    expect(await screen.findByText('Older customer')).toBeInTheDocument();
    expect(screen.getAllByText('Asha Rao')).toHaveLength(25);
    expect(mocks.get).toHaveBeenCalledWith('/api/sent-messages?followUps=true&channel=email&limit=25&offset=25', expect.objectContaining({ signal: expect.anything() }));
  });

  it.each(['whatsapp', 'instagram', 'facebook'] as const)('labels follow-ups inside the %s conversation', channel => {
    render(<OutreachMessageBubble channel={channel} message={{
      id: 1, conversationId: 2, direction: 'outbound', content: 'Still need help?', status: 'sent',
      messageKind: 'follow_up', followUpStep: 2, sentAt: activity.sentAt, createdAt: activity.sentAt,
      deliveredAt: null, readAt: null, isRead: true,
    } satisfies OutreachMessage} />);
    expect(screen.getByText('Follow-up 2')).toBeInTheDocument();
    expect(screen.getByText('Still need help?')).toBeInTheDocument();
  });

  it.each([
    ["email", "/api/sent-messages?followUps=true&channel=email&limit=25&offset=0"],
    ["sms", "/api/sent-messages?followUps=true&channel=sms&limit=25&offset=0"],
    ["whatsapp", "/api/sent-messages?followUps=true&channel=whatsapp&limit=25&offset=0"],
    ["instagram", "/api/sent-messages?followUps=true&channel=instagram&limit=25&offset=0"],
    ["facebook", "/api/sent-messages?followUps=true&channel=facebook&limit=25&offset=0"],
  ] as const)("loads and displays %s follow-ups from its own channel log", async (channel, expectedUrl) => {
    render(<FollowUpHistory channel={channel} />);

    expect(await screen.findByText("Follow-up history")).toBeInTheDocument();
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.getByText("Following up on the launch plan")).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ signal: expect.anything() })));
  });
});
