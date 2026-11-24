import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
import { SocialListeningPanel } from "@/components/social-insights/SocialListeningPanel";
const props = {
  platform: "instagram",
  credentialId: "22",
  startDate: "2026-08-20",
  endDate: "2026-09-18",
  revision: 0,
};
const comment = {
  id: "comment-1",
  kind: "comments",
  body: "Does this room have a sea view?",
  author_handle: "traveller",
  sentiment: "unknown",
  source: "official_api",
  occurred_at: "2026-09-01T12:00:00Z",
  post: {
    id: "owned-post",
    caption: "A weekend beside the sea",
    type: "reel",
    permalink: "https://instagram.com/p/owned",
  },
};
const tagged = {
  id: "tag-1",
  kind: "tags",
  body: "Our stay at the resort",
  sentiment: "unknown",
  source: "official_api",
  occurred_at: "2026-09-01T12:00:00Z",
  public_url: "https://instagram.com/p/tagged",
  post: null,
};
const response = (items: unknown[]) => ({
  items,
  total: items.length,
  nextOffset: null,
  summary: { unknown: items.length },
  sourceSummary: { comments: 1, tags: 14, manual: 0 },
});
const paramsOf = (url: string) =>
  new URL(url, "https://asksales.ai").searchParams;
describe("social conversation inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (url: string) =>
      response(paramsOf(url).get("kind") === "tags" ? [tagged] : [comment]),
    );
    mocks.post.mockResolvedValue({});
    mocks.patch.mockResolvedValue({});
    mocks.delete.mockResolvedValue({});
  });
  it("opens comments by default and keeps tagged posts in their own source", async () => {
    render(<SocialListeningPanel {...props} />);
    await screen.findByText(comment.body);
    expect(paramsOf(mocks.get.mock.calls[0][0]).get("kind")).toBe("comments");
    expect(screen.queryByText(tagged.body)).not.toBeInTheDocument();
    const sources = screen.getByRole("group", { name: "Listening sources" });
    expect(
      within(sources).getByRole("button", { name: "Comments 1" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(sources).getByRole("button", { name: "Tagged posts 14" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sentiment for comment-1")).toHaveDisplayValue(
      "Not reviewed",
    );
    fireEvent.click(
      within(sources).getByRole("button", { name: "Tagged posts 14" }),
    );
    await screen.findByText(tagged.body);
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open tagged post" }),
    ).toHaveAttribute("href", tagged.public_url);
    expect(
      screen.queryByRole("link", { name: "Open post & conversation" }),
    ).not.toBeInTheDocument();
  });
  it("links owned comments to the post detail with the selected account and date context", async () => {
    render(<SocialListeningPanel {...props} />);
    const link = await screen.findByRole("link", {
      name: "Open post & conversation",
    });
    const target = new URL(link.getAttribute("href")!, "https://asksales.ai");
    expect(target.pathname).toBe(
      "/dashboard/marketing/analytics/posts/owned-post",
    );
    expect(Object.fromEntries(target.searchParams)).toEqual({
      platform: "instagram",
      account: "22",
      start: props.startDate,
      end: props.endDate,
    });
    expect(screen.getByText(comment.post.caption)).toBeInTheDocument();
  });
  it("loads a post's full saved history without date filters or date validation", async () => {
    render(
      <SocialListeningPanel
        {...props}
        postId="owned-post"
        startDate=""
        endDate=""
      />,
    );
    await screen.findByText(comment.body);
    const query = paramsOf(mocks.get.mock.calls[0][0]);
    expect(query.get("postId")).toBe("owned-post");
    expect(query.has("start")).toBe(false);
    expect(query.has("end")).toBe(false);
    expect(
      screen.queryByRole("button", { name: /Tagged posts/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open post & conversation" }),
    ).not.toBeInTheDocument();
  });
  it("persists review status and requests the chosen status filter", async () => {
    render(<SocialListeningPanel {...props} />);
    await screen.findByText(comment.body);
    fireEvent.change(screen.getByLabelText("Review status for comment-1"), {
      target: { value: "follow_up" },
    });
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        "/api/social-analytics/listening/comment-1",
        { status: "follow_up" },
      ),
    );
    fireEvent.change(screen.getByLabelText("Listening review status"), {
      target: { value: "follow_up" },
    });
    await waitFor(() =>
      expect(
        mocks.get.mock.calls.some(
          ([url]) => paramsOf(url).get("status") === "follow_up",
        ),
      ).toBe(true),
    );
  });
  it("explains an empty comments view without counting tags as comments", async () => {
    mocks.get.mockResolvedValue({
      ...response([]),
      sourceSummary: { comments: 0, tags: 14, manual: 0 },
    });
    render(
      <SocialListeningPanel
        {...props}
        coverage={["Checked all 100 captured posts."]}
      />,
    );
    await screen.findByText("No comments captured here yet");
    expect(
      screen.getByRole("button", { name: "Comments 0" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Tagged posts 14" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What this inbox includes").closest("details"),
    ).not.toHaveAttribute("open");
  });
  it("keeps the selected source after a review finishes in the background", async () => {
    let finishPatch: (value: unknown) => void = () => {};
    mocks.patch.mockReturnValue(
      new Promise((resolve) => {
        finishPatch = resolve;
      }),
    );
    render(<SocialListeningPanel {...props} />);
    await screen.findByText(comment.body);
    fireEvent.change(screen.getByLabelText("Sentiment for comment-1"), {
      target: { value: "positive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tagged posts 14" }));
    await screen.findByText(tagged.body);
    finishPatch({});
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(paramsOf(mocks.get.mock.calls.at(-1)![0]).get("kind")).toBe("tags");
    expect(screen.getByText(tagged.body)).toBeInTheDocument();
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
  });
  it("preserves older pages during passive polling and resumes after explicit refresh", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let poll: () => void = () => {};
    const interval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((handler, timeout) => {
        if (timeout === 60000) poll = handler as () => void;
        return 42 as unknown as ReturnType<typeof setInterval>;
      });
    mocks.get.mockImplementation(async (url: string) =>
      paramsOf(url).get("offset") === "50"
        ? {
            ...response([
              { ...comment, id: "older", body: "An older comment" },
            ]),
            total: 51,
          }
        : { ...response([comment]), total: 51, nextOffset: 50 },
    );
    try {
      render(<SocialListeningPanel {...props} />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Load more evidence" }),
      );
      await screen.findByText("An older comment");
      await act(async () => {
        poll();
      });
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(screen.getByText("An older comment")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh" }),
      );
      await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
      // Let the explicit refresh settle; a tick while it runs is skipped so it
      // is not superseded.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        poll();
      });
      expect(mocks.get).toHaveBeenCalledTimes(4);
    } finally {
      interval.mockRestore();
      visibility.mockRestore();
    }
  });
});
