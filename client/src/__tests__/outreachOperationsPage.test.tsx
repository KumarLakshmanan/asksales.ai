import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportOrchestrationPage from "@/app/dashboard/(main)/settings/outreach/orchestration/page";
import { hasCurrentDeliveryReconciliation } from "@/lib/delivery-reconciliation";

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), push: vi.fn() }));

vi.mock("@/lib/api", () => ({ default: { get: mocks.get, post: vi.fn() } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/use-outreach-assistants", () => ({
  useAssistantWorkspace: () => ({
    profileId: 1,
    scopeKey: ['outreach-assistants', 1, 1],
    requestOptions: { headers: { 'X-Business-Profile-Id': '1' } },
    profiles: { isLoading: false, isError: false },
  }),
  useAssistantList: () => ({
    data: { assistants: [], runtimeEnabled: true },
    isLoading: false,
    isError: false,
    hasNextPage: false,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/support/ConversationRecovery", () => ({ ConversationRecovery: () => null }));
vi.mock("@/components/support/PrivacyAccessHistory", () => ({ PrivacyAccessHistory: () => null }));

const report = {
  periodDays: 30,
  outcomes: [{ channel: "email", outcome: "replied", count: 4, avg_confidence: 0.9, avg_duration_ms: 100 }],
  delivery: [], handoffs: [], playbooks: [], tools: [], privacyAccess: [],
  knowledgeGaps: [], guardrails: [], adminAudit: [],
  privacy: { retained_records: 0, expiring_within_7_days: 0, configured: true },
  csat: { responses: 0, average_rating: null, rating_1: 0, rating_2: 0, rating_3: 0, rating_4: 0, rating_5: 0 },
  readiness: { llm: true, whatsapp: true, instagram: false, facebook: false, email: true, privacyVault: true, moderationEnabled: false, moderationConfigured: false, moderationFailClosed: true },
};

const reconciledFailure = {
  id: 254, conversationId: -4, channel: 'web', status: 'failed', attemptCount: 1,
  createdAt: '2026-08-29T19:20:58Z', updatedAt: '2026-09-18T06:47:41.108Z',
  reconciledAt: '2026-09-18T06:47:41.108Z', nextAttemptAt: null, leaseExpiresAt: null,
  reconciliationNote: 'Session expired; evidence reviewed during maintenance.', payload: {},
};

describe('current recorded delivery reconciliation', () => {
  it('recognizes explicit current reconciliation without parsing maintenance prose', () => {
    expect(hasCurrentDeliveryReconciliation(reconciledFailure)).toBe(true);
  });
  it.each([
    { status: 'uncertain' }, { status: 'sending' },
    { reconciledAt: null }, { reconciledAt: 'invalid' },
    { updatedAt: undefined }, { updatedAt: 'invalid' },
    { updatedAt: '2026-09-18T06:48:00Z' },
    { nextAttemptAt: '2026-09-18T07:00:00Z' },
    { leaseExpiresAt: '2026-09-18T07:00:00Z' },
  ])('retains unresolved, retried or changed rows in the action queue (%j)', override => {
    expect(hasCurrentDeliveryReconciliation({ ...reconciledFailure, ...override })).toBe(false);
  });
});

describe("Outreach operations page", () => {
  beforeEach(() => {
    window.location.hash = "";
    mocks.get.mockReset();
    mocks.get.mockImplementation(async (path: string) => path.includes("orchestration-report") ? report : []);
  });

  it("starts with actionable guidance and keeps technical reports behind their tab", async () => {
    const user = userEvent.setup();
    render(<SupportOrchestrationPage />);
    expect(await screen.findByRole("heading", { name: "What needs your attention" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Open playbooks/ })).toHaveAttribute("href", "/dashboard/settings/outreach/playbooks");
    expect(screen.queryByText("System and channel status")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open test" }));
    expect(await screen.findByRole("heading", { name: "Test a reply safely" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Customer test message" })).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Review issues" }));
    expect(await screen.findByRole("heading", { name: "Verify uncertain outcomes" })).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Reports & status" }));
    expect(await screen.findByText("System and channel status")).toBeVisible();
  });

  it('keeps reconciled failures as read-only history and unresolved provider failures actionable', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path.includes('orchestration-report')) return report;
      if (path.includes('delivery-actions?status=failed')) return [reconciledFailure, {
        id: 702, conversationId: 391, channel: 'facebook', status: 'failed', attemptCount: 5,
        createdAt: '2026-09-17T18:12:45Z', updatedAt: '2026-09-17T18:30:00Z',
        reconciledAt: null, nextAttemptAt: null, lastError: 'Provider binding requires review.', payload: {},
      }];
      return [];
    });
    const user = userEvent.setup();
    render(<SupportOrchestrationPage />);
    expect(await screen.findByText('1 item need verification.')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: /Review issues/ }));
    expect(screen.getByText('Delivery reconciliation · 1')).toBeVisible();
    expect(screen.getByText('Recorded delivery reconciliations · 1')).toBeVisible();
    const history = screen.getByLabelText('Recorded reconciliation for conversation -4');
    expect(within(history).getByText(/Recorded note: Session expired/)).toBeVisible();
    expect(within(history).getByText('No retry scheduled')).toBeVisible();
    expect(within(history).queryByRole('button')).not.toBeInTheDocument();
    expect(within(history).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Conversation #391')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Confirm sent' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Confirm not sent & allow retry' })).toHaveLength(1);
  });

  it("opens the test section for existing simulator links", async () => {
    window.location.hash = "#simulator";
    render(<SupportOrchestrationPage />);
    expect(await screen.findByRole("heading", { name: "Test a reply safely" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Test a reply" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps recovery input labels visible and associated after entering values", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path.includes('orchestration-report')) return report;
      if (path.includes('tool-executions?status=failed')) return [{ id: 11, toolName: 'create_booking', riskLevel: 'high', status: 'failed',
        conversationId: 42, lastAttemptAt: '2026-10-23T00:00:00Z' }];
      if (path.includes('delivery-actions?status=uncertain')) return [{ id: 12, channel: 'email', status: 'uncertain',
        conversationId: 42, attemptCount: 1, createdAt: '2026-10-23T00:00:00Z', payload: {} }];
      return [];
    });
    const user = userEvent.setup(); render(<SupportOrchestrationPage />);
    await screen.findByRole('heading', { name: 'What needs your attention' });
    await user.click(screen.getByRole('tab', { name: /Review issues/ }));
    for (const label of ['Provider verification note', 'Provider message ID', 'Tool verification note', 'Verified result']) {
      const input = screen.getByLabelText(label, { exact: true });
      await user.type(input, 'Synthetic verification');
      expect(screen.getByText(label, { exact: true })).toBeVisible();
      expect(input).toHaveAccessibleName(label);
    }
  });
});
