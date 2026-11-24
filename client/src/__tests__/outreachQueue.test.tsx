import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutreachQueue } from "@/components/outreach/OutreachQueue";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
const business = vi.hoisted(() => ({ scope: "owner-1:business-1", listeners: new Set<() => void>() }));
vi.mock("@/lib/creator-session", () => ({ creatorSessionScope: () => business.scope }));
vi.mock("@/lib/business-profile", () => ({ subscribeBusinessProfile: (listener: () => void) => {
  business.listeners.add(listener);
  return () => business.listeners.delete(listener);
} }));
describe("outreach queue overview", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    business.scope = "owner-1:business-1";
  });
  it("shows accepted, delivered and waiting separately and explains a capacity delay", async () => {
    vi.mocked(api.get).mockResolvedValue({
      channels: [
        {
          channel: "whatsapp",
          accepted: 400,
          delivered: 390,
          queued: 175,
          processing: 0,
          retrying: 25,
          failed: 3,
          review: 1,
          nextAttemptAt: "2026-10-30T00:00:00Z",
          waiting: [
            {
              id: "message-7",
              reason: "daily_allowance",
              nextAttemptAt: "2026-10-30T00:00:00Z",
            },
          ],
        },
      ],
      checkedAt: "2026-10-29T09:00:00Z",
    } as never);
    render(<OutreachQueue />);
    const row = await screen.findByRole("row", {
      name: /WhatsApp 400 390 175 0 25 3 1/,
    });
    expect(within(row).getByText("175")).toBeInTheDocument();
    expect(
      screen.getByText(/Retrying is included in queued/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Daily sending allowance reached/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send/i }),
    ).not.toBeInTheDocument();
  });
  it("does not show zero queue counts when the API fails", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("Unavailable"));
    render(<OutreachQueue />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be refreshed",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("aborts the in-flight request when leaving the page", async () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
    const view = render(<OutreachQueue />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const options = vi.mocked(api.get).mock.calls[0][1] as {
      signal: AbortSignal;
    };
    view.unmount();
    expect(options.signal.aborted).toBe(true);
  });
  it("loads immediately when a background page becomes visible and stops listening on unmount", async () => {
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.mocked(api.get).mockResolvedValue({channels: [], checkedAt: new Date().toISOString()} as never);
    const view = render(<OutreachQueue />);
    expect(api.get).not.toHaveBeenCalled();
    visibility.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    visibility.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(api.get).toHaveBeenCalledTimes(1);
    view.unmount();
    visibility.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it("clears the previous business snapshot and ignores its late refresh after a profile switch", async () => {
    const snapshot = (accepted: number) => ({ channels: [{ channel: "whatsapp", accepted, delivered: 0,
      queued: 0, processing: 0, retrying: 0, failed: 0, review: 0, nextAttemptAt: null, waiting: [] }], checkedAt: new Date().toISOString() });
    let oldRefresh!: (value: unknown) => void;
    let newBusiness!: (value: unknown) => void;
    vi.mocked(api.get).mockResolvedValueOnce(snapshot(400) as never)
      .mockImplementationOnce(() => new Promise(resolve => { oldRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { newBusiness = resolve; }));
    render(<OutreachQueue />);
    await screen.findByRole("row", { name: /WhatsApp 400 0 0/ });
    fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const oldSignal = (vi.mocked(api.get).mock.calls[1][1] as { signal: AbortSignal }).signal;
    act(() => {
      business.scope = "owner-1:business-2";
      business.listeners.forEach(listener => listener());
    });
    expect(screen.queryByRole("row", { name: /WhatsApp 400 0 0/ })).not.toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    await act(async () => { oldRefresh(snapshot(888)); newBusiness(snapshot(3)); });
    expect(await screen.findByRole("row", { name: /WhatsApp 3 0 0/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /WhatsApp 888 0 0/ })).not.toBeInTheDocument();
  });
});
