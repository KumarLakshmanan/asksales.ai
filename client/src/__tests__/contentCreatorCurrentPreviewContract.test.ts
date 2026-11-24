import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const formats = ["image", "video", "email", "sms", "social", "dm", "ads", "blog"] as const;
const creators = { image: "Image", video: "Video", email: "Email", sms: "Sms", social: "Social", dm: "Dm", ads: "Ad", blog: "Blog" } as const;

const pages = Object.fromEntries(formats.map((format) => [
  format,
  readFileSync(resolve(process.cwd(), `src/components/content-studio/creators/${creators[format]}Creator.tsx`), "utf8"),
])) as Record<(typeof formats)[number], string>;

describe("content creator current preview contract", () => {
  it.each(formats)("keeps persisted %s history out of the active preview", (format) => {
    const route = readFileSync(resolve(process.cwd(), `src/app/dashboard/(main)/saved-templates/${format}/generate/page.tsx`), "utf8");
    expect(route).toContain(`export { default } from "@/components/content-studio/creators/${creators[format]}Creator"`);
    const page = pages[format];
    expect(page).toMatch(/const \[current(?:Image|Video|Email|Message|Post|Ad), setCurrent/);
    expect(page).not.toMatch(/const active\w+ = .*\|\| (?:images|videos|emails|messages|posts|ads)\[0\]/);
  });

  it.each(["email", "sms", "social", "dm", "ads", "blog"] as const)("asks for a prompt on the %s creator", (format) => {
    const page = pages[format];
    expect(page).toMatch(/<Label[^>]*>[^<]*Prompt<\/Label>/);
    expect(page).toContain("Enter a prompt");
    expect(page).not.toContain("Enter a description and click Generate");
  });
});
