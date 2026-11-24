import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { name: "Owner" }, logout: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ default: { postForm: vi.fn() }, buildApiUrl: (url: string) => url }));
import { BrandReview } from "@/components/setup/BrandReview";
import { BrandContentPreview, brandColorContrast, brandSample } from "@/components/setup/BrandContentPreview";
import { BrandImagesStep, optimizeBrandUpload, uniqueBrandImages } from "@/components/setup/BrandImagesStep";
import { BrandIdentityStep, BrandVoiceStep } from "@/components/setup/BrandToolkitSteps";
import { EMPTY_GUIDANCE, readBrandData, type BrandData } from "@/components/setup/brandToolkitData";
const data: BrandData = {
  ...EMPTY_GUIDANCE,
  brandName: "Northstar", tagline: "Clear ideas, shared.", voiceTraits: ["Friendly"], brandValues: [], otherValue: "",
  primaryColor: "#223344", secondaryColor: "", accentColor: "", colorPalette: [], fonts: { heading: "", body: "", accent: "" },
  fontFamilies: [], gradients: [], logoUrl: "", missionStatement: "", brandKeywords: "", voiceKeywords: [],
  contentPillars: ["Design"], contentFormats: [], defaultHashtags: ["#design"], defaultCtas: ["Explore the guide"],
  imageAssets: [], websiteScreenshotUrl: "",
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Brand toolkit enhancements", () => {
  it("groups review, collapses empty optional fields, and edits the selected section", async () => {
    const onEdit = vi.fn();
    render(<BrandReview data={data} business={{ Website: "https://northstar.example", Email: "" }} onEdit={onEdit} />);
    expect(screen.getByRole("region", { name: "Identity review" })).toHaveTextContent("Northstar");
    expect(screen.queryByText("Not added")).not.toBeInTheDocument();
    expect(screen.getAllByText(/optional fields? not added/)[0].closest("details")).not.toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "Edit voice" }));
    expect(onEdit).toHaveBeenCalledWith(2);
  });
  it("changes format using the selected voice and content preferences", async () => {
    render(<BrandContentPreview data={data} />);
    expect(screen.getByText(/Looking for a little help with Design/)).toBeInTheDocument();
    expect(screen.getByText("Explore the guide")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Email" }));
    expect(screen.getByRole("heading", { name: "A note from Northstar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email" })).toHaveAttribute("aria-pressed", "true");
    expect(brandSample({ ...data, tagline: "", voiceTraits: ["Bold"] }, "Headline").headline).toBe("Move forward with Northstar.");
  });
  it("checks text contrast and chooses readable preview text", () => {
    expect(brandColorContrast("#000000", "#ffffff")).toBe(21);
    expect(brandColorContrast("#nope", "#ffffff")).toBeNull();
    render(<BrandContentPreview data={{ ...data, primaryColor: "#ffffff" }} />);
    expect(screen.getByText(/White text on this primary color has 1.0:1 contrast/)).toBeInTheDocument();
    expect(screen.getByText("Explore the guide")).toHaveStyle({ color: "#000000" });
  });
  it("shows existing advanced guidance and tailors creator identity labels", () => {
    const view = render(<BrandVoiceStep data={data} update={vi.fn()} workspaceType="creator" />);
    expect(screen.getByText("Detailed voice guidance").closest("details")).not.toHaveAttribute("open");
    view.rerender(<BrandVoiceStep data={{ ...data, customToneGuidelines: "Use plain language" }} update={vi.fn()} workspaceType="creator" />);
    expect(screen.getByText("Detailed voice guidance").closest("details")).toHaveAttribute("open");
    expect(screen.getByDisplayValue("Use plain language")).toBeInTheDocument();
    view.rerender(<BrandIdentityStep data={data} update={vi.fn()} workspaceType="creator" />);
    expect(screen.getByLabelText(/Creator or brand name/)).toBeInTheDocument();
  });
  it("changes selected image metadata and order while preserving sources", async () => {
    const first = { url: "/uploads/one.webp", originalUrl: "https://example.com/one.png", alt: "A team", width: 1000, height: 600 };
    const second = { url: "/uploads/two.webp", source: "upload" as const };
    const onChange = vi.fn();
    render(<BrandImagesStep profileId={12} available={[first, second, first]} selected={[first, second]} onChange={onChange} onAdd={vi.fn()} screenshot="" keepScreenshot={false} onScreenshot={vi.fn()} onUploading={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /Keep brand image/ })).toHaveLength(2);
    expect(screen.getByText("Website · 1000 × 600")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move image 2 earlier" }));
    expect(onChange).toHaveBeenLastCalledWith([second, first]);
    await userEvent.clear(screen.getByLabelText("Alt text for image 1"));
    expect(onChange).toHaveBeenLastCalledWith([{ ...first, alt: "" }, second]);
    expect(screen.getByRole("link", { name: "View source image" })).toHaveAttribute("href", first.originalUrl);
  });
  it("preserves uploads without compression support and deduplicates URLs", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const file = new File(["pixels"], "example.png", { type: "image/png" });
    expect(await optimizeBrandUpload(file)).toEqual({ file });
    expect(uniqueBrandImages([{ url: "/one.png" }, { url: "/one.png", alt: "Updated" }])).toEqual([{ url: "/one.png", alt: "Updated" }]);
  });
  it("retains saved image metadata and legacy advanced guidance", () => {
    const asset = { url: "/uploads/one.webp", alt: "A team", width: 1000, height: 600, source: "upload" };
    const restored = readBrandData({ name: "Saved brand", imageAssets: [asset], voiceDos: ["Use plain language"], audienceGoals: ["Reach customers"] }, data);
    expect(restored.brandName).toBe("Saved brand");
    expect(restored.imageAssets).toEqual([asset]);
    expect(restored.voiceDos).toEqual(["Use plain language"]);
    expect(restored.audienceGoals).toEqual(["Reach customers"]);
  });
});
