import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SavedTemplatesPage from "@/app/dashboard/(main)/saved-templates/page";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-content-counts", () => ({ useContentCounts: () => ({ data: {}, isLoading: false, isError: false }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: {}, isLoading: false, isError: false }) }));
vi.mock("@/lib/api", () => ({ default: { get: vi.fn() }, api: { get: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("content library cards", () => {
  it("uses one primary Create and one secondary Open library button on every card", () => {
    render(<SavedTemplatesPage />);
    const createButtons = screen.getAllByRole("button", { name: /^Create: / });
    const openButtons = screen.getAllByRole("button", { name: /^Open library: / });
    expect(createButtons.length).toBeGreaterThanOrEqual(8);
    expect(openButtons).toHaveLength(createButtons.length);
    for (const button of openButtons) expect(button.className).toMatch(/border/);
  });

  it("links the provider requirement to provider settings", () => {
    render(<SavedTemplatesPage />);
    const link = screen.getByRole("link", { name: "Configure images provider" });
    expect(link).toHaveAttribute("href", "/dashboard/integrations");
    expect(screen.getByRole("link", { name: "Configure videos provider" })).toBeInTheDocument();
  });

  it("shows an empty-state line with a create prompt instead of a bare 0 saved", () => {
    render(<SavedTemplatesPage />);
    const emailCard = screen.getByRole("heading", { name: /Email/ }).closest("article") as HTMLElement;
    expect(within(emailCard).getByText("None saved")).toBeInTheDocument();
    expect(within(emailCard).getByText(/Nothing saved yet\. Create your first email/)).toBeInTheDocument();
    expect(screen.queryByText("0 saved")).not.toBeInTheDocument();
  });
});
