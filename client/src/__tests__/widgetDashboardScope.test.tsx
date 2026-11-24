import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const { scope, get, put, post, remove, toast } = vi.hoisted(() => ({
  scope: { userId: 7, profileId: 1 as number | null, ready: true, profileError: false, role: 'owner' },
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-support-report", () => ({
  useSupportWorkspace: () => ({
    ...scope,
    profiles: { isLoading: false, isError: scope.profileError, activeProfile: { id: scope.profileId, role: scope.role }, refetch: vi.fn() },
    headers: { "X-Business-Profile-Id": String(scope.profileId) },
  }),
}));
vi.mock("@/lib/api", () => ({ api: { get, put, post, delete: remove } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-platform-access", () => ({ usePlatformAccess: () => ({ isError: false, data: { maintenance: { enabled: false }, modules: [{ key: 'support', enabled: true, status: 'available', mode: 'inherit' }] } }) }));
vi.mock("@/hooks/use-business-profiles", () => ({ useBusinessProfiles: () => ({ activeProfile: { id: scope.profileId, companyName: `Widget workspace ${scope.profileId}`, role: 'owner' }, isLoading: false, isError: false }), businessProfileName: (profile: { companyName: string }) => profile.companyName }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
import WidgetSettingsPage from "@/app/dashboard/(main)/support-ai/widget-settings/page";
import SupportAIEmbedPage from "@/app/dashboard/(main)/support-ai/embed/page";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { DEFAULT_WIDGET_SETTINGS } from "@/lib/support-widget-settings";
const first = [
  {
    teamId: 10,
    teamName: "First business",
    token: "first-token",
    installation: null,
    settings: {
      ...DEFAULT_WIDGET_SETTINGS,
      greeting: "Hello from first business",
    },
  },
];
const second = [
  {
    teamId: 20,
    teamName: "Second business",
    token: "second-token",
    installation: null,
    settings: {
      ...DEFAULT_WIDGET_SETTINGS,
      greeting: "Hello from second business",
    },
  },
];
beforeEach(() => {
  scope.profileId = 1;
  scope.ready = true;
  scope.profileError = false;
  scope.role = 'owner';
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  get.mockImplementation((_url, options) =>
    Promise.resolve(
      options.headers[BUSINESS_PROFILE_HEADER] === "1" ? first : second,
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("widget dashboard workspace isolation", () => {
  it("shows a retry when the workspace cannot be verified instead of waiting indefinitely", () => {
    scope.profileError = true;
    scope.ready = false;
    render(<WidgetSettingsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Support workspace could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(get).not.toHaveBeenCalled();
  });
  it("offers the workspace chooser when no workspace exists without loading widget tokens", () => {
    scope.profileId = null;
    scope.ready = false;
    render(<WidgetSettingsPage />);
    expect(screen.getByRole('link', { name: 'Choose a workspace' })).toHaveAttribute('href', '/dashboard/select-profile');
    expect(get).not.toHaveBeenCalled();
  });
  it("does not offer support-team administration to staff when widget teams are empty", async () => {
    scope.role = 'member';
    get.mockResolvedValue([]);
    render(<WidgetSettingsPage />);
    await screen.findByRole('heading', { name: 'No support teams available' });
    expect(screen.queryByRole('link', { name: 'Set up support team' })).not.toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it("does not retain embed keys from the previous business when switching profiles", async () => {
    const view = render(<SupportAIEmbedPage />);
    await screen.findByText("first-token");
    scope.profileId = 2;
    view.rerender(<SupportAIEmbedPage />);
    expect(screen.queryByText("first-token")).not.toBeInTheDocument();
    await screen.findByText("second-token");
    expect(get.mock.calls[1][1].headers[BUSINESS_PROFILE_HEADER]).toBe("2");
    expect(get.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("pins a save to its originating business and ignores its result after a profile switch", async () => {
    let complete!: (value: unknown) => void;
    put.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<WidgetSettingsPage />);
    await screen.findByDisplayValue("Hello from first business");
    fireEvent.change(screen.getByLabelText("Greeting"), {
      target: { value: "Changed first greeting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(put.mock.calls[0][2].headers[BUSINESS_PROFILE_HEADER]).toBe("1");
    expect(screen.getByLabelText("Support team")).toBeDisabled();
    scope.profileId = 2;
    view.rerender(<WidgetSettingsPage />);
    await screen.findByDisplayValue("Hello from second business");
    complete({
      ...DEFAULT_WIDGET_SETTINGS,
      greeting: "Changed first greeting",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Greeting")).toHaveValue(
        "Hello from second business",
      ),
    );
    expect(toast).not.toHaveBeenCalled();
  });
  it("asks before discarding unsaved appearance when switching teams", async () => {
    get.mockResolvedValue([...first, ...second]);
    render(<WidgetSettingsPage />);
    await screen.findByDisplayValue("Hello from first business");
    fireEvent.change(screen.getByLabelText("Greeting"), {
      target: { value: "Unsaved greeting" },
    });
    fireEvent.change(screen.getByLabelText("Support team"), {
      target: { value: "20" },
    });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Greeting")).toHaveValue("Unsaved greeting");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Greeting")).toHaveValue("Unsaved greeting");
    fireEvent.change(screen.getByLabelText("Support team"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard and switch" }));
    expect(screen.getByLabelText("Greeting")).toHaveValue(
      "Hello from second business",
    );
  });
});
