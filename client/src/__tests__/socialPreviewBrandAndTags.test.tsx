import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import SocialPostContentRenderer from "@/components/modals/content-fullscreen/SocialPostContentRenderer";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";

describe("Social post previews", () => {
  it("keeps hashtags on library cards but drops markdown heading marks", () => {
    render(
      <TemplatePreviewCard
        kind="social"
        title="Launch post"
        content={JSON.stringify({ caption: "## Big news\nWe launched today #Marketing #SaaS" })}
      />,
    );
    const body = screen.getByText(/We launched today/);
    expect(body.textContent).toContain("#Marketing #SaaS");
    expect(body.textContent).not.toContain("##");
  });

  it("shows the selected business name instead of a placeholder", () => {
    const client = new QueryClient();
    client.setQueryData(["business-profiles", 7], [
      { id: 1, companyName: "Other Co" },
      { id: 2, companyName: "Aimplify", isDefault: true },
    ]);
    render(
      <QueryClientProvider client={client}>
        <SocialPostContentRenderer title="Post" content="" parsedContent={{ caption: "Hello" }} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Aimplify")).toBeTruthy();
    expect(screen.queryByText("@yourbrand")).toBeNull();
  });

  it("falls back to a generic label when no business is loaded", () => {
    render(<SocialPostContentRenderer title="Post" content="" parsedContent={{ caption: "Hello" }} />);
    expect(screen.getByText("Your Brand")).toBeTruthy();
  });
});
