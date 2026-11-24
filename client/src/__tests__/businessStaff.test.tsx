import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BusinessStaffPage from "@/app/dashboard/(main)/settings/team/page";
import { BusinessInvitations } from "@/components/BusinessInvitations";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { capabilities } from "@/components/ai-visibility/workspace-context";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  checkAuth: vi.fn(),
  openDashboard: vi.fn(),
  push: vi.fn(),
  role: "owner",
  pathname: "/dashboard/settings/team",
  hasBusinessProfile: true,
  hasBrandToolkit: true,
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 5, email: "me@example.test" },
    workspaceRole: mocks.role,
    isAuthenticated: true,
    isLoading: false,
    isApproved: true,
    isSetupComplete: true,
    hasBusinessProfile: mocks.hasBusinessProfile,
    hasBrandToolkit: mocks.hasBrandToolkit,
    checkAuth: mocks.checkAuth,
  }),
}));
vi.mock("@/hooks/use-business-profiles", () => ({
  businessProfileName: (p: { name: string }) => p.name,
  useBusinessProfiles: () => ({
    activeProfile: {
      id: 11,
      name: "North Studio",
      role: mocks.role,
      canManageTeam: mocks.role === "owner",
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/business-profile", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openBusinessDashboard: mocks.openDashboard,
}));
const router = { push: mocks.push };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => mocks.pathname,
}));
const owner = {
  id: 1,
  userId: 5,
  email: "owner@example.test",
  role: "owner",
  status: "active",
};
const staff = {
  id: 2,
  userId: 6,
  email: "staff@example.test",
  role: "member",
  status: "active",
};
let members = [owner, staff];
function mount(children: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {children}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 5 }));
  mocks.role = "owner";
  mocks.pathname = "/dashboard/settings/team";
  mocks.hasBusinessProfile = true;
  mocks.hasBrandToolkit = true;
  members = [owner, staff];
  mocks.get.mockImplementation(() => Promise.resolve({ members }));
  mocks.post.mockResolvedValue({});
  mocks.patch.mockResolvedValue({});
  mocks.delete.mockResolvedValue({});
  mocks.checkAuth.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Business staff access", () => {
  it("creates an invitation for the selected business with the chosen role", async () => {
    const user = userEvent.setup();
    mount(<BusinessStaffPage />);
    await screen.findByText("staff@example.test");
    await user.type(screen.getByLabelText("Email address"), "new@example.test");
    await user.selectOptions(
      screen.getByLabelText("Role", { exact: true }),
      "billing_admin",
    );
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/api/settings/business-profiles/11/members",
        { email: "new@example.test", role: "billing_admin" },
        { headers: { "X-Business-Profile-Id": "11" } },
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invitation created",
    );
  });
  it("shows membership to staff without exposing role or invitation controls", async () => {
    mocks.role = "member";
    mount(<BusinessStaffPage />);
    await screen.findByText("staff@example.test");
    expect(
      screen.queryByRole("button", { name: "Create invitation" }),
    ).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/settings/business-profiles/11/members",
      { headers: { "X-Business-Profile-Id": "11" } },
    );
  });
  it("confirms revocation before removing access and retains the removed record", async () => {
    const user = userEvent.setup();
    mount(<BusinessStaffPage />);
    await user.click(
      await screen.findByRole("button", { name: "Remove staff@example.test" }),
    );
    expect(mocks.delete).not.toHaveBeenCalled();
    members = [owner, { ...staff, status: "revoked" }];
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith(
        "/api/settings/business-profiles/11/members/2",
        { headers: { "X-Business-Profile-Id": "11" } },
      ),
    );
    expect(await screen.findByText("Removed access (1)")).toBeInTheDocument();
  });
  it("accepts a profile invitation before setup and opens the invited business", async () => {
    const user = userEvent.setup();
    mocks.hasBusinessProfile = false;
    mocks.get.mockResolvedValue({
      invitations: [
        {
          id: 9,
          businessProfileId: 22,
          businessProfileName: "South Studio",
          email: "me@example.test",
          role: "member",
        },
      ],
    });
    mocks.post.mockResolvedValue({
      businessProfile: { id: 22, name: "South Studio", role: "member" },
    });
    mount(<BusinessInvitations showEmpty />);
    await user.click(
      await screen.findByRole("button", { name: "Join South Studio" }),
    );
    await waitFor(() => expect(mocks.openDashboard).toHaveBeenCalled());
    expect(sessionStorage.getItem("active-business-profile:5")).toBe("22");
    expect(mocks.checkAuth).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/settings/business-profiles/invitations/9/accept",
      {},
    );
  });
  it("lets an invited user reach invitations without creating a personal business", () => {
    mocks.pathname = "/dashboard/invitations";
    mocks.hasBusinessProfile = false;
    mocks.hasBrandToolkit = false;
    mount(
      <ProtectedRoute>
        <p>Join business</p>
      </ProtectedRoute>,
    );
    expect(screen.getByText("Join business")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("does not require staff to create their own brand toolkit", () => {
    mocks.pathname = "/dashboard/home";
    mocks.role = "member";
    mocks.hasBrandToolkit = false;
    mount(
      <ProtectedRoute>
        <p>Business dashboard</p>
      </ProtectedRoute>,
    );
    expect(screen.getByText("Business dashboard")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("allows canonical staff to run analyses without granting membership or connection management", () => {
    expect(capabilities("member")).toEqual({
      edit: true,
      bill: true,
      review: true,
      members: false,
      connections: false,
    });
    expect(capabilities("billing_admin")).toEqual({
      edit: true,
      bill: true,
      review: true,
      members: false,
      connections: true,
    });
    expect(capabilities("client_reviewer").bill).toBe(false);
  });
});
