import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), cancel: vi.fn(), setQueryData: vi.fn(), push: vi.fn(), replace: vi.fn(), switch: vi.fn(), invalidate: vi.fn(), toast: vi.fn(), onlyProfile: false }));
const profiles = [
  { id: 1, companyName: "Northstar", industry: "Education", role: "owner" as const, version: 3, isDefault: true, brandToolkitCompleted: true },
  { id: 2, companyName: "Acorn", industry: "Retail", role: "member" as const, version: 1, brandToolkitCompleted: false },
];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }), usePathname: () => "/dashboard/home", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: 11 }, setHasBusinessProfile: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate, cancelQueries: mocks.cancel, setQueryData: mocks.setQueryData }) }));
vi.mock("@/lib/api", () => ({ default: { get: mocks.get, post: mocks.post, delete: mocks.delete } }));
vi.mock("@/hooks/use-business-profiles", () => ({ businessProfileName: (profile: {companyName:string}) => profile.companyName, useBusinessProfiles: () => ({ profiles: mocks.onlyProfile ? profiles.slice(0, 1) : profiles, activeProfile: mocks.onlyProfile ? profiles[0] : profiles[1], isLoading: false, isError: false, isSwitching: false, switchProfile: mocks.switch, setDefaultProfile: vi.fn(), refetch: vi.fn() }) }));
import { BusinessProfileSwitcher } from "@/components/BusinessProfileSwitcher";
beforeEach(() => { vi.clearAllMocks(); mocks.onlyProfile = false; localStorage.clear(); mocks.get.mockResolvedValue([{ id: 3, companyName: "Old Studio", role: "owner", version: 5, archivedAt: "2026-10-01" }]); mocks.post.mockResolvedValue({}); mocks.invalidate.mockResolvedValue(undefined); });
afterEach(cleanup);
async function open() { const user = userEvent.setup(); render(<BusinessProfileSwitcher />); await user.click(screen.getByRole("button", { name: /Switch business profile/ })); return user; }
describe("business profile chooser improvements", () => {
  it("removes a deleted archived profile immediately and clears its favorite", async () => {
    mocks.delete.mockResolvedValue({success:true});
    const user = await open();
    await user.click(screen.getByLabelText("Show archived"));
    const card = await screen.findByTestId("business-profile-3");
    await user.click(screen.getByRole("button", {name:"Favorite Old Studio"}));
    await user.click(within(card).getByRole("button", {name:"Delete"}));
    await user.click(screen.getByRole("button", {name:"Delete profile"}));
    await waitFor(() => expect(screen.queryByTestId("business-profile-3")).toBeNull());
    expect(mocks.delete).toHaveBeenCalledWith("/api/settings/business-profiles/3");
    expect(mocks.setQueryData).toHaveBeenCalledWith(["business-profiles",11], profiles);
    expect(JSON.parse(localStorage.getItem("workspace-chooser:11")!).favorites).toEqual([]);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("keeps the profile visible and offers the server's archive guidance on a conflict", async () => {
    mocks.delete.mockRejectedValue(new Error("This business still contains customer records. Archive it to keep that data."));
    const user = await open();
    await user.click(within(screen.getByTestId("business-profile-1")).getByRole("button", {name:"Delete"}));
    await user.click(screen.getByRole("button", {name:"Delete profile"}));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Archive it"));
    expect(screen.getByTestId("business-profile-1")).toBeVisible();
    expect(mocks.setQueryData).not.toHaveBeenCalled();
  });
  it("searches industry as well as name and preserves owner-only controls", async () => {
    const user = await open();
    await user.type(screen.getByRole("searchbox", { name: "Search business profiles" }), "retail");
    expect(screen.getByRole("button", { name: "Open Acorn business profile" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Northstar business profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Acorn" })).toBeNull();
    expect(screen.getByText(/Setup incomplete/)).toBeVisible();
    await user.clear(screen.getByRole("searchbox", { name: "Search business profiles" }));
    await user.selectOptions(screen.getByLabelText("Filter business profiles by access"), "owner");
    expect(screen.queryByRole("button", { name: "Open Acorn business profile" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Northstar" })).toBeVisible();
  });
  it("asks before archiving and sends the current version", async () => {
    const user = await open();
    await user.click(within(screen.getByTestId("business-profile-1")).getByRole("button", { name: "Archive" }));
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Archive profile" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/settings/business-profiles/1/archive", { expectedVersion: 3 }));
    expect(mocks.invalidate).toHaveBeenCalled();
  });
  it("keeps one active workspace available so archived profiles can still be restored", async () => {
    mocks.onlyProfile = true; await open();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByText("Add another workspace before archiving this one.")).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("remembers favorites within the signed-in account", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Favorite Acorn" }));
    expect(screen.getByRole("button", { name: "Unfavorite Acorn" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("workspace-chooser:11")!).favorites).toEqual([2]);
    expect(localStorage.getItem("workspace-chooser:22")).toBeNull();
  });
  it("loads archived profiles explicitly and offers restore without allowing selection", async () => {
    const user = await open();
    await user.click(screen.getByLabelText("Show archived"));
    const openArchived = await screen.findByRole("button", { name: "Open Old Studio business profile" });
    expect(openArchived).toBeDisabled();
    expect(mocks.get).toHaveBeenCalledWith("/api/settings/business-profiles?includeArchived=1");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/settings/business-profiles/3/restore", { expectedVersion: 5 }));
    expect(mocks.switch).not.toHaveBeenCalled();
  });
});
