import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SocialPostCard from "@/components/content-cards/SocialPostCard";
import { CreatorPreview, cssAspectRatio } from "@/components/content-studio/CreatorPreview";
import { companionMediaState } from "@/components/content-studio/creators/SocialCreator";
import { ToolExecutionCard } from "@/components/chat/ToolExecutionCard";
import type { Message } from "@/models/message";
import { checkVideoSourceImageSize, videoGenerationProgressLabel } from "@/lib/videoSourceImage";

const post = { id: "db-1", title: "Launch", content: "Caption", platform: "instagram", createdAt: Date.now() };

describe("video generation progress", () => {
  it("shows an in-progress row with an estimate while the companion video is generating", () => {
    render(
      <SocialPostCard
        title="Launch"
        content={JSON.stringify({ caption: "Caption", hashtags: ["todle"], videoPrompt: "Teacher using a tablet" })}
        isGeneratingVideo
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Generating video… usually 1–3 minutes/);
  });

  it("shows a failure instead of a spinner when the companion video failed", () => {
    render(
      <SocialPostCard
        title="Launch"
        content={JSON.stringify({ caption: "Caption", videoPrompt: "Teacher using a tablet" })}
        mediaFailed={{ video: true }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Video generation failed");
    expect(screen.queryByText(/Generating video/)).not.toBeInTheDocument();
  });

  it("derives generating, failed and finished companion states", () => {
    expect(companionMediaState({ ...post, videoPrompt: "x" }, "video")).toBe("generating");
    expect(companionMediaState({ ...post, videoPrompt: "x", videoError: true }, "video")).toBe("failed");
    expect(companionMediaState({ ...post, videoPrompt: "x", videoUrl: "/v.mp4" }, "video")).toBeUndefined();
    // A saved prompt that was never queued must not spin forever.
    expect(companionMediaState({ ...post, videoPrompt: "x", videoPending: false }, "video")).toBeUndefined();
  });

  it("shows the pending video in the social preview after the caption is ready", () => {
    render(<CreatorPreview model={{ format: "social", status: "ready", caption: "Caption", hashtags: ["todle"], pendingMedia: [{ kind: "video", status: "generating", startedAt: new Date().toISOString() }] }} />);
    expect(screen.getByRole("status", { name: "Generating video" })).toHaveTextContent(/usually 1–3 minutes/);
  });

  it("explains a failed companion video in the social preview", () => {
    render(<CreatorPreview model={{ format: "social", status: "ready", caption: "Caption", pendingMedia: [{ kind: "video", status: "failed", error: "Quota exceeded" }] }} />);
    expect(screen.getByText(/Video generation failed: Quota exceeded/)).toBeVisible();
  });

  it("reports elapsed time and flags unusually long runs", () => {
    const start = Date.parse("2026-11-16T10:00:00Z");
    expect(videoGenerationProgressLabel(start, start + 75_000)).toMatch(/1 min 15s elapsed/);
    expect(videoGenerationProgressLabel(start, start + 400_000)).toMatch(/longer than usual/);
  });
});

describe("video preview fit", () => {
  it("renders the whole video (contain) at its own aspect ratio", () => {
    const { container } = render(<CreatorPreview model={{ format: "video", status: "ready", prompt: "x", videoUrl: "/uploads/v.mp4", aspectRatio: "9:16" }} />);
    const video = container.querySelector("video")!;
    expect(video.className).toContain("object-contain");
    expect(video.className).not.toContain("object-cover");
    expect(video.style.aspectRatio).toBe("9 / 16");
    expect(cssAspectRatio("bad")).toBe("16 / 9");
  });

  it("does not crop videos on social result cards", () => {
    const { container } = render(<SocialPostCard title="Launch" content={JSON.stringify({ caption: "Caption" })} videoUrl="/uploads/v.mp4" />);
    const video = container.querySelector("video")!;
    expect(video.className).toContain("object-contain");
  });
});

describe("reference image size check", () => {
  it("accepts the 146×50 logo with a notice that it will be enlarged", () => {
    expect(checkVideoSourceImageSize({ width: 146, height: 50 })).toEqual({ notice: expect.stringMatching(/146×50 px.*enlarged and padded to 720 px/) });
  });
  it("rejects images too small to use", () => {
    expect(checkVideoSourceImageSize({ width: 10, height: 8 }).error).toMatch(/only 10×8 px/);
  });
  it("says nothing for normal images", () => {
    expect(checkVideoSourceImageSize({ width: 1920, height: 1080 })).toEqual({});
  });
});

describe("chat video tool progress", () => {
  const message = (metadata: Record<string, unknown>) => ({
    id: 1, threadId: 1, userId: 1, role: "assistant", content: "", agentType: "orchestrator",
    metadata: { isToolResult: true, toolName: "generate_video", ...metadata }, createdAt: new Date().toISOString(),
  }) as unknown as Message;

  it("shows a saved, still-processing video as generating, not completed", () => {
    render(<ToolExecutionCard message={message({ success: true, toolOutput: { assetId: 5, status: "pending", videoStatus: "pending" } })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/still generating \(usually 1–3 minutes\)/);
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
  });

  it("shows a visible failure message for a failed video", () => {
    render(<ToolExecutionCard message={message({ success: false, error: "The reference image does not meet this video model’s size requirements." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Video generation failed/);
  });

  it("does not add video messages to other tools", () => {
    render(<ToolExecutionCard message={message({ toolName: "generate_image", success: true, toolOutput: { status: "pending" } })} />);
    expect(screen.queryByText(/still generating/)).not.toBeInTheDocument();
  });
});
