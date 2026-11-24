import { readStringList, type BrandImageAsset } from "@/lib/workspace-profile";

export const EMPTY_GUIDANCE = {
  voiceType: "",
  customToneGuidelines: "",
  imageStyleReference: "",
  visualInstructions: "",
  logoUsageGuidelines: "",
  contentInstructions: "",
  voiceDos: [] as string[],
  voiceDonts: [] as string[],
  audiencePainPoints: [] as string[],
  audienceGoals: [] as string[],
  audienceLanguageStyle: [] as string[],
  audienceTriggers: [] as string[],
};
export type BrandGuidance = typeof EMPTY_GUIDANCE;
export function readGuidance(source: Partial<BrandGuidance>): BrandGuidance {
  return Object.fromEntries(
    Object.entries(EMPTY_GUIDANCE).map(([key, fallback]) => {
      const value = source[key as keyof BrandGuidance];
      return [
        key,
        Array.isArray(fallback)
          ? Array.isArray(value)
            ? value.filter((v) => typeof v === "string")
            : []
          : typeof value === "string"
            ? value
            : "",
      ];
    }),
  ) as BrandGuidance;
}

// ─── State type ───────────────────────────────────────────────────────────────
export interface BrandData extends BrandGuidance {
  setupRequestKey?: string;
  brandName: string;
  tagline: string;
  voiceTraits: string[];
  brandValues: string[];
  otherValue: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  colorPalette: string[];
  fonts: { heading: string; body: string; accent: string };
  fontFamilies: string[];
  gradients: string[];
  logoUrl: string;
  missionStatement: string;
  brandKeywords: string;
  voiceKeywords: string[];
  contentPillars: string[];
  contentFormats: string[];
  defaultHashtags: string[];
  defaultCtas: string[];
  imageAssets: BrandImageAsset[];
  websiteScreenshotUrl: string;
}

export interface SavedBrandToolkit
  extends Partial<BrandGuidance>,
    Record<string, unknown> {
  additionalColors?: string[];
  id: number;
  isDefault?: boolean;
  brandName?: string;
  name?: string;
  tagline?: string;
  voicePersonalityTraits?: string[];
  brandValues?: string[];
  primaryColors?: string[];
  secondaryColors?: string[];
  primaryBrandColor?: string;
  accentColor?: string;
  fonts?: Partial<BrandData["fonts"]>;
  logoUrl?: string;
  missionStatement?: string;
  brandKeywords?: string[];
  voiceKeywords?: string[];
  contentPillars?: string[];
  contentFormats?: string[];
  defaultHashtags?: string[];
  defaultCtas?: string[];
}

export function readImages(value: unknown): BrandImageAsset[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is BrandImageAsset =>
          !!item && typeof item === "object" && typeof item.url === "string",
      )
    : [];
}
export function readBrandData(
  source: Record<string, unknown>,
  previous: BrandData,
): BrandData {
  const text = (key: string, fallback = "") =>
    typeof source[key] === "string" ? (source[key] as string) : fallback;
  const palette = readStringList(source.primaryColors);
  const secondary = readStringList(source.secondaryColors);
  const fonts =
    source.fonts &&
    typeof source.fonts === "object" &&
    !Array.isArray(source.fonts)
      ? (source.fonts as Record<string, string>)
      : {};
  const families = readStringList(source.fontFamilies);
  return {
    ...previous,
    ...readGuidance(source),
    brandName: text("brandName", text("name", previous.brandName)),
    tagline: text("tagline"),
    missionStatement: text("missionStatement"),
    voiceTraits: readStringList(source.voicePersonalityTraits),
    brandValues: readStringList(source.brandValues),
    primaryColor: text(
      "primaryColor",
      palette[0] || text("primaryBrandColor", previous.primaryColor),
    ),
    secondaryColor: text(
      "secondaryColor",
      secondary[0] || text("secondaryBrandColor"),
    ),
    accentColor: text("accentColor"),
    colorPalette: readStringList(
      source.additionalColors ?? source.colorPalette,
    ),
    fonts: {
      heading: fonts.heading || families[0] || "",
      body: fonts.body || text("fontFamily") || families[0] || "",
      accent: fonts.accent || "",
    },
    fontFamilies: families,
    gradients: readStringList(source.gradients),
    logoUrl: text("logoUrl"),
    brandKeywords:
      typeof source.brandKeywords === "string"
        ? source.brandKeywords
        : readStringList(source.brandKeywords).join(", "),
    voiceKeywords: readStringList(source.voiceKeywords),
    contentPillars: readStringList(source.contentPillars),
    contentFormats: readStringList(source.contentFormats),
    defaultHashtags: readStringList(source.defaultHashtags),
    defaultCtas: readStringList(source.defaultCtas),
    imageAssets: readImages(source.imageAssets),
    websiteScreenshotUrl: text("websiteScreenshotUrl"),
  };
}
