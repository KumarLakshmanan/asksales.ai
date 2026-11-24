import { describe, expect, it } from "@jest/globals";
import {
  workspaceOnboardingFields,
  brandImageFields,
} from "../utils/workspaceOnboarding.js";
import {
  businessProfileSchema,
  brandToolkitSchema,
} from "../middleware/schemas.js";

describe("universal workspace onboarding validation", () => {
  it("accepts personal and creator workspaces, optional team size, uses and channels", () => {
    const body = {
      name: "My projects",
      workspaceType: "individual",
      timezone: "Asia/Kolkata",
      applicationUses: ["customer_support", "personal_productivity"],
      preferredChannels: ["Email", "Instagram"],
      setupGoal: " Organize my work ",
      currentTools: "Gmail",
    };
    expect(businessProfileSchema.parse(body)).toMatchObject({
      workspaceType: "individual",
      applicationUses: body.applicationUses,
    });
    expect(workspaceOnboardingFields(body)).toMatchObject({
      setupGoal: "Organize my work",
      timezone: "Asia/Kolkata",
    });
    expect(workspaceOnboardingFields({ workspaceType: "creator" })).toEqual({
      workspaceType: "creator",
    });
  });
  it("leaves omitted fields untouched and accepts analyzer drafts without an onboarding survey", () => {
    expect(
      workspaceOnboardingFields({
        name: "example.com",
        website: "https://example.com",
      }),
    ).toEqual({});
    expect(
      workspaceOnboardingFields({ applicationUses: [], currentTools: "" }),
    ).toEqual({ applicationUses: [], currentTools: "" });
    expect(
      businessProfileSchema.parse({
        name: "example.com",
        website: "https://example.com",
      }),
    ).toMatchObject({ name: "example.com" });
  });
  it("rejects invalid types, use cases, time zones, and long goals", () => {
    for (const body of [
      { workspaceType: "unknown" },
      { timezone: "Mars/Olympus" },
      { applicationUses: ["random"] },
      { applicationUses: "email" },
      { setupGoal: "x".repeat(1001) },
    ])
      expect(() => workspaceOnboardingFields(body)).toThrow();
  });
});

describe("brand images and website references", () => {
  it("keeps image origins, screenshot, font families and gradients in validated toolkit payloads", () => {
    const body = {
      name: "Creator toolkit",
      imageAssets: [
        {
          url: "/uploads/26/image.png",
          originalUrl: "https://example.com/image.png",
        },
      ],
      websiteScreenshotUrl: "/uploads/26/screenshot.png",
      fontFamilies: ["Inter"],
      gradients: ["linear-gradient(#123456, #abcdef)"],
    };
    expect(brandToolkitSchema.parse(body)).toMatchObject(body);
    expect(brandImageFields(body)).toMatchObject({
      imageAssets: body.imageAssets,
      websiteScreenshotUrl: body.websiteScreenshotUrl,
    });
    expect(brandImageFields({})).toEqual({});
    expect(
      brandImageFields({ imageAssets: [], websiteScreenshotUrl: "" }),
    ).toEqual({ imageAssets: [], websiteScreenshotUrl: null });
  });
  it("rejects malformed images and executable URLs before saving", () => {
    for (const body of [
      { imageAssets: ["https://example.com/image.png"] },
      { imageAssets: [{ url: "javascript:alert(1)" }] },
      { websiteScreenshotUrl: "//other.example/image.png" },
      { imageAssets: Array(101).fill({ url: "/uploads/image.png" }) },
    ])
      expect(() => brandImageFields(body)).toThrow();
  });
});
