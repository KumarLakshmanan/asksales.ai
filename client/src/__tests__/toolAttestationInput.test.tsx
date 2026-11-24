import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportOrchestrationPage from "@/app/dashboard/(main)/settings/outreach/orchestration/page";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/support/ConversationRecovery", () => ({
  ConversationRecovery: () => null,
}));
vi.mock("@/components/support/PrivacyAccessHistory", () => ({
  PrivacyAccessHistory: () => null,
}));
const report = {
  periodDays: 30,
  outcomes: [],
  delivery: [],
  handoffs: [],
  playbooks: [],
  tools: [],
  privacyAccess: [],
  knowledgeGaps: [],
  guardrails: [],
  adminAudit: [],
  privacy: {},
  csat: {},
  readiness: {},
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockReset();
  mocks.post.mockResolvedValue({});
  mocks.get.mockImplementation(async (path: string) => {
    if (path.includes("orchestration-report")) return report;
    if (path.includes("tool-executions?status=failed"))
      return [
        {
          id: 11,
          toolName: "create_booking",
          riskLevel: "high",
          status: "failed",
          conversationId: 42,
          lastAttemptAt: "2026-10-23T00:00:00Z",
        },
      ];
    return [];
  });
});
async function openReview(note = "Synthetic operator verification") {
  const user = userEvent.setup();
  render(<SupportOrchestrationPage />);
  await screen.findByRole("heading", { name: "What needs your attention" });
  await user.click(screen.getByRole("tab", { name: /Review issues/ }));
  fireEvent.change(screen.getByLabelText("Tool verification note"), {
    target: { value: note },
  });
  return user;
}

describe("existing tool attestation UI contract (no new receipt authority)", () => {
  it.each([
    ["", {}],
    [" \n\t ", {}],
    ["{}", {}],
    [' {"bookingId":"synthetic-1"} ', { bookingId: "synthetic-1" }],
  ])(
    "normalizes JSON whitespace consistently for successful input %j",
    async (input, result) => {
      const user = await openReview();
      fireEvent.change(screen.getByLabelText("Verified result"), {
        target: { value: input },
      });
      await user.click(
        screen.getByRole("button", { name: /^Confirm succeeded$/ }),
      );
      await waitFor(() =>
        expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
          "/api/support/ai/tool-executions/11/reconcile",
          {
            outcome: "succeeded",
            note: "Synthetic operator verification",
            result,
          },
        ),
      );
    },
  );
  it.each(["{", "[]", "null", "42", '"text"', "\u00a0{}\u00a0"])(
    "retains rejection of invalid/non-object input %s",
    async (input) => {
      const user = await openReview();
      fireEvent.change(screen.getByLabelText("Verified result"), {
        target: { value: input },
      });
      await user.click(
        screen.getByRole("button", { name: /^Confirm succeeded$/ }),
      );
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Add a valid result object" }),
      );
    },
  );
  it("still requires an operator verification note for blank successful input", async () => {
    const user = await openReview("  ");
    await user.click(
      screen.getByRole("button", { name: /^Confirm succeeded$/ }),
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Add a verification note" }),
    );
  });
  it("preserves the existing not-executed request without interpreting result text", async () => {
    const user = await openReview();
    fireEvent.change(screen.getByLabelText("Verified result"), {
      target: { value: "not JSON" },
    });
    await user.click(
      screen.getByRole("button", {
        name: "Confirm no side effect & resume",
      }),
    );
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
        "/api/support/ai/tool-executions/11/reconcile",
        {
          outcome: "not_executed",
          note: "Synthetic operator verification",
          result: undefined,
        },
      ),
    );
  });
  it("retains receipt and note when the mocked server rejects reconciliation", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Synthetic unavailable result"));
    const user = await openReview();
    fireEvent.change(screen.getByLabelText("Verified result"), {
      target: { value: '{"bookingId":"synthetic-1"}' },
    });
    await user.click(
      screen.getByRole("button", { name: /^Confirm succeeded$/ }),
    );
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Unable to reconcile tool execution",
        }),
      ),
    );
    expect(screen.getByLabelText("Verified result")).toHaveValue(
      '{"bookingId":"synthetic-1"}',
    );
    expect(screen.getByLabelText("Tool verification note")).toHaveValue(
      "Synthetic operator verification",
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
