import React, { StrictMode, useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), default: mocks }));
import { ApiError } from "@/lib/api";
import { loadSetupDraft, useSetupDraft } from "@/components/setup/useSetupDraft";

const record = (name: string, revision: number) => ({ data: { name }, step: 2, revision, updatedAt: "2026-10-03T10:00:00Z" });
function useEditor(key = "brand:26", sourceVersion?: number) {
  const [data, setData] = useState({ name: "Saved profile" });
  const [step, setStep] = useState(1);
  const draft = useSetupDraft({ storageKey: `draft:${key}`, remoteKey: key, ready: true, sourceVersion, data, step, restore: (next, section) => { setData(next); setStep(section); } });
  return { data, setData, step, draft };
}
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks();
  mocks.get.mockResolvedValue({ draft: null });
  mocks.put.mockImplementation(async (_url, value) => ({ draft: { ...value, revision: value.expectedRevision + 1, updatedAt: new Date().toISOString() } }));
  mocks.delete.mockResolvedValue({ draft: null });
});
afterEach(cleanup);

describe("durable setup drafts", () => {
  it("restores the account copy without browser storage, including under Strict Mode", async () => {
    mocks.get.mockResolvedValue({ draft: record("Another device", 4) });
    const { result } = renderHook(() => useEditor(), { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> });
    await waitFor(() => expect(result.current.draft.ready).toBe(true));
    expect(result.current.data.name).toBe("Another device");
    expect(result.current.step).toBe(2);
    await act(() => result.current.draft.flush());
    expect(mocks.put).toHaveBeenCalledWith("/api/setup/drafts/brand%3A26", expect.objectContaining({ expectedRevision: 4 }));
  });
  it("blocks restoring a draft based on an older saved toolkit", async () => {
    mocks.get.mockResolvedValue({ draft: { ...record("Older unfinished edits", 4), data: { name: "Older unfinished edits", __setupSourceVersion: 2 } } });
    const { result } = renderHook(() => useEditor("brand:26", 3));
    await waitFor(() => expect(result.current.draft.ready).toBe(true));
    expect(result.current.data.name).toBe("Saved profile");
    expect(result.current.draft.conflictKind).toBe("source");
    await expect(result.current.draft.flush()).rejects.toThrow("Resolve");
    await act(() => result.current.draft.discard());
    await act(() => result.current.draft.flush());
    expect(mocks.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: { name: "Saved profile", __setupSourceVersion: 3 }, expectedRevision: 0 }));
  });
  it("does not resurrect a local draft cleared on another device", async () => {
    sessionStorage.setItem("draft:brand:26", JSON.stringify({ version: 2, data: { name: "Stale" }, step: 3, revision: 6, updatedAt: Date.now() }));
    expect((await loadSetupDraft("draft:brand:26", "brand:26")).draft).toBeNull();
  });
  it("keeps local edits on conflict, blocks writes, and requires explicit reload", async () => {
    mocks.get.mockResolvedValue({ draft: record("Account copy", 2) });
    const { result } = renderHook(() => useEditor());
    await waitFor(() => expect(result.current.draft.ready).toBe(true));
    act(() => result.current.setData({ name: "My unsaved edit" }));
    mocks.put.mockRejectedValue(new ApiError("Changed elsewhere", 409));
    await act(async () => { await result.current.draft.flush().catch(() => {}); });
    expect(result.current.draft.status).toBe("conflict");
    expect(result.current.data.name).toBe("My unsaved edit");
    await expect(result.current.draft.flush()).rejects.toThrow("Resolve");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue({ draft: record("Latest account copy", 3) });
    await act(() => result.current.draft.reload());
    expect(result.current.data.name).toBe("Latest account copy");
    expect(result.current.draft.status).toBe("saved");
  });
  it("retains an offline draft and prevents writes until the account revision is checked", async () => {
    mocks.get.mockRejectedValue(new Error("Offline"));
    const { result } = renderHook(() => useEditor());
    await waitFor(() => expect(result.current.draft.ready).toBe(true));
    act(() => result.current.setData({ name: "Offline work" }));
    expect(result.current.draft.status).toBe("error");
    await expect(result.current.draft.flush()).rejects.toThrow("Resolve");
    expect(mocks.put).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ draft: null });
    await act(() => result.current.draft.retry());
    expect(mocks.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: { name: "Offline work" }, expectedRevision: 0 }));
  });
  it("serializes concurrent saves and clears only the saved revision", async () => {
    const { result } = renderHook(() => useEditor());
    await waitFor(() => expect(result.current.draft.ready).toBe(true));
    let finish: (value: unknown) => void = () => {};
    mocks.put.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let first!: Promise<void>;
    act(() => { first = result.current.draft.flush(); });
    act(() => result.current.setData({ name: "Newer edit" }));
    let second!: Promise<void>;
    act(() => { second = result.current.draft.flush(); });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ draft: record("Saved profile", 1) }); await first; await second; });
    expect(mocks.put.mock.calls[1][1]).toMatchObject({ expectedRevision: 1, data: { name: "Newer edit" } });
    await act(() => result.current.draft());
    expect(mocks.delete).toHaveBeenCalledWith("/api/setup/drafts/brand%3A26", expect.objectContaining({ body: JSON.stringify({ expectedRevision: 2 }) }));
    expect(sessionStorage.getItem("draft:brand:26")).toBeNull();
  });
});
