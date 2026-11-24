import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import CreatePaidCampaignPage from "@/app/dashboard/(main)/ads/create/page";

const navigation = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams("sourceAdId=123456789&sourcePage=Example+Ads&sourceFormat=video&sourceCopy=Book+a+demo&sourceUrl=https%3A%2F%2Fwww.facebook.com%2Fads%2Flibrary%2F%3Fid%3D123456789") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push }), useSearchParams: () => navigation.params }));

it("carries the chosen public ad format into a review-only campaign brief", () => {
  render(<CreatePaidCampaignPage />);
  expect(screen.getByText("Observed format: video")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Who should see this ad, what are you offering, and where should they go?"), { target: { value: "Teams booking product demos at example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with Performance Marketing" }));
  const destination = new URL(navigation.push.mock.calls[0][0], "https://example.com");
  const brief = destination.searchParams.get("paidAdBrief") || "";
  expect(brief).toContain("Library ID 123456789");
  expect(brief).toContain("Prepare an original video creative concept");
  expect(brief).toContain("Ask for my explicit publishing approval");
});
