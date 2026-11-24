import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageCard from "@/components/content-cards/ImageCard";

describe("ImageCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads the normalized image instead of opening a duplicate tab", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
    const createObjectUrl = vi.fn().mockReturnValue("blob:test-image");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    vi.stubGlobal("fetch", fetchMock);

    render(<ImageCard title="Launch visual" imageUrl="/uploads/1/image/test.png" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(clickMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/uploads/1/image/test.png");
    expect(createObjectUrl).toHaveBeenCalledWith(blob);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("keeps the generation prompt in the expanded preview", () => {
    render(<ImageCard title="Launch visual" imageUrl="/uploads/1/image/test.png" prompt="A quiet blue launch scene" />);

    expect(screen.queryByText("A quiet blue launch scene")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand image" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Prompt Used")).toBeInTheDocument();
    expect(screen.getByText("A quiet blue launch scene")).toBeInTheDocument();
  });
});
