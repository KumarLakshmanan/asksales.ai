import { describe, expect, it } from "vitest";
import { buildContentMedia, uniqueMediaUrls } from "@/lib/contentMedia";

describe("content media normalization", () => {
  it("keeps carousel array order and removes the repeated singular URL", () => {
    expect(buildContentMedia({
      imageUrl: "/uploads/slide-3.jpg",
      imageUrls: [
        "/uploads/slide-1.jpg",
        "/uploads/slide-2.jpg",
        "/uploads/slide-3.jpg",
      ],
    }).imageUrls).toEqual([
      "/uploads/slide-1.jpg",
      "/uploads/slide-2.jpg",
      "/uploads/slide-3.jpg",
    ]);
  });

  it("falls back to singular legacy media and ignores blank values", () => {
    expect(uniqueMediaUrls([], "  /uploads/legacy.jpg  ", "", null)).toEqual([
      "/uploads/legacy.jpg",
    ]);
  });

  it("retains image and video items exactly once", () => {
    expect(buildContentMedia({
      imageUrl: "/uploads/image.jpg",
      imageUrls: ["/uploads/image.jpg"],
      videoUrl: "/uploads/video.mp4",
      videoUrls: ["/uploads/video.mp4"],
    }).items).toEqual([
      { type: "image", url: "/uploads/image.jpg" },
      { type: "video", url: "/uploads/video.mp4" },
    ]);
  });
});
