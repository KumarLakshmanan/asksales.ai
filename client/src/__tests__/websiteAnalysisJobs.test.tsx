import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), analysis: vi.fn(), continue: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), default: mocks }));
const subscribe = () => () => {};
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe }) }));
import { ApiError } from "@/lib/api";
import { WebsiteAnalyzer } from "@/components/setup/WebsiteAnalyzer";
const saved = { url: "https://example.test", analyzedAt: "2026-10-01T00:00:00Z", data: { companyName: "Current name" }, kbEntryId: null, summary: { pages: 2, knowledgeSaved: false, warnings: [] } };
const queued = { id: "1fda493a-a97a-42e9-841e-66e2da7b375c", url: saved.url, status: "queued", stage: "queued", detail: "Waiting to analyze", updatedAt: new Date().toISOString() };
const completed = { ...queued, status: "completed", stage: "complete", result: { data: { companyName: "Refreshed name" }, analysisSummary: saved.summary } };
function renderAnalyzer(analysis: typeof saved | null = null) { return render(<WebsiteAnalyzer profileId={26} website={saved.url} analysis={analysis} ensureProfile={async () => 26} onWebsite={() => {}} onAnalysis={mocks.analysis} onContinue={mocks.continue} onCancel={() => {}} />); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => ({ job: url.endsWith("/latest") ? null : completed }));
  mocks.post.mockResolvedValue({ job: queued });
  mocks.delete.mockResolvedValue({ job: { ...queued, status: "cancelled" } });
});
afterEach(() => {cleanup();vi.useRealTimers();});
describe("background website analysis", () => {
  it("resumes an existing job after refresh and delivers its result", async () => {
    mocks.get.mockImplementation(async (url: string) => ({ job: url.endsWith("/latest") ? queued : completed }));
    renderAnalyzer();
    expect(await screen.findByText("Waiting to analyze")).toBeVisible();
    await waitFor(() => expect(mocks.analysis).toHaveBeenCalledWith(expect.objectContaining({ data: { companyName: "Refreshed name" } })), { timeout: 3000 });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get.mock.calls.every(([, options]) => options.headers["X-Business-Profile-Id"] === "26")).toBe(true);
  });
  it("requires a review before replacing previous extracted details", async () => {
    const user = userEvent.setup(); renderAnalyzer(saved);
    await user.click(screen.getByRole("button", { name: "Analyze again" }));
    expect(await screen.findByRole("heading", { name: "Review the refreshed details" })).toBeVisible();
    expect(mocks.analysis).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep current details" }));
    expect(mocks.analysis).not.toHaveBeenCalled();
  });
  it("applies new details only after the explicit apply action", async () => {
    const user = userEvent.setup(); renderAnalyzer(saved);
    await user.click(screen.getByRole("button", { name: "Analyze again" }));
    await user.click(await screen.findByRole("button", { name: "Apply refreshed details" }));
    expect(mocks.analysis).toHaveBeenCalledOnce();
  });
  it("allows manual setup during analysis and cancels through the scoped API", async () => {
    const user = userEvent.setup(); renderAnalyzer();
    await user.click(screen.getByRole("button", { name: "Analyze website" }));
    await user.click(screen.getByRole("button", { name: "Enter details manually" }));
    expect(mocks.continue).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Stop analysis" }));
    expect(mocks.delete).toHaveBeenCalledWith(expect.stringContaining(queued.id), { headers: { "X-Business-Profile-Id": "26" } });
    expect(screen.getByRole("button", { name: "Analyze website" })).toBeEnabled();
  });
  it.each([401,403,404])("stops polling on terminal HTTP %i and preserves saved details", async status => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async (url:string) => {
      if(url.endsWith("/latest")) return {job:queued};
      throw new ApiError("Workspace unavailable",status);
    });
    await act(async()=>{renderAnalyzer(saved);});
    await act(async()=>{await vi.advanceTimersByTimeAsync(600);});
    expect(screen.getByRole("alert")).toHaveTextContent("This workspace or analysis is no longer available");
    expect(screen.getByRole("button",{name:"Reload workspace status"})).toBeVisible();
    expect(screen.queryByRole("button",{name:"Stop analysis"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Retry analysis"})).toBeDisabled();
    expect(screen.getByLabelText("Website URL")).toHaveValue(saved.url);
    const calls=mocks.get.mock.calls.length;
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
    expect(mocks.get).toHaveBeenCalledTimes(calls);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("recovers a transient status failure without claiming the analysis is still running",async()=>{
    vi.useFakeTimers();let polls=0;
    mocks.get.mockImplementation(async(url:string)=>{
      if(url.endsWith("/latest"))return {job:queued};
      if(polls++===0)throw new ApiError("Temporary outage",503);
      return {job:completed};
    });
    await act(async()=>{renderAnalyzer();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(600);});
    expect(screen.getByRole("alert")).toHaveTextContent("Analysis status is temporarily unavailable");
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(mocks.analysis).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

});
