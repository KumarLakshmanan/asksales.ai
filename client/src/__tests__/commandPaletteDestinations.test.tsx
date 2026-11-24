import React, { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/CommandPalette";
import type { PlatformModuleKey } from "@/lib/platform-access";
import { api, type ApiOptions } from "@/lib/api";

const mocks = vi.hoisted(() => ({ push: vi.fn(), profileId: 41, userId: 1, role: "owner" as "owner" | "member" | undefined, pathname: "/dashboard/saved-templates", search: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock("@/hooks/use-business-profiles", () => ({ useBusinessProfiles: () => ({ activeProfile: { id: mocks.profileId, role: mocks.role }, isLoading: false }) }));

function Harness({ modules = ["content", "support_ai", "outreach", "performance_marketing", "crm", "proposals", "support"] }: { modules?: PlatformModuleKey[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} onClick={() => setOpen(true)}>Find a page</button><CommandPalette open={open} onOpenChange={setOpen} enabledModules={modules} workspaceName={`Business ${mocks.profileId}`} returnFocusRef={trigger} /></>;
}

beforeEach(() => {
  mocks.push.mockReset(); mocks.profileId = 41; mocks.userId = 1; mocks.role = "owner"; mocks.pathname = "/dashboard/saved-templates"; mocks.search = "";
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, "get").mockResolvedValue({ permissions: { canManage: false } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderPalette(modules?: PlatformModuleKey[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrap = (children: React.ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = render(wrap(<Harness modules={modules} />));
  return { ...view, rerenderPalette: (nextModules = modules) => view.rerender(wrap(<Harness modules={nextModules} />)) };
}

describe("command palette task discovery", () => {
  it('ignores a browser event without a key while preserving the normal shortcut', async () => {
    renderPalette();
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event); event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      const event = new KeyboardEvent('keydown', { ctrlKey: true });
      Object.defineProperty(event, 'key', { value: undefined });
      fireEvent(document, event);
      expect(errors).toHaveLength(0);
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'K', ctrlKey: true });
      expect(await screen.findByRole('combobox')).toBeVisible();
    } finally { window.removeEventListener('error', onError); }
  });
  it("focuses the input, selects the exact task with Enter and restores trigger focus", async () => {
    const user = userEvent.setup(); renderPalette();
    const trigger = screen.getByRole("button", { name: "Find a page" });
    await user.click(trigger);
    const input = screen.getByRole("combobox", { name: "Search pages, actions, and settings" });
    expect(input).toHaveFocus();
    await user.type(input, "blog");
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveTextContent("Blog postsContent Creator / Content library"));
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/saved-templates/blog");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retains arrow navigation, Escape, shortcut toggling and no-result recovery", async () => {
    const user = userEvent.setup(); renderPalette();
    const trigger = screen.getByRole("button", { name: "Find a page" }); trigger.focus();
    await user.keyboard("{Control>}k{/Control}");
    const input = screen.getByRole("combobox"); expect(input).toHaveFocus();
    await user.type(input, "templates");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const first = screen.getAllByRole("option")[0]; const second = screen.getAllByRole("option")[1];
    await user.keyboard("{ArrowDown}"); expect(second).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}"); expect(first).toHaveAttribute("aria-selected", "true");
    await user.clear(input); await user.type(input, "zzzz-no-destination-98765");
    expect(screen.getByText("No results found")).toBeVisible(); expect(input).toHaveFocus();
    await user.clear(input); await user.type(input, "follow-up history");
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveAttribute("data-value", "/dashboard/outreach/follow-ups?tab=history"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus()); expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps repeated titles distinguishable by visible parent text", async () => {
    const user = userEvent.setup(); renderPalette(); await user.click(screen.getByRole("button", { name: "Find a page" }));
    await user.type(screen.getByRole("combobox"), "pipeline");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("PipelineCRM"); expect(options[1]).toHaveTextContent("PipelineSupport");
    for (const option of options.slice(0, 2)) expect(option.querySelector("span.text-left > span:last-child")).toBeVisible();
  });

  it("hides unavailable modules and performs no assistant catalog read for them", async () => {
    const user = userEvent.setup(); renderPalette(["content"]); await user.click(screen.getByRole("button", { name: "Find a page" }));
    expect(api.get).not.toHaveBeenCalled();
    for (const term of ["follow-up history", "widget settings", "assistants", "paid ads recommendations"]) {
      const input = screen.getByRole("combobox"); await user.clear(input); await user.type(input, term);
      expect(screen.getByText("No results found")).toBeVisible();
    }
  });

  it("uses the current account/business permission and removes an owner's action on workspace change", async () => {
    vi.mocked(api.get).mockImplementation(async <T,>(_url: string, options?: ApiOptions) => ({ permissions: { canManage: new Headers(options?.headers).get("X-Business-Profile-Id") === "41" } }) as T);
    const user = userEvent.setup(); const view = renderPalette();
    expect(api.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Find a page" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Create assistant — Support AI / Assistants / Editor" })).toBeVisible());
    expect(api.get).toHaveBeenCalledWith("/api/settings/outreach/assistants/catalog", { headers: { "X-Business-Profile-Id": "41" } });
    mocks.profileId = 42; view.rerenderPalette();
    expect(screen.queryByRole("option", { name: "Create assistant — Support AI / Assistants / Editor" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/settings/outreach/assistants/catalog", { headers: { "X-Business-Profile-Id": "42" } }));
    expect(screen.getByText("Pages in Business 42")).toBeVisible();
    mocks.profileId = 41; mocks.userId = 2; vi.mocked(api.get).mockResolvedValue({ permissions: { canManage: false } }); view.rerenderPalette();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("option", { name: "Create assistant — Support AI / Assistants / Editor" })).not.toBeInTheDocument();
  });

  it("keeps explicit widget team context across destinations and removes restricted settings on role changes", async () => {
    mocks.search = "team=4104&tab=appearance";
    const user = userEvent.setup(); const view = renderPalette(["integrations", "support_ai"]);
    await user.click(screen.getByRole("button", { name: "Find a page" }));
    const input = screen.getByRole("combobox"); await user.type(input, "integrations");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("data-value", "/dashboard/integrations");
    mocks.role = "member"; view.rerenderPalette();
    expect(screen.queryByRole("option", { name: /^Integrations —/ })).not.toBeInTheDocument();
    await user.clear(input); await user.type(input, "widget settings"); await user.keyboard("{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/support-ai/widget-settings?team=4104");
  });
});
