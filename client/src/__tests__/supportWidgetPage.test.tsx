import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const { poll, read } = vi.hoisted(() => ({
  poll: vi.fn(),
  read: { current: null as ((signal: AbortSignal) => Promise<boolean>) | null },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "widget-token" }),
}));
vi.mock("@/lib/widget-history-poll", () => ({
  startWidgetHistoryPoll: (options: {
    read: (signal: AbortSignal) => Promise<boolean>;
  }) => {
    read.current = options.read;
    poll(options);
    return () => {};
  },
}));
import SupportWidgetPage from "@/app/support-widget/[token]/page";
import { afterAll as afterAllReadRetry, beforeAll as beforeAllReadRetry } from 'vitest';
import { TRANSIENT_READ_RETRY_DELAYS_MS, transientReadRetry } from '@/lib/api-client';

// These cases exercise the feature's own recovery screen after one failed
// read, so the API client's automatic read retry is turned off here.
beforeAllReadRetry(() => { transientReadRetry.delaysMs = []; });
afterAllReadRetry(() => { transientReadRetry.delaysMs = TRANSIENT_READ_RETRY_DELAYS_MS; });
const messages = [
  {
    id: 1,
    role: "assistant",
    content: "Your order arrives tomorrow.",
    sources: [],
    confidence: 0.92,
    createdAt: "2026-10-03T00:00:00.000Z",
  },
];
function response(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status < 400,
    json: async () => body,
  } as Response);
}
beforeEach(() => {
  localStorage.clear();
  poll.mockClear();
  read.current = null;
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("sw_session_widget-token", "30");
  localStorage.setItem("sw_session_widget-token_token", "credential");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("customer widget recovery and feedback", () => {
  it("retains resumable credentials after temporary history failure and recovers by polling", async () => {
    let failed = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
      String(url).includes("/config")
        ? response(200, {
            success: true,
            data: { displayName: "Example help", teamName: "Orders" },
          })
        : failed
          ? response(503, { error: "Temporary outage" })
          : response(200, { success: true, data: messages }),
    );
    render(<SupportWidgetPage />);
    await screen.findByText("Example help");
    expect(localStorage.getItem("sw_session_widget-token_token")).toBe(
      "credential",
    );
    await act(async () => {
      await read.current?.(new AbortController().signal);
    });
    expect(screen.getByText(/Connection interrupted/)).toBeInTheDocument();
    expect(localStorage.getItem("sw_session_widget-token_token")).toBe(
      "credential",
    );
    failed = false;
    await act(async () => {
      await read.current?.(new AbortController().signal);
    });
    expect(
      screen.getByText("Your order arrives tomorrow."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Connection interrupted/),
    ).not.toBeInTheDocument();
  });
  it("shows expired sessions with an explicit new-chat action", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
      String(url).includes("/config")
        ? response(200, { success: true, data: { teamName: "Orders" } })
        : response(440, { code: "SESSION_EXPIRED", error: "Expired" }),
    );
    render(<SupportWidgetPage />);
    await screen.findByText(/This conversation has expired/);
    expect(localStorage.getItem("sw_session_widget-token_token")).toBeNull();
    expect(screen.getByLabelText("Message to support")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByLabelText("Message to support")).not.toBeDisabled();
  });
  it("does not show successful feedback when saving fails and allows retry with bound credentials", async () => {
    let feedbackFails = true;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/config"))
        return response(200, {
          success: true,
          data: { displayName: "Example help", teamName: "Orders" },
        });
      if (String(url).includes("/feedback"))
        return feedbackFails
          ? response(503, { error: "Could not save feedback. Try again." })
          : response(200, { success: true, data: { rating: "helpful" } });
      return response(200, { success: true, data: messages });
    });
    render(<SupportWidgetPage />);
    await screen.findByText("Your order arrives tomorrow.");
    fireEvent.click(
      screen.getByRole("button", { name: /^Helpful$/ }),
    );
    await screen.findByText("Could not save feedback. Try again.");
    expect(
      screen.queryByText("Thank you for your feedback."),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("sw_session_widget-token_token")).toBe(
      "credential",
    );
    feedbackFails = false;
    fireEvent.click(
      screen.getByRole("button", { name: /^Helpful$/ }),
    );
    await screen.findByText("Thank you for your feedback.");
    const request = fetch.mock.calls.find(([url]) =>
      String(url).includes("/feedback"),
    )?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "widget-token",
      sessionToken: "credential",
      rating: "helpful",
    });
    expect(request?.credentials).toBe("omit");
    expect(screen.queryByText("92%")).not.toBeInTheDocument();
  });
  it("keeps reading position when new history arrives and offers jump to latest", async () => {
    let history = messages;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
      String(url).includes("/config")
        ? response(200, { success: true, data: { teamName: "Orders" } })
        : response(200, { success: true, data: history }),
    );
    render(<SupportWidgetPage />);
    await screen.findByText("Your order arrives tomorrow.");
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 300, configurable: true },
      scrollTop: { value: 100, configurable: true },
    });
    fireEvent.scroll(log);
    history = [
      ...messages,
      { ...messages[0], id: 2, content: "Here is another update." },
    ];
    await act(async () => {
      await read.current?.(new AbortController().signal);
    });
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest" }),
      ).not.toBeInTheDocument(),
    );
  });
});
