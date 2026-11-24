import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const { scope, get, post, remove, toast, refetch } = vi.hoisted(() => ({
  scope: { userId: 7, profileId: 1 as number | null, ready: true, isError: false, isLoading: false },
  get: vi.fn(), post: vi.fn(), remove: vi.fn(), toast: vi.fn(), refetch: vi.fn(),
}));
vi.mock("@/hooks/use-support-report", () => ({
  useSupportWorkspace: () => ({ ...scope, profiles: { isError: scope.isError, isLoading: scope.isLoading, refetch } }),
}));
vi.mock("@/lib/api", () => ({ api: { get, post, delete: remove } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import SupportAIEmbedPage from "@/app/dashboard/(main)/support-ai/embed/page";
import { DEFAULT_WIDGET_SETTINGS } from "@/lib/support-widget-settings";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";

// Deliberately non-credential strings; no API, provider, or storage is contacted.
const teams = [
  { teamId: 10, teamName: "Synthetic team A", token: "artificial-old-A", settings: DEFAULT_WIDGET_SETTINGS, installation: null },
  { teamId: 20, teamName: "Synthetic team B", token: "artificial-old-B", settings: DEFAULT_WIDGET_SETTINGS, installation: null },
];
const receipt = { teamId: 10, teamName: teams[0].teamName, token: "artificial-fresh-A" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const teamSection = (name: string) => screen.getByRole("region", { name });
const rotateA = () => {
  fireEvent.click(screen.getByRole("button", { name: "Rotate widget key for Synthetic team A" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Rotate key" }));
};
async function loaded() {
  const view = render(<SupportAIEmbedPage />);
  await screen.findByText(teams[0].token!);
  return view;
}
function expectFreshA() {
  expect(screen.getByText(receipt.token)).toBeVisible();
  const section = teamSection(teams[0].teamName);
  expect(section.querySelectorAll("pre")).toHaveLength(2);
  section.querySelectorAll("pre").forEach(code => expect(code.textContent).toContain(receipt.token));
  expect(within(section).getByRole("link", { name: "Open Synthetic team A chat in a new tab" })).toHaveAttribute("href", expect.stringContaining(receipt.token));
  expect(section).not.toHaveTextContent(teams[0].token!);
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(scope, { profileId: 1, ready: true, isError: false, isLoading: false });
  get.mockResolvedValue(teams);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("embed committed response ordering", () => {
  it("preserves rotate A's receipt while a deferred cross-team revoke B is attempted", async () => {
    const rotate = deferred<typeof receipt>();
    const revoke = deferred<unknown>();
    post.mockReturnValue(rotate.promise);
    remove.mockReturnValue(revoke.promise);
    await loaded();
    rotateA();
    const revokeB = within(teamSection(teams[1].teamName)).getByRole("button", { name: "Revoke key" });
    // On the pinned source this path submits B while A is unresolved. Complete
    // both synthetic receipts to reproduce the lost A receipt, not just a button state.
    fireEvent.click(revokeB);
    if (screen.queryByRole("alertdialog")) {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke key" }));
    }
    await act(async () => { revoke.resolve({ success: true }); rotate.resolve(receipt); });
    expectFreshA();
    expect(remove).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Key generated" }));
    // B can be revoked normally after A's receipt is displayed.
    fireEvent.click(within(teamSection(teams[1].teamName)).getByRole("button", { name: "Revoke key" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke key" }));
    await screen.findByRole("button", { name: "Generate widget key for Synthetic team B" });
    expectFreshA();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("/api/support-widget/token/20", { headers: { [BUSINESS_PROFILE_HEADER]: "1" } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Widget key revoked" }));
  });

  it("ignores a pre-write GET that resolves after a committed rotation", async () => {
    const read = deferred<typeof teams>();
    const rotate = deferred<typeof receipt>();
    await loaded();
    get.mockReturnValueOnce(read.promise); // Ignores AbortSignal intentionally.
    post.mockReturnValueOnce(rotate.promise);
    fireEvent.click(screen.getAllByRole("button", { name: "Check installation" })[0]);
    rotateA();
    await act(async () => { rotate.resolve(receipt); });
    expectFreshA();
    await act(async () => { read.resolve(teams); });
    expectFreshA();
    expect(get.mock.calls[1][1].signal.aborted).toBe(true);
    expect(screen.getAllByRole("button", { name: "Check installation" })[0]).toBeEnabled();
  });

  it("ignores a superseded read failure and allows a fresh post-write installation check", async () => {
    const read = deferred<typeof teams>();
    const rotate = deferred<typeof receipt>();
    await loaded();
    get.mockReturnValueOnce(read.promise);
    post.mockReturnValueOnce(rotate.promise);
    fireEvent.click(screen.getAllByRole("button", { name: "Check installation" })[0]);
    rotateA();
    await act(async () => { read.reject(new Error("Artificial stale read failure")); rotate.resolve(receipt); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expectFreshA();
    get.mockResolvedValueOnce([{ ...teams[0], token: receipt.token, installation: { hostname: "synthetic.example.test", lastSeenAt: "2026-10-11T00:00:00Z" } }, teams[1]]);
    fireEvent.click(screen.getAllByRole("button", { name: "Check installation" })[0]);
    await screen.findByText("Loader detected on synthetic.example.test");
    expectFreshA();
  });

  it("rejects multiple generate events before React renders busy state", async () => {
    get.mockResolvedValue(teams.map(team => ({ ...team, token: null })));
    const generate = deferred<typeof receipt>();
    post.mockReturnValue(generate.promise);
    render(<SupportAIEmbedPage />);
    const first = await screen.findByRole("button", { name: "Generate widget key for Synthetic team A" });
    const second = screen.getByRole("button", { name: "Generate widget key for Synthetic team B" });
    const check = screen.getAllByRole("button", { name: "Check installation" })[0];
    act(() => { first.click(); check.click(); second.click(); first.click(); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/support-widget/generate-token", { teamId: 10 }, { headers: { [BUSINESS_PROFILE_HEADER]: "1" } });
    expect(screen.getAllByRole("button", { name: "Check installation" }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => { generate.resolve(receipt); });
    expectFreshA();
  });

  it.each(["rotate", "revoke"] as const)("rejects repeated %s confirmations before a busy render", async action => {
    const write = deferred<typeof receipt>();
    (action === "revoke" ? remove : post).mockReturnValue(write.promise);
    await loaded();
    const revokeB = within(teamSection(teams[1].teamName)).getByRole("button", { name: "Revoke key" });
    if (action === "rotate") fireEvent.click(screen.getByRole("button", { name: "Rotate widget key for Synthetic team A" }));
    else fireEvent.click(within(teamSection(teams[0].teamName)).getByRole("button", { name: "Revoke key" }));
    const confirmation = within(screen.getByRole("alertdialog")).getByRole("button", { name: action === "rotate" ? "Rotate key" : "Revoke key" });
    act(() => { confirmation.click(); confirmation.click(); revokeB.click(); });
    expect(action === "revoke" ? remove : post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => { write.resolve(receipt); });
    expect(screen.getByRole("button", { name: `${action === "revoke" ? "Generate" : "Rotate"} widget key for Synthetic team A` })).toBeEnabled();
  });

  it.each(["generate", "rotate", "revoke"] as const)("releases the lock after a failed %s and preserves the previous state", async action => {
    if (action === "generate") get.mockResolvedValue(teams.map(team => ({ ...team, token: null })));
    const write = deferred<typeof receipt>();
    if (action === "revoke") remove.mockReturnValue(write.promise);
    else post.mockReturnValue(write.promise);
    render(<SupportAIEmbedPage />);
    await screen.findByRole("button", { name: `${action === "generate" ? "Generate" : "Rotate"} widget key for Synthetic team A` });
    if (action === "rotate") rotateA();
    else if (action === "generate") fireEvent.click(screen.getByRole("button", { name: "Generate widget key for Synthetic team A" }));
    else {
      fireEvent.click(within(teamSection(teams[0].teamName)).getByRole("button", { name: "Revoke key" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke key" }));
    }
    await act(async () => { write.reject(new Error("Artificial mutation failure")); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive", description: "Artificial mutation failure" }));
    expect(screen.getAllByRole("button", { name: "Check installation" })[0]).toBeEnabled();
    if (action !== "generate") expect(screen.getByText(teams[0].token!)).toBeVisible();
    post.mockResolvedValueOnce(receipt);
    if (action === "generate") fireEvent.click(screen.getByRole("button", { name: "Generate widget key for Synthetic team A" }));
    else rotateA();
    await screen.findByText(receipt.token);
    expectFreshA();
  });

  it("suppresses a receipt and feedback after its workspace unmounts", async () => {
    const write = deferred<typeof receipt>();
    post.mockReturnValueOnce(write.promise);
    const view = await loaded();
    rotateA();
    scope.profileId = 2;
    get.mockResolvedValueOnce([{ ...teams[1], token: "artificial-workspace-2" }]);
    view.rerender(<SupportAIEmbedPage />);
    await screen.findByText("artificial-workspace-2");
    await act(async () => { write.resolve(receipt); });
    expect(screen.queryByText(receipt.token)).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
    expect(post.mock.calls[0][2].headers[BUSINESS_PROFILE_HEADER]).toBe("1");
    expect(get.mock.calls[1][1].headers[BUSINESS_PROFILE_HEADER]).toBe("2");
  });
});

describe("embed workspace recovery", () => {
  it("offers profile retry instead of perpetual loading and never fetches widget keys", () => {
    scope.ready = false; scope.isError = true;
    render(<SupportAIEmbedPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Support workspace could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });
  it("offers the established chooser when the profile is absent", () => {
    scope.ready = false; scope.profileId = null;
    render(<SupportAIEmbedPage />);
    expect(screen.getByRole("link", { name: "Choose a workspace" })).toHaveAttribute("href", "/dashboard/select-profile");
    expect(get).not.toHaveBeenCalled();
  });
  it("retains loading only while the profile is actually pending", () => {
    scope.ready = false; scope.profileId = null; scope.isLoading = true;
    render(<SupportAIEmbedPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading support workspace");
    expect(get).not.toHaveBeenCalled();
  });
});

it('offers assistant settings from embed setup without generating or rotating a key', async () => {
  await loaded();
  expect(screen.getByRole('link', { name: 'Assistant settings' })).toHaveAttribute('href', '/dashboard/settings/outreach');
  expect(post).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
});
