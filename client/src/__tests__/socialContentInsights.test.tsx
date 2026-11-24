import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get: mocks.get, post: mocks.post } }));
import {
  ContentFeed,
  ContentThumbnail,
  ContentOverview,
  type SocialContentData,
} from "@/components/social-insights/SocialContentInsights";
const item = {
  id: "123",
  platform: "instagram",
  type: "reel",
  publishedAt: "2026-09-05T12:00:00Z",
  caption: "A weekend at the resort",
  permalink: "https://www.instagram.com/reel/example/",
  thumbnailUrl: null,
  metrics: { views: 300, comments: 2, profile_visits: 12 },
  metricsUpdatedAt: "2026-09-09T00:00:00Z",
  limitations: [],
};
const data: SocialContentData = {
  items: [item],
  nextOffset: null,
  totalPosts: 1,
  metricTotals: item.metrics,
  metricCoverage: { views: 1, comments: 1, profile_visits: 1 },
  formats: [
    {
      type: "reel",
      posts: 1,
      metricTotals: item.metrics,
      metricCoverage: { views: 1 },
    },
  ],
  timeline: [
    { date: "2026-09-05", posts: 0, reels: 1, stories: 0, items: [item] },
  ],
  topContent: [{ ...item, contributionPercent: 100 }],
  rankingMetric: "profile_visits",
  truncated: false,
  sync: null,
};
describe("Social Insights content", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shows actual profile attribution and links publishing days to content", () => {
    const onDay = vi.fn();
    render(<ContentOverview data={data} onDay={onDay} onBrowse={vi.fn()} />);
    expect(
      screen.getByText("Posts driving profile visits"),
    ).toBeInTheDocument();
    expect(screen.getByText(/12 profile visits/)).toBeInTheDocument();
    const publicationDate = new Date('2026-09-05T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    fireEvent.click(screen.getByRole("button", { name: name => name.includes(publicationDate) && name.includes('1 reel') }));
    expect(onDay).toHaveBeenCalledWith("2026-09-05");
  });
  it("loads paginated comments and retains the existing page without duplicating comments", async () => {
    const first = {
      id: "c1",
      body: "Beautiful place",
      author: "Alice",
      publishedAt: "2026-09-05",
      likes: 0,
      permalink: null,
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("after=next")
        ? {
            comments: [
              first,
              { ...first, id: "c2", body: "How do I book?", author: "Bob" },
            ],
            nextCursor: null,
            limitation: "Visible comments only",
          }
        : {
            comments: [first],
            nextCursor: "next",
            limitation: "Visible comments only",
          },
    );
    render(
      <ContentFeed
        credentialId="22"
        data={data}
        loading={false}
        error={null}
        load={vi.fn()}
        day={null}
        clearDay={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View comments" }));
    expect(await screen.findByText("Beautiful place")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    expect(await screen.findByText("How do I book?")).toBeInTheDocument();
    expect(screen.getAllByText("Beautiful place")).toHaveLength(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more comments" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/social-analytics/content/123/comments?credentialId=22&platform=instagram&after=next",
    );
  });
  it("searches the whole content range through the server", async () => {
    const load = vi.fn();
    render(
      <ContentFeed
        credentialId="22"
        data={data}
        loading={false}
        error={null}
        load={load}
        day={null}
        clearDay={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search content captions" }),
      { target: { value: "beyond the first page" } },
    );
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(0, {
        kind: "all",
        sort: "published",
        q: "beyond the first page",
      }),
    );
  });
  it("requires an explicit publish click and retains the receipt on uncertain reply failure", async () => {
    mocks.get.mockResolvedValue({
      comments: [
        {
          id: "99",
          body: "Question",
          author: "Guest",
          publishedAt: null,
          likes: 0,
          permalink: null,
        },
      ],
      nextCursor: null,
      limitation: "",
      capabilities: { reply: true, moderate: true, reason: null },
    });
    mocks.post.mockRejectedValue(
      new Error("Check the original post before retrying."),
    );
    render(
      <ContentFeed
        credentialId="22"
        data={data}
        loading={false}
        error={null}
        load={vi.fn()}
        day={null}
        clearDay={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View comments" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Public reply from your connected account",
      }),
      { target: { value: "Hello there" } },
    );
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publish reply" }));
    await screen.findByText("Check the original post before retrying.");
    const key = mocks.post.mock.calls[0][1].idempotencyKey;
    fireEvent.click(screen.getByRole("button", { name: "Publish reply" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1].idempotencyKey).toBe(key);
  });
});

describe("Instagram preview recovery", () => {
  it("uses carousel images when the cover is absent and skips failed sources", async () => {
    render(<ContentThumbnail item={{ ...item, type: "carousel", children: [
      { id: "1", type: "image", mediaUrl: "https://example.com/first.jpg", thumbnailUrl: null },
      { id: "2", type: "image", mediaUrl: "https://example.com/second.jpg", thumbnailUrl: null },
    ] }} />);
    expect(screen.getByAltText("Post preview")).toHaveAttribute("src", "https://example.com/first.jpg");
    fireEvent.error(screen.getByAltText("Post preview"));
    expect(screen.getByAltText("Post preview")).toHaveAttribute("src", "https://example.com/second.jpg");
  });

  it("refreshes an expired preview once and stops retrying if the new image also fails", async () => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({ item: { ...item, thumbnailUrl: "https://example.com/fresh.jpg" } });
    render(<ContentThumbnail credentialId="22" item={{ ...item, thumbnailUrl: "https://example.com/expired.jpg" }} />);
    fireEvent.error(screen.getByAltText("Post preview"));
    await waitFor(() => expect(screen.getByAltText("Post preview")).toHaveAttribute("src", "https://example.com/fresh.jpg"));
    expect(mocks.get).toHaveBeenCalledWith("/api/social-analytics/content/123?credentialId=22&platform=instagram&refreshMedia=1");
    fireEvent.error(screen.getByAltText("Post preview"));
    await screen.findByText("Preview unavailable");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("never uses a reel video URL as an image", () => {
    render(<ContentThumbnail item={{ ...item, mediaType: "VIDEO", mediaUrl: "https://example.com/reel.mp4" }} />);
    expect(screen.queryByAltText("Post preview")).not.toBeInTheDocument();
  });
});
