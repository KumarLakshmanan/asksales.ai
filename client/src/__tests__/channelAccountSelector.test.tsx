import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelAccountSelector } from "@/components/integrations/ChannelAccountSelector";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

describe("ChannelAccountSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the selected account after confirmation and reloads the replacement", async () => {
    apiMocks.get
      .mockResolvedValueOnce([
        { id: 1, accountIdentifier: "ig-old", accountName: "Old account", isSelected: true },
        { id: 2, accountIdentifier: "ig-next", accountName: "Next account", isSelected: false },
      ])
      .mockResolvedValueOnce([
        { id: 2, accountIdentifier: "ig-next", accountName: "Next account", isSelected: true },
      ]);
    apiMocks.delete.mockResolvedValue({ removedId: 1 });
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<ChannelAccountSelector platform="instagram_api" label="Publishing Instagram account" onChanged={onChanged} />);

    expect(await screen.findByText("Old account")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByRole("dialog", { name: "Choose an Instagram profile" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove current Publishing Instagram account" }));
    expect(await screen.findByText("Remove connected account?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove account" }));

    await waitFor(() => expect(apiMocks.delete).toHaveBeenCalledWith("/api/channel-accounts/instagram_api/1"));
    await waitFor(() => expect(screen.getByText("Next account")).toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("requires an explicit choice when OAuth returned multiple unselected accounts", async () => {
    apiMocks.get.mockResolvedValue([
      { id: 1, accountIdentifier: "page-a", accountName: "Page A", isSelected: false },
      { id: 2, accountIdentifier: "page-b", accountName: "Page B", isSelected: false },
    ]);
    apiMocks.post.mockResolvedValue({ id: 2, isSelected: true });
    const user = userEvent.setup();
    render(<ChannelAccountSelector platform="facebook_api" label="Facebook Page" />);
    const picker = await screen.findByRole("button", { name: "Choose" });
    expect(apiMocks.post).not.toHaveBeenCalled();
    await user.click(picker);
    await user.click(screen.getByRole("radio", { name: /Page B/ }));
    await user.click(screen.getByRole("button", { name: "Use this Page" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/channel-accounts/facebook_api/select", { credentialId: 2 }));
    await waitFor(() => expect(screen.getByText("Page B")).toBeInTheDocument());
  });
});
