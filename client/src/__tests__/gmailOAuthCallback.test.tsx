import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import EmailIntegrationPage from "@/app/dashboard/(main)/integrations/email/page";

const { get, toast, router, state } = vi.hoisted(() => ({
  get: vi.fn(), toast: vi.fn(), router: { replace: vi.fn(), back: vi.fn() }, state: { query: "" },
}));
vi.mock("@/lib/api", () => ({ default: { get, post: vi.fn(), delete: vi.fn() } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(state.query) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function renderCallback(strict = false, historyState: unknown = null) {
  window.history.replaceState(historyState, "", `/dashboard/integrations/email${state.query ? `?${state.query}` : ""}`);
  return render(strict ? <StrictMode><EmailIntegrationPage /></StrictMode> : <EmailIntegrationPage />);
}
function expectCallbackConsumed() {
  expect(window.location.pathname).toBe("/dashboard/integrations/email");
  const query = new URL(window.location.href).searchParams;
  for (const key of ["gmail_success", "gmail_error", "gmail_error_ref", "gmail_error_stage", "gmail_business_profile_id"]) expect(query.has(key)).toBe(false);
  expect(router.replace).not.toHaveBeenCalled();
}
function reads(url: string) {
  if (url === "/api/gmail/oauth/status") return { connected: false, email: null, configSource: "default" };
  if (url === "/api/resend/domains") return { domains: [] };
  if (url === "/api/email-senders") return { senders: [] };
  throw new Error("Unexpected test endpoint");
}
beforeEach(() => {
  vi.clearAllMocks();
  state.query = "";
  localStorage.setItem("user", JSON.stringify({ id: 4101 }));
  sessionStorage.setItem("active-business-profile:4101", "4103");
  get.mockImplementation(async (url: string) => reads(url));
});
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("Gmail callback recovery", () => {
  it("verifies and restores the original business before loading Gmail status", async () => {
    state.query = "gmail_success=true&gmail_business_profile_id=4102";
    const verified = deferred<{ id: number }>();
    const statusProfiles: Array<number | null> = [];
    get.mockImplementation((url: string) => {
      if (url === "/api/settings/business-profiles/4102") return verified.promise;
      if (url === "/api/gmail/oauth/status") statusProfiles.push(selectedBusinessProfileId());
      return Promise.resolve(reads(url));
    });
    renderCallback();
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/settings/business-profiles/4102", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(statusProfiles).toEqual([]);
    await act(async () => { verified.resolve({ id: 4102 }); });
    await waitFor(() => expect(statusProfiles).toEqual([4102]));
    expect(selectedBusinessProfileId()).toBe(4102);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Gmail Connected", description: "Your Gmail account is connected. Check reply sync below." }));
    expectCallbackConsumed();
  });
  it("shows a safe cancellation message and removes callback parameters", async () => {
    state.query = "gmail_error=access_denied";
    renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("cancelled") })));
    expectCallbackConsumed();
    expect(selectedBusinessProfileId()).toBe(4103);
  });
  it("removes only consumed Gmail parameters and preserves unrelated query state and the anchor", async () => {
    state.query = "gmail_error=access_denied&gmail_success=true&gmail_business_profile_id=4102&section=senders#active-senders";
    renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expectCallbackConsumed();
    expect(window.location.search).toBe("?section=senders");
    expect(window.location.hash).toBe("#active-senders");
    expect(selectedBusinessProfileId()).toBe(4103);
  });
  it("preserves unresolved follow-up history metadata while consuming callback fields", async () => {
    const attempted = { revision: "saved-revision", enableAutoFollowUp: true, followUpSteps: [{ id: 1, delayValue: 2, delayUnit: "days", templateId: -1, templateName: "Auto-generate" }] };
    const recovery = { version: 2, scopes: { "4101:4102": { email: { token: 2, serial: 2, pending: false, needsRefresh: true, attempted, unresolved: [{ token: 2, settings: attempted }] } } } };
    state.query = "gmail_error=access_denied";
    renderCallback(false, { __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { stale: true }, __asksalesFollowUpRecovery: recovery });
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expectCallbackConsumed();
    expect(window.history.state).toEqual({ __asksalesFollowUpRecovery: recovery });
  });
  it("shows a callback message only once when React replays mount effects", async () => {
    state.query = "gmail_error=access_denied";
    renderCallback(true);
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expectCallbackConsumed();
  });
  it("uses one notification identity when auth recovery remounts the page", async () => {
    state.query = "gmail_success=true&gmail_business_profile_id=4103";
    const first = renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    first.unmount();
    renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(toast.mock.calls.every(([notification]) => notification.options.id === "gmail-oauth-result")).toBe(true);
  });
  it("never echoes a provider error or URL supplied in the query", async () => {
    state.query = `gmail_error=${encodeURIComponent("secret-provider-response https://attacker.test")}`;
    renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(JSON.stringify(toast.mock.calls)).not.toContain("secret-provider-response");
    expect(JSON.stringify(toast.mock.calls)).not.toContain("attacker.test");
  });
  it("keeps the cause, failed step and reference visible after cleaning the callback URL, and copies them", async () => {
    const reference = "aabbccdd-1122-4333-8444-556677889900";
    state.query = `gmail_error=gmail_api_disabled&gmail_error_stage=mailbox_profile&gmail_error_ref=${reference}`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderCallback();
    await waitFor(() => expect(screen.getByText("Gmail connection could not finish")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Gmail API is disabled");
    expect(screen.getByRole("alert")).toHaveTextContent("Reading the Gmail mailbox identity");
    expect(screen.getByRole("alert")).toHaveTextContent(reference);
    expectCallbackConsumed();
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`Reference: ${reference}`)));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Error code: gmail_api_disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Gmail connection could not finish")).not.toBeInTheDocument();
  });
  it("ignores arbitrary diagnostic fields supplied through the callback URL", async () => {
    state.query = `gmail_error=connection_failed&gmail_error_stage=private-provider-details&gmail_error_ref=private-secret`;
    renderCallback();
    await waitFor(() => expect(screen.getByText("Gmail connection could not finish")).toBeInTheDocument());
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-");
    expectCallbackConsumed();
  });
  it.each(["invalid", "archived", "unauthorized"])("does not claim success or switch to an %s business", async kind => {
    state.query = `gmail_success=true&gmail_business_profile_id=${kind === "invalid" ? "4102/other" : "4102"}`;
    get.mockImplementation(async (url: string) => {
      if (url === "/api/settings/business-profiles/4102") {
        if (kind === "unauthorized") throw new Error("private provider failure");
        return { id: 4102, archivedAt: "2026-10-01" };
      }
      return reads(url);
    });
    renderCallback();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Check Gmail Connection" })));
    expect(selectedBusinessProfileId()).toBe(4103);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Gmail Connected" }));
    expect(JSON.stringify(toast.mock.calls)).not.toContain("private provider failure");
  });
  it("ignores verification after the page unmounts", async () => {
    state.query = "gmail_success=true&gmail_business_profile_id=4102";
    const verified = deferred<{ id: number }>();
    get.mockReturnValueOnce(verified.promise);
    const page = renderCallback();
    page.unmount();
    await act(async () => { verified.resolve({ id: 4102 }); });
    expect(selectedBusinessProfileId()).toBe(4103);
    expect(toast).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?gmail_success=true&gmail_business_profile_id=4102");
    expect(get.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
