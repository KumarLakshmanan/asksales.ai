import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceNextSteps, type OnboardingStatus } from "@/lib/workspace-next-steps";
import { useSidebarPreferences } from "@/hooks/use-sidebar-preferences";
import { confirmUnsavedNavigation, restoreUnsavedNavigation, useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { WorkspaceProfileForm } from "@/components/setup/WorkspaceProfileForm";
import { emptyWorkspaceProfile, type WorkspaceProfileData } from "@/lib/workspace-profile";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const status: OnboardingStatus = { profile: { workspaceType: "business", companySize: "2-10", applicationUses: ["content_social", "marketing_campaigns"], preferredChannels: ["Email", "Instagram"], setupGoal: "Reach new customers" }, connectedChannels: ["Instagram"], completedTasks: ["brand", "content"] };

describe("workspace next steps", () => {
  it("ignores unavailable or malformed status without breaking the dashboard", () => {
    expect(workspaceNextSteps({} as OnboardingStatus, "owner")).toEqual([]);
    expect(workspaceNextSteps([] as unknown as OnboardingStatus, "owner")).toEqual([]);
  });
  it("separates preferences from confirmed connections and saved activity", () => {
    const tasks = workspaceNextSteps(status, "owner");
    expect(tasks.find(task => task.id === "channel:Email")).toMatchObject({ title: "Connect Email", completed: false });
    expect(tasks.find(task => task.id === "channel:Instagram")).toMatchObject({ title: "Review Instagram", completed: true });
    expect(tasks.find(task => task.id === "content")?.completed).toBe(true);
    expect(tasks.find(task => task.id === "campaign")?.completed).toBe(false);
    expect(tasks.find(task => task.id === "team")?.href).toBe("/dashboard/settings/team");
  });
  it("does not infer completion when connections could not be checked", () => {
    const tasks = workspaceNextSteps({ ...status, connectionsAvailable: false }, "owner").filter(task => task.id.startsWith("channel:"));
    expect(tasks.every(task => !task.completed)).toBe(true);
    expect(tasks[0].title).toBe("Check Email connection");
  });
  it("keeps owner actions and unavailable module routes out of staff next steps", () => {
    const tasks = workspaceNextSteps(status, "member", ["content"]);
    expect(tasks.map(task => task.id)).toEqual(["content"]);
  });
  it("opens a paid campaign brief and preserves the advertising module boundary", () => {
    const advertising: OnboardingStatus = { profile: { applicationUses: ["advertising"] }, connectedChannels: [], completedTasks: [] };
    expect(workspaceNextSteps(advertising, "member", ["performance_marketing"])).toEqual([
      expect.objectContaining({ id: "advertising", title: "Prepare your first ad campaign", href: "/dashboard/ads/create", completed: false }),
    ]);
    expect(workspaceNextSteps(advertising, "member", ["content", "campaigns", "integrations"])).toEqual([]);
    expect(workspaceNextSteps({ ...advertising, completedTasks: ["advertising"] }, "member", ["performance_marketing"])[0].completed).toBe(true);
  });
  it("keeps adjacent use tasks at their matching safe workspaces", () => {
    const tasks = workspaceNextSteps({ profile: { applicationUses: ["customer_support", "sales_leads", "content_social", "marketing_campaigns", "personal_productivity"] }, connectedChannels: [], completedTasks: [] }, "member");
    expect(tasks.map(({ title, href }) => ({ title, href }))).toEqual([
      { title: "Review your support workspace", href: "/dashboard/support" },
      { title: "Add your first prospects", href: "/dashboard/leads" },
      { title: "Create your first content", href: "/dashboard/saved-templates" },
      { title: "Plan your first campaign", href: "/dashboard/outreach/create" },
      { title: "Brief your first agent", href: "/dashboard/conversations" },
    ]);
  });
  it.each([
    ["Email", "email"], ["WhatsApp", "whatsapp"], ["Instagram", "instagram"],
    ["Facebook / Messenger", "facebook"], ["YouTube", "youtube"], ["Google Ads", "google-ads"], ["Meta Ads", "meta"],
  ])("keeps %s connection tasks in the provider workspace", (channel, provider) => {
    const channelStatus = { profile: { preferredChannels: [channel] }, connectedChannels: [], completedTasks: [] };
    const href = `/dashboard/integrations/${provider}`;
    expect(workspaceNextSteps(channelStatus, "member", ["integrations"])[0]).toMatchObject({ title: `Connect ${channel}`, href, completed: false });
    expect(workspaceNextSteps({ ...channelStatus, connectedChannels: [channel] }, "member", ["integrations"])[0]).toMatchObject({ title: `Review ${channel}`, href, completed: true });
    expect(workspaceNextSteps(channelStatus, "member", ["performance_marketing"])).toEqual([]);
  });
  it("opens Website chat installation only when the Support AI module is available", () => {
    const website: OnboardingStatus = { profile: { preferredChannels: ["Website chat"] }, connectedChannels: [], completedTasks: [] };
    expect(workspaceNextSteps(website, "member", ["support_ai"])[0]).toMatchObject({ title: "Connect Website chat", href: "/dashboard/support-ai/embed", completed: false });
    expect(workspaceNextSteps(website, "member", ["support", "integrations"])).toEqual([]);
    expect(workspaceNextSteps({ ...website, connectedChannels: ["Website chat"] }, "member", ["support_ai"])[0]).toMatchObject({ title: "Review Website chat", href: "/dashboard/support-ai/embed", completed: true });
  });
});

describe("navigation recovery", () => {
  it("restores sidebar preferences for the same account without carrying them to another", async () => {
    const { result, rerender, unmount } = renderHook(({ id }) => useSidebarPreferences(id), { initialProps: { id: 11 } });
    await act(async () => { result.current.setSidebarOpen(false); result.current.setSectionOpen("crm", true); });
    rerender({ id: 22 });
    await waitFor(() => expect(result.current.sidebarOpen).toBe(true));
    expect(result.current.sectionOpen("crm")).toBe(false);
    rerender({ id: 11 });
    await waitFor(() => expect(result.current.sidebarOpen).toBe(false));
    expect(result.current.sectionOpen("crm")).toBe(true);
    unmount();
    const resumed = renderHook(() => useSidebarPreferences(11));
    await waitFor(() => expect(resumed.result.current.sidebarOpen).toBe(false));
  });
  it("blocks navigation and unload for dirty edits and releases them after saving", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useUnsavedChanges(true));
    expect(confirmUnsavedNavigation()).toBe(false);
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    act(() => result.current.clearGuard());
    expect(confirmUnsavedNavigation()).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it("restores edit protection if an approved workspace switch fails", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderHook(() => useUnsavedChanges(true));
    expect(confirmUnsavedNavigation()).toBe(true);
    restoreUnsavedNavigation();
    confirm.mockReturnValue(false);
    expect(confirmUnsavedNavigation()).toBe(false);
    const before = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
  });
  it("preserves the page when a link is rejected", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const hook = renderHook(() => useUnsavedChanges(true));
    const anchor = document.createElement("a"); anchor.href = "/dashboard/settings/team"; document.body.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    anchor.remove(); hook.unmount();
  });
});

describe("workspace profile editing", () => {
  function Editor({ save }: { save: (data: WorkspaceProfileData) => void }) {
    const [data, setData] = useState({ ...emptyWorkspaceProfile(), name: "Northstar", workspaceType: "business" });
    const [step, setStep] = useState(1);
    return <WorkspaceProfileForm data={data} onChange={setData} step={step} onStep={setStep} onSave={save} onBack={() => {}} editing />;
  }
  it("saves from every section without requiring the full wizard to be traversed", async () => {
    const save = vi.fn(); const user = userEvent.setup(); render(<Editor save={save} />);
    for (const section of ["Profile", "About", "Uses", "Channels"]) {
      await user.click(screen.getByRole("button", { name: section }));
      expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("ws-primary");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    }
    expect(save).toHaveBeenCalledTimes(4);
  });
  it("returns to an invalid section, focuses its field and preserves typed data", async () => {
    const save = vi.fn(); const user = userEvent.setup(); render(<Editor save={save} />);
    await user.clear(screen.getByLabelText("Workspace name *"));
    await user.click(screen.getByRole("button", { name: "Channels" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const name = screen.getByLabelText("Workspace name *");
    expect(name).toHaveFocus(); expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Add a workspace name");
    expect(save).not.toHaveBeenCalled();
    await user.type(name, "Recovered name");
    expect(name).not.toHaveAttribute("aria-invalid");
    fireEvent.submit(name.closest("form")!);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Recovered name" }));
  });
});
