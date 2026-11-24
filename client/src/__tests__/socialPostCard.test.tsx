import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SocialPostCard from "@/components/content-cards/SocialPostCard";

describe("SocialPostCard actions", () => {
  it("does not repeat the primary image when it is also in the carousel array", () => {
    render(
      <SocialPostCard
        variant="preview"
        title="Carousel post"
        content={JSON.stringify({ caption: "Carousel body" })}
        imageUrl="/uploads/slide-1.jpg"
        imageUrls={["/uploads/slide-1.jpg", "/uploads/slide-2.jpg"]}
      />,
    );

    expect(screen.getByText("1 / 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 / 2")).toBeVisible();
  });

  it("keeps download and delete as accessible card actions", () => {
    const onDownload = vi.fn();

    render(
      <SocialPostCard
        title="Test social post"
        content={JSON.stringify({ caption: "Test body", hashtags: ["#test"] })}
        onDownload={onDownload}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete Social Post?");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});
