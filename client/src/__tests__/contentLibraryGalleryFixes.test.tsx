import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { prependUniqueById, uniqueById } from "@/lib/uniqueById";
import { groupByDay } from "@/lib/libraryDateGroups";
import { mediaForSocialFormat, noSocialFormatMessage, recommendedSocialFormat, socialFormatsFor } from "@/lib/socialPublishing";
import SocialPage from "@/app/dashboard/(main)/saved-templates/social/page";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  templates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/use-paginated-content-templates", () => ({
  usePaginatedContentTemplates: () => ({ templates: mocks.templates, total: mocks.templates.length, isLoading: false, isError: false, refetch: vi.fn(), hasNextPage: false }),
}));
vi.mock("@/components/social-publishing/SocialPublisher", () => ({ SocialPublisher: () => null }));

afterEach(cleanup);

describe("gallery de-duplication", () => {
  it("keeps one copy of each saved asset across overlapping offset pages", () => {
    const page1 = [{ id: 9 }, { id: 8 }, { id: 7 }];
    const page2 = [{ id: 7 }, { id: 6 }]; // row 7 shifted onto the next page
    expect(uniqueById([...page1, ...page2]).map((item) => item.id)).toEqual([9, 8, 7, 6]);
  });

  it("does not duplicate a fresh generation that a refetch already loaded", () => {
    const loaded = [{ id: "db-5", title: "from refetch" }, { id: "db-4", title: "older" }];
    const fresh = [{ id: "db-5", title: "from response" }];
    expect(prependUniqueById(fresh, loaded)).toEqual([{ id: "db-5", title: "from response" }, { id: "db-4", title: "older" }]);
  });
});

describe("saved posts grouped by date", () => {
  const now = new Date("2026-11-16T10:00:00+05:30");

  it("sorts newest first and labels Today, Yesterday and older days", () => {
    const groups = groupByDay([
      { id: 1, createdAt: "2026-11-10T05:00:00Z" },
      { id: 2, createdAt: "2026-11-16T03:00:00Z" },
      { id: 3, createdAt: "2026-11-15T09:00:00Z" },
      { id: 4, createdAt: "2026-11-16T01:00:00Z" },
    ], (item) => item.createdAt, { now, timeZone: "Asia/Kolkata" });
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Tue, Nov 10, 2026"]);
    expect(groups[0].items.map((item) => item.id)).toEqual([2, 4]);
  });

  it("groups by the business timezone, not UTC", () => {
    // 20:00 UTC on the 15th is already the 16th in India.
    const groups = groupByDay([{ id: 1, createdAt: "2026-11-15T20:00:00Z" }], (item) => item.createdAt, { now, timeZone: "Asia/Kolkata" });
    expect(groups[0].label).toBe("Today");
  });

  it("puts undated items last", () => {
    const groups = groupByDay([{ id: 1, createdAt: "" }, { id: 2, createdAt: "2026-11-16T03:00:00Z" }], (item) => item.createdAt, { now, timeZone: "Asia/Kolkata" });
    expect(groups.map((group) => group.key)).toEqual(["2026-11-16", "undated"]);
  });

  it("renders saved posts in date sections with an even grid and starter templates last", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      mocks.templates = [
        { id: 31, name: "Starter launch post", type: "social", content: "Starter copy", isPredefined: true, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
        { id: 32, name: "My reusable post", type: "social", content: "Reusable copy", createdAt: "2026-11-10T05:00:00Z", updatedAt: "2026-11-10T05:00:00Z" },
      ];
      mocks.get.mockResolvedValue([
        { id: 41, type: "social_post", title: "Today's draft", content: JSON.stringify({ caption: "Fresh" }), channel: "instagram", status: "draft", createdAt: "2026-11-16T03:00:00Z" },
        { id: 41, type: "social_post", title: "Today's draft", content: JSON.stringify({ caption: "Fresh" }), channel: "instagram", status: "draft", createdAt: "2026-11-16T03:00:00Z" },
      ]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
      render(wrap(<SocialPage />));
      const today = await screen.findByRole("region", { name: "Today" });
      expect(within(today).getAllByText("Today's draft")).toHaveLength(1);
      const sections = screen.getAllByRole("region").map((section) => section.getAttribute("aria-labelledby"));
      expect(sections).toEqual(["social-group-2026-11-16", "social-group-2026-11-10", "social-group-starter"]);
      expect(screen.getByRole("region", { name: "Starter templates" })).toHaveTextContent("Starter launch post");
      expect(today.querySelector(".grid")).toHaveClass("items-stretch");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("publishing formats follow the media type", () => {
  it("offers Instagram Reel first for a single video", () => {
    expect(socialFormatsFor("instagram", 0, 1).map((format) => format.value)).toEqual(["reel", "story"]);
    expect(recommendedSocialFormat("instagram", 0, 1)).toBe("reel");
  });

  it("offers Reel (video only) and Carousel when a video post also has a generated image", () => {
    const formats = socialFormatsFor("instagram", 1, 1);
    expect(formats.map((format) => format.value)).toEqual(["reel", "carousel"]);
    expect(formats[0].label).toBe("Instagram Reel · video only");
    expect(recommendedSocialFormat("instagram", 1, 1)).toBe("reel");
  });

  it("keeps image-only formats for images", () => {
    expect(socialFormatsFor("instagram", 1, 0).map((format) => format.value)).toEqual(["post", "story"]);
    expect(socialFormatsFor("instagram", 3, 0).map((format) => format.value)).toEqual(["carousel"]);
    expect(socialFormatsFor("facebook", 1, 1).map((format) => format.value)).toEqual(["video"]);
  });

  it("publishes only the video for video-only formats", () => {
    const media = { imageUrls: ["/uploads/a.png"], videoUrls: ["/uploads/v.mp4"] };
    expect(mediaForSocialFormat("instagram", "reel", media)).toEqual({ imageUrls: [], videoUrls: ["/uploads/v.mp4"] });
    expect(mediaForSocialFormat("instagram", "carousel", media)).toEqual(media);
    expect(mediaForSocialFormat("youtube", "short", media)).toEqual({ imageUrls: [], videoUrls: ["/uploads/v.mp4"] });
  });

  it("explains why no format is available", () => {
    expect(noSocialFormatMessage("youtube", 1, 0)).toMatch(/needs a saved video/);
    expect(noSocialFormatMessage("instagram", 0, 2)).toMatch(/one video/);
  });
});
