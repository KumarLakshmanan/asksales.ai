import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api", () => ({ default: apiMocks }));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  AvatarFallback: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  AvatarImage: ({ alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

import { MetaAccountStatus } from "@/app/dashboard/(main)/integrations/meta/components/MetaAccountStatus";

describe("MetaAccountStatus provider binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockResolvedValue({
      adAccounts: [
        { id: "100", name: "Oro Circle", currency: "INR", timezone_name: "Asia/Kolkata" },
        { id: "200", name: "Oro Aakasam", currency: "INR", timezone_name: "Asia/Kolkata" },
      ],
      pages: [
        { id: "page-1", name: "ORO Resorts", pictureUrl: "https://example.com/oro.jpg" },
        { id: "page-2", name: "Oro Aakasam", pictureUrl: "https://example.com/aakasam.jpg" },
      ],
      selectedAdAccountId: "100",
      selectedPageId: "page-1",
    });
    apiMocks.post.mockResolvedValue({ success: true });
  });

  it("uses a visual modal with images, names, IDs, and an explicit two-part selection", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <MetaAccountStatus
        isConnected
        metaStatus={{ id: 1, platform: "meta", accountName: "Oro Circle", isActive: true, connectedAt: "2026-09-01T08:00:00Z" }}
        onChanged={onChanged}
      />,
    );

    expect(await screen.findByText("ID act_100")).toBeInTheDocument();
    expect(screen.getByText("ID page-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change binding" }));

    expect(await screen.findByRole("dialog", { name: "Choose the Meta Ads binding" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ORO Resorts" })).toHaveAttribute("src", "https://example.com/oro.jpg");
    expect(screen.getByRole("radio", { name: "Oro Circle, ID act_100" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "ORO Resorts, ID page-1" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Oro Aakasam, ID act_200" }));
    await user.click(screen.getByRole("radio", { name: "Oro Aakasam, ID page-2" }));
    await user.click(screen.getByRole("button", { name: "Save binding" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/meta/oauth/selection", { adAccountId: "200", pageId: "page-2" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose the Meta Ads binding" })).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
