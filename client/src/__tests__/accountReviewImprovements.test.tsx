import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ checkAuth: vi.fn(), push: vi.fn(), replace: vi.fn(), approved: false }));
const router = { push: mocks.push, replace: mocks.replace };
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams("justFinished=1") }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { email: "owner@example.com", name: "Owner" }, isApproved: mocks.approved, error: null, checkAuth: mocks.checkAuth, logout: vi.fn() }) }));
vi.mock("@/hooks/useSetupComplete", () => ({ useSetupComplete: () => ({ hasBusinessProfile: true, hasBrandToolkit: true, isLoading: false }) }));
import AccountVerificationPage from "@/app/setup/account-verification/page";
beforeEach(() => { vi.clearAllMocks(); mocks.approved = false; mocks.checkAuth.mockResolvedValue(undefined); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("account review guidance", () => {
  it("explains saved setup, next actions, the review gate and how to request help", () => {
    render(<AccountVerificationPage />);
    expect(screen.getByRole("heading", { name: "What you can do now" })).toBeVisible();
    expect(screen.getByRole("link", { name: "contact support" })).toHaveAttribute("href", "/contact");
    expect(screen.getByText(/Access will unlock/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open dashboard" })).toBeNull();
  });
  it("deduplicates manual and resume checks while a request is in flight", async () => {
    let finish!: () => void; mocks.checkAuth.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const user = userEvent.setup(); render(<AccountVerificationPage />);
    await user.click(screen.getByRole("button", { name: "Check status now" }));
    expect(screen.getByRole("button", { name: "Checking status…" })).toHaveAttribute("aria-disabled", "true");
    fireEvent(window, new Event("online")); fireEvent(document, new Event("visibilitychange"));
    expect(mocks.checkAuth).toHaveBeenCalledOnce();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Last checked at"));
    expect(screen.getByRole("button", { name: "Check status now" })).toBeEnabled();
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(mocks.checkAuth).toHaveBeenCalledTimes(2));
  });
});
