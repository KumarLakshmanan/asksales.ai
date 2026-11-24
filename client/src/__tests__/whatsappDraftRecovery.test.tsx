import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppDraftRecovery } from "@/components/whatsapp-templates/useWhatsAppDraftRecovery";

const mocks = vi.hoisted(() => ({ user: { id: 7, businessProfileId: 11 } as { id: number; businessProfileId: number } | null, profile: 11 as number | null }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/business-profile", () => ({
  selectedBusinessProfileId: () => mocks.profile,
  subscribeBusinessProfile: (listener: () => void) => {
    window.addEventListener("business-profile-changed", listener);
    return () => window.removeEventListener("business-profile-changed", listener);
  },
}));
interface Draft { body: string; missingFileName?: string }
const isDraft = (value: unknown): value is Draft => typeof value === "object" && value !== null && "body" in value && typeof value.body === "string";
const key = (user = 7, business = 11, scope = "new") => `whatsapp-draft-recovery:v1:${user}:${business}:${encodeURIComponent(scope)}`;
const seed = (value: unknown, overrides = {}, storageKey = key()) => {
  sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, revision: null, savedAt: Date.now() - 1_000, value, ...overrides }));
};
let recovery: ReturnType<typeof useWhatsAppDraftRecovery<Draft>>;
function Harness({ value = { body: "" }, dirty = false, revision = null, ready = true, onRestore = vi.fn(), scope = "new" }: {
  value?: Draft; dirty?: boolean; revision?: string | null; ready?: boolean; onRestore?: (value: Draft) => void; scope?: string;
}) {
  const current = useWhatsAppDraftRecovery({ value, dirty, revision, ready, onRestore, scope, isDraft });
  useLayoutEffect(() => { recovery = current; });
  return <><output>{current.status}</output>{current.banner}<a href="/dashboard/whatsapp/templates">Templates</a></>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T10:00:00Z"));
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 7 }));
  mocks.user = { id: 7, businessProfileId: 11 };
  mocks.profile = 11;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("WhatsApp unfinished draft recovery", () => {
  it("debounces only dirty serializable edits and flushes the latest edit on pagehide", () => {
    const { rerender } = render(<Harness />);
    act(() => vi.advanceTimersByTime(500));
    expect(sessionStorage.getItem(key())).toBeNull();
    rerender(<Harness value={{ body: "Hello" }} dirty />);
    act(() => vi.advanceTimersByTime(299));
    expect(sessionStorage.getItem(key())).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(sessionStorage.getItem(key())!).value.body).toBe("Hello");
    rerender(<Harness value={{ body: "Newest" }} dirty />);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent(window, new Event("pagehide"));
    expect(JSON.parse(sessionStorage.getItem(key())!).value.body).toBe("Newest");
    expect(screen.getByText(/Recovery copy saved at/)).toBeInTheDocument();
  });

  it("does not reset the debounce or repeatedly save when equivalent objects rerender", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { rerender } = render(<Harness value={{ body: "Stable" }} dirty />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<Harness value={{ body: "Stable" }} dirty />);
    act(() => vi.advanceTimersByTime(100));
    expect(write).toHaveBeenCalledOnce();
    rerender(<Harness value={{ body: "Stable" }} dirty />);
    act(() => vi.advanceTimersByTime(2_000));
    expect(write).toHaveBeenCalledOnce();
  });

  it("requires an explicit restore and never overwrites an undecided recovery copy", () => {
    const draft = { body: "Recovered" };
    seed(draft);
    const recoveredAt = Date.now() - 1_000;
    const restore = vi.fn();
    const { rerender } = render(<Harness onRestore={restore} />);
    expect(restore).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore unfinished work" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(JSON.parse(sessionStorage.getItem(key())!).value).toEqual(draft);
    rerender(<Harness value={{ body: "New typed work" }} dirty onRestore={restore} />);
    act(() => vi.advanceTimersByTime(500));
    expect(JSON.parse(sessionStorage.getItem(key())!).value).toEqual(draft);
    fireEvent.click(screen.getByRole("button", { name: "Restore unfinished work" }));
    expect(restore).toHaveBeenCalledWith(draft);
    expect(recovery.lastRecoveredAt).toEqual(recoveredAt);
    expect(screen.queryByRole("button", { name: "Restore unfinished work" })).not.toBeInTheDocument();
  });

  it("discards a copy without recreating it until the next edit", () => {
    seed({ body: "Old work" });
    const current = { body: "Current work" };
    const { rerender } = render(<Harness value={current} dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Discard recovery copy" }));
    act(() => vi.advanceTimersByTime(500));
    fireEvent(window, new Event("pagehide"));
    expect(sessionStorage.getItem(key())).toBeNull();
    rerender(<Harness value={{ body: "Next edit" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(JSON.parse(sessionStorage.getItem(key())!).value.body).toBe("Next edit");
  });

  it("clear after a successful save suppresses the outstanding debounce", () => {
    const { rerender } = render(<Harness value={{ body: "Saved now" }} dirty />);
    act(() => recovery.clear());
    act(() => vi.advanceTimersByTime(1_000));
    expect(sessionStorage.getItem(key())).toBeNull();
    rerender(<Harness value={{ body: "Saved now" }} dirty={false} revision="updated" />);
    fireEvent(window, new Event("pagehide"));
    expect(sessionStorage.getItem(key())).toBeNull();
  });

  it.each([
    ["expired", { savedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 }],
    ["different server revision", { revision: "updated-on-server" }],
    ["future timestamp", { savedAt: Date.now() + 90_000 }],
    ["invalid shape", { value: { body: 99 } }],
    ["unknown envelope", { version: 2 }],
  ])("rejects %s recovery copies", (_name, overrides) => {
    // Test-case expressions are evaluated before the fake clock is installed.
    const adjusted = _name === "expired" ? { savedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 } :
      _name === "future timestamp" ? { savedAt: Date.now() + 90_000 } : overrides;
    seed({ body: "Stale" }, adjusted);
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Restore unfinished work" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key())).toBeNull();
  });

  it("waits for server initialization before judging a saved revision", () => {
    seed({ body: "Server draft" }, { revision: "server-1" });
    const { rerender } = render(<Harness ready={false} />);
    expect(sessionStorage.getItem(key())).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Restore unfinished work" })).not.toBeInTheDocument();
    rerender(<Harness ready revision="server-1" />);
    expect(screen.getByRole("button", { name: "Restore unfinished work" })).toBeInTheDocument();
  });

  it("isolates scopes, authenticated accounts and businesses, including a mounted tenant switch", () => {
    seed({ body: "Business 11" });
    seed({ body: "Business 12" }, {}, key(7, 12));
    seed({ body: "User 8" }, {}, key(8, 12));
    const { rerender } = render(<Harness />);
    expect(screen.getByText(/Unfinished work/)).toBeInTheDocument();
    rerender(<Harness scope="edit:17" value={{ body: "Scope 17" }} dirty />);
    act(() => vi.advanceTimersByTime(500));
    expect(sessionStorage.getItem(key(7, 11, "edit:17"))).toBeNull();
    // Existing fields are suppressed on scope changes until the next edit.
    rerender(<Harness scope="edit:17" value={{ body: "Scope 17 changed" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(JSON.parse(sessionStorage.getItem(key(7, 11, "edit:17"))!).value.body).toBe("Scope 17 changed");
    mocks.profile = 12;
    fireEvent(window, new Event("business-profile-changed"));
    rerender(<Harness value={{ body: "Scope 17 changed" }} dirty />);
    expect(screen.getByRole("button", { name: "Restore unfinished work" })).toBeInTheDocument();
    mocks.user = { id: 8, businessProfileId: 12 };
    rerender(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Discard recovery copy" }));
    expect(sessionStorage.getItem(key(8, 12))).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(key(7, 12))!).value.body).toBe("Business 12");
    expect(JSON.parse(sessionStorage.getItem(key(7, 11))!).value.body).toBe("Business 11");
  });

  it("does not write old fields into another account after logout and login", () => {
    const { rerender } = render(<Harness value={{ body: "Private user 7" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    mocks.user = null;
    rerender(<Harness value={{ body: "Private user 7" }} dirty />);
    mocks.user = { id: 8, businessProfileId: 11 };
    rerender(<Harness value={{ body: "Private user 7" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(sessionStorage.getItem(key(8))).toBeNull();
  });

  it("does not enable recovery until both verified account and business are known", () => {
    mocks.profile = null;
    mocks.user = null;
    render(<Harness value={{ body: "Anonymous" }} dirty />);
    act(() => vi.advanceTimersByTime(500));
    expect(sessionStorage.length).toBe(0);
  });

  it("warns on unload only while dirty and retains work when anchor navigation is confirmed", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { rerender } = render(<Harness />);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    rerender(<Harness value={{ body: "Unsaved" }} dirty />);
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    const blocked = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    fireEvent(screen.getByRole("link"), blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true);
    // Cancel the actual jsdom navigation after the hook handles its capture.
    screen.getByRole("link").addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole("link"));
    expect(JSON.parse(sessionStorage.getItem(key())!).value.body).toBe("Unsaved");
    expect(confirm).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1_000));
    const retryUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, retryUnload);
    expect(retryUnload.defaultPrevented).toBe(true);
  });

  it("leaves new-tab clicks and same-page fragment links alone", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Harness value={{ body: "Unsaved" }} dirty />);
    const link = screen.getByRole("link");
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link, { ctrlKey: true });
    link.setAttribute("href", "#body");
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows storage failure without claiming the copy was saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    render(<Harness value={{ body: "Unsaved" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("alert")).toHaveTextContent("Recovery is unavailable");
    expect(screen.getByText("Recovery unavailable")).toBeInTheDocument();
    expect(sessionStorage.getItem(key())).toBeNull();
  });

  it("surfaces inaccessible storage and recovers when writes become available again", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    const { rerender } = render(<Harness value={{ body: "Kept in editor" }} dirty />);
    expect(screen.getByRole("alert")).toHaveTextContent("Keep this page open");
    read.mockRestore();
    rerender(<Harness value={{ body: "Another edit" }} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(key())!).value.body).toBe("Another edit");
  });

  it("cancels writes when the editor unmounts", () => {
    const { unmount } = render(<Harness value={{ body: "Unmounted" }} dirty />);
    unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(sessionStorage.getItem(key())).toBeNull();
  });

  it("explains that selected file contents are not recovered", () => {
    seed({ body: "An image message", missingFileName: "header.png" });
    render(<Harness />);
    expect(screen.getByText(/Reattach header.png/)).toBeInTheDocument();
  });

  it("refuses to silently serialize Blob or File content", () => {
    render(<Harness value={{ body: "File", attachment: new File(["image"], "header.png") } as Draft} dirty />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("alert")).toHaveTextContent("Recovery is unavailable");
    expect(sessionStorage.getItem(key())).toBeNull();
  });
});
