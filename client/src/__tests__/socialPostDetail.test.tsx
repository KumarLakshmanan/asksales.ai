import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));
import { SocialPostDetail } from "@/components/social-insights/SocialPostDetail";
import { PostComments } from "@/components/social-insights/SocialContentInsights";
const props = {
  postId: "123",
  credentialId: "22",
  platform: "instagram",
  startDate: "2026-09-01",
  endDate: "2026-09-18",
};
const item = {
  id: "123",
  platform: "instagram",
  type: "carousel",
  caption: "A day in the hills",
  publishedAt: "2026-09-10T12:00:00Z",
  thumbnailUrl: "https://example.com/one.jpg",
  permalink: "https://www.instagram.com/p/example/",
  metrics: { reach: 200, engagements: 10, likes: 0 },
  metricsUpdatedAt: "2026-09-18T12:00:00Z",
  limitations: [],
  children: [
    {
      id: "1",
      type: "IMAGE",
      mediaUrl: "https://example.com/one.jpg",
      thumbnailUrl: null,
    },
    {
      id: "2",
      type: "IMAGE",
      mediaUrl: "https://example.com/two.jpg",
      thumbnailUrl: null,
    },
  ],
};
const comment = {
  id: "10",
  body: "Lovely place",
  author: "Guest",
  publishedAt: null,
  likes: 0,
  permalink: null,
  canReply: true,
};
describe("Dedicated social post details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("/comments")
        ? {
            comments: [],
            nextCursor: null,
            limitation: "",
            capabilities: { reply: true, moderate: true, reason: null },
          }
        : {
            item,
            account: {
              id: 22,
              name: "orocircle",
              platform: "instagram",
              identifier: "account",
            },
          },
    );
  });
  it("loads one owned post independently of the dashboard dates and presents real metrics", async () => {
    render(<SocialPostDetail {...props} />);
    await screen.findByText("A day in the hills");
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/social-analytics/content/123?credentialId=22&platform=instagram&refreshMetrics=1",
    );
    expect(screen.getByRole("link", { name: "Back to posts" })).toHaveAttribute(
      "href",
      expect.stringContaining("start=2026-09-01"),
    );
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Next media" }));
    expect(screen.getByRole("img", { name: /image 2 of 2/ })).toHaveAttribute(
      "src",
      "https://example.com/two.jpg",
    );
    fireEvent.error(screen.getByRole("img", { name: /image 2 of 2/ }));
    expect(
      await screen.findByText("This media link has expired or is unavailable."),
    ).toBeInTheDocument();
  });
  it("shows story performance without requesting public story comments", async () => {
    mocks.get.mockResolvedValue({
      item: { ...item, type: "story", children: [] },
      account: { name: "orocircle" },
    });
    render(<SocialPostDetail {...props} />);
    await screen.findByText("Story replies are private messages");
    expect(
      mocks.get.mock.calls.some(([url]) => url.includes("/comments")),
    ).toBe(false);
    expect(
      screen.getByRole("heading", { name: "Post performance" }),
    ).toBeInTheDocument();
  });
  it("loads all reply pages without duplicating sent replies and labels own-account replies", async () => {
    const own = {
      ...comment,
      id: "11",
      body: "Thank you for visiting!",
      author: "orocircle",
      isOwn: true,
      source: "sent",
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("/replies?")
        ? {
            replies: [own, { ...comment, id: "12", body: "We will be back" }],
            nextCursor: null,
          }
        : {
            comments: [
              {
                ...comment,
                replies: [own],
                moreReplies: true,
                repliesNextCursor: "page2",
              },
            ],
            nextCursor: null,
            limitation: "",
          },
    );
    render(<PostComments credentialId="22" item={item} />);
    await screen.findByText("Your account");
    fireEvent.click(screen.getByRole("button", { name: "Load more replies" }));
    await screen.findByText("We will be back");
    expect(screen.getAllByText("Thank you for visiting!")).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/social-analytics/content/123/comments/10/replies?credentialId=22&platform=instagram&after=page2",
    );
    expect(
      screen.queryByRole("button", { name: "Load more replies" }),
    ).not.toBeInTheDocument();
  });
  it("refreshes the conversation after a confirmed reply", async () => {
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("/replies?")
        ? {
            replies: [
              {
                ...comment,
                id: "100",
                body: "Thanks!",
                author: "orocircle",
                isOwn: true,
              },
            ],
            nextCursor: null,
          }
        : {
            comments: [comment],
            nextCursor: null,
            limitation: "",
            capabilities: { reply: true, moderate: false, reason: null },
          },
    );
    mocks.post.mockResolvedValue({ success: true, providerId: "100" });
    render(<PostComments credentialId="22" item={item} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Public reply from your connected account",
      }),
      { target: { value: "Thanks!" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish reply" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/social-analytics/content/123/comments/10/replies?credentialId=22&platform=instagram",
    );
    expect(await screen.findByText("Thanks!")).toBeInTheDocument();
  });
  it("keeps reply pagination usable when comments refresh during an older reply request", async () => {
    let finishReplies: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      finishReplies = resolve;
    });
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("/replies?")
        ? pending
        : {
            comments: [
              {
                ...comment,
                replies: [],
                moreReplies: true,
                repliesNextCursor: "page2",
              },
            ],
            nextCursor: null,
            limitation: "",
          },
    );
    render(<PostComments credentialId="22" item={item} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more replies" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Load more replies" }),
      ).toBeEnabled(),
    );
    finishReplies({ replies: [], nextCursor: null });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Load more replies" }),
      ).toBeEnabled(),
    );
  });
});
