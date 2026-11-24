import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportAiShell as SupportAILayout } from "@/components/support-ai/SupportAiShell";
import { supportRouteMemoryKey } from "@/lib/support-report";

const current = vi.hoisted(() => ({
  pathname: "/dashboard/support-ai/reports",
  query:
    "tab=conversations&sessionId=42&sessionPage=3&sessionSearch=invoice&source=widget",
  userId: 7,
  profileId: 10,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => current.pathname,
  useSearchParams: () => new URLSearchParams(current.query),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: current.userId } }),
}));
vi.mock("@/hooks/use-business-profiles", () => ({
  useBusinessProfiles: () => ({
    isLoading: false,
    activeProfile: { id: current.profileId },
  }),
}));
beforeEach(() => {
  sessionStorage.clear();
  current.pathname = "/dashboard/support-ai/reports";
  current.query =
    "tab=conversations&sessionId=42&sessionPage=3&sessionSearch=invoice&source=widget";
  current.userId = 7;
  current.profileId = 10;
});
afterEach(() => vi.clearAllMocks());

describe("Support AI navigation", () => {
  it("restores the report selection and page after visiting Chat", async () => {
    const view = render(<SupportAILayout>Report content</SupportAILayout>);
    await waitFor(() =>
      expect(sessionStorage.getItem(supportRouteMemoryKey(7, 10))).toContain(
        "sessionId=42",
      ),
    );
    current.pathname = "/dashboard/support-ai/chat";
    current.query = "session=8&search=pricing&source=internal";
    view.rerender(<SupportAILayout>Chat content</SupportAILayout>);
    const report = await screen.findByRole("link", { name: "Reports" });
    await waitFor(() =>
      expect(report.getAttribute("href")).toContain("sessionId=42"),
    );
    expect(report.getAttribute("href")).toContain("sessionPage=3");
    expect(report.getAttribute("href")).toContain("sessionSearch=invoice");
    expect(report.getAttribute("href")).toContain("source=internal");
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  it("keeps saved route selections separate for each account and business", async () => {
    sessionStorage.setItem(
      supportRouteMemoryKey(7, 10),
      JSON.stringify({
        "/dashboard/support-ai/reports": "sessionId=42&sessionPage=3",
      }),
    );
    current.pathname = "/dashboard/support-ai/chat";
    current.query = "";
    const view = render(<SupportAILayout>Chat content</SupportAILayout>);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Reports" }).getAttribute("href"),
      ).toContain("sessionId=42"),
    );
    current.profileId = 11;
    view.rerender(<SupportAILayout>Second business</SupportAILayout>);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Reports" })).toHaveAttribute(
        "href",
        "/dashboard/support-ai/reports",
      ),
    );
    current.userId = 8;
    current.profileId = 10;
    view.rerender(<SupportAILayout>Different account</SupportAILayout>);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Reports" })).toHaveAttribute(
        "href",
        "/dashboard/support-ai/reports",
      ),
    );
  });
});
