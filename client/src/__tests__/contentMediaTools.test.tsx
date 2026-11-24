import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { centeredCrop, clearWhiteBorder, ImageProofTools } from "@/components/content-studio/ImageProofTools";
import { validateSourceImage, downloadContentMedia } from "@/lib/contentMediaTools";
import api from "@/lib/api";
import { appendDraftMedia } from "@/components/content-studio/AttachMediaToDraft";
import { isWebVtt } from "@/components/content-studio/VideoCaptionTools";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), put: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("media input and download", () => {
  it("appends attachments without replacing originals or duplicating the new URL", () => {
    const draft = { id: 1, title: "Draft", type: "social_post", status: "draft", content: JSON.stringify({ caption: "Keep exact copy", imageUrls: ["/uploads/a.png"] }), imageUrl: "/uploads/a.png", imageUrls: ["/uploads/a.png"] };
    const result = appendDraftMedia(draft, "image", "/uploads/b.png");
    expect(result.imageUrl).toBe("/uploads/a.png");
    expect(result.imageUrls).toEqual(["/uploads/a.png", "/uploads/b.png"]);
    expect(JSON.parse(result.content!)).toMatchObject({ caption: "Keep exact copy" });
    expect(appendDraftMedia({ ...draft, ...result }, "image", "/uploads/b.png").imageUrls).toHaveLength(2);
  });
  it("accepts timed WebVTT, not untimed caption text", () => {
    expect(isWebVtt("WEBVTT\n\n00:00.000 --> 00:04.000\nReviewed words")).toBe(true);
    expect(isWebVtt("Reviewed words")).toBe(false);
  });
  it("rejects empty, unsupported and oversized references before FileReader", () => {
    expect(validateSourceImage({ type: "image/png", size: 0 })).toMatch(/empty/);
    expect(validateSourceImage({ type: "image/svg+xml", size: 10 })).toMatch(/JPEG/);
    expect(validateSourceImage({ type: "image/png", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(validateSourceImage({ type: "image/webp", size: 10 })).toBeNull();
  });
  it("rejects error pages instead of downloading an HTML document as media", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["login"], { type: "text/html" }) }));
    await expect(downloadContentMedia("/uploads/image.png", "Image", "png")).rejects.toThrow("unavailable");
    vi.unstubAllGlobals();
  });
});

describe("non-destructive image proof", () => {
  it("center-crops landscape and portrait images without exceeding bounds", () => {
    expect(centeredCrop(1600, 900, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(centeredCrop(900, 1600, 1)).toEqual({ x: 0, y: 350, width: 900, height: 900 });
    expect(centeredCrop(900, 1600, null)).toEqual({ x: 0, y: 0, width: 900, height: 1600 });
  });
  it("removes only the connected white edge, preserving enclosed white detail", () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4).fill(255);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) {
      if (x === 2 && y === 2) continue;
      const offset = (y * 5 + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
    clearWhiteBorder(pixels, 5, 5);
    expect(pixels[3]).toBe(0);
    expect(pixels[(2 * 5 + 2) * 4 + 3]).toBe(255);
    expect(pixels[(1 * 5 + 1) * 4 + 3]).toBe(255);
  });
  it("loads and saves alt text without replacing existing metadata", async () => {
    vi.mocked(api.get).mockResolvedValue({ metadata: { altText: "Existing", source: "generated" }, version: 1 });
    vi.mocked(api.put).mockResolvedValue({ id: 10 });
    render(<ImageProofTools image={{ id: "db-10", title: "Product", imageUrl: "/uploads/a.png" }} alternatives={[]} />);
    await waitFor(() => expect(screen.getByLabelText("Alt text")).toHaveValue("Existing"));
    fireEvent.change(screen.getByLabelText("Alt text"), { target: { value: "Blue product on white" } });
    fireEvent.click(screen.getByRole("button", { name: "Save alt text" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/content/assets/10", { metadata: { altText: "Blue product on white", source: "generated" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Alt text saved");
  });
});
