import { WORKSPACE_TYPE_VALUES as WORKSPACE_TYPES, APPLICATION_USE_VALUES as APPLICATION_USES } from "../../shared/workspaceOnboarding.js";

/** Validate only supplied fields so older clients and analyzer drafts remain compatible. */
export function workspaceOnboardingFields(body: Record<string, unknown>) {
  const fields: {
    workspaceType?: string | null;
    timezone?: string | null;
    applicationUses?: string[];
    setupGoal?: string;
    currentTools?: string;
  } = {};
  if (body.workspaceType !== undefined) {
    if (
      body.workspaceType !== null &&
      !WORKSPACE_TYPES.some(value => value === body.workspaceType)
    )
      throw new Error("Choose a valid workspace type.");
    fields.workspaceType = body.workspaceType as string | null;
  }
  if (body.timezone !== undefined) {
    if (
      body.timezone !== null &&
      (typeof body.timezone !== "string" || body.timezone.length > 100)
    )
      throw new Error("Choose a valid time zone.");
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: String(body.timezone) });
      } catch {
        throw new Error("Choose a valid time zone.");
      }
    }
    fields.timezone = (body.timezone as string | null) || null;
  }
  if (body.applicationUses !== undefined) {
    if (
      !Array.isArray(body.applicationUses) ||
      body.applicationUses.some(
        (value) =>
          typeof value !== "string" || !APPLICATION_USES.some(option => option === value),
      )
    )
      throw new Error("Choose valid application uses.");
    fields.applicationUses = [...new Set(body.applicationUses as string[])];
  }
  for (const key of ["setupGoal", "currentTools"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string" || (body[key] as string).length > 1000)
      throw new Error(
        `${key === "setupGoal" ? "First goal" : "Current tools"} must be at most 1,000 characters.`,
      );
    fields[key] = (body[key] as string).trim();
  }
  return fields;
}

export function brandImageFields(body: Record<string, unknown>) {
  const validUrl = (url: unknown) => {
    if (typeof url !== "string" || url.length > 4096) return false;
    if (/^\/uploads\/[\w/.-]+$/.test(url)) return true;
    try {
      const parsed = new URL(url);
      return (
        ["https:", "http:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  };
  const fields: {
    imageAssets?: Array<{ url: string; originalUrl?: string;alt?:string;width?:number;height?:number;thumbnailUrl?:string;source?:"website"|"upload";originalName?:string;sizeBytes?:number }>;
    websiteScreenshotUrl?: string | null;
  } = {};
  if (body.imageAssets !== undefined) {
    if (!Array.isArray(body.imageAssets) || body.imageAssets.length > 100)
      throw new Error("Choose up to 100 valid brand images.");
    fields.imageAssets = body.imageAssets.map((asset) => {
      if (
        !asset ||
        typeof asset !== "object" ||
        !validUrl(asset.url) ||
        (asset.originalUrl && !validUrl(asset.originalUrl))
      )
        throw new Error("Choose valid brand image URLs.");
      if (asset.thumbnailUrl !== undefined && !validUrl(asset.thumbnailUrl)) throw new Error("Choose a valid brand image thumbnail URL.");
      if (asset.alt !== undefined && (typeof asset.alt !== 'string' || asset.alt.length > 1000)) throw new Error("Image descriptions must be at most 1,000 characters.");
      if (asset.originalName !== undefined && (typeof asset.originalName !== 'string' || asset.originalName.length > 255)) throw new Error("Invalid image file name.");
      if (asset.source !== undefined && !['website','upload'].includes(asset.source)) throw new Error("Invalid image source.");
      for (const key of ['width','height','sizeBytes']) if (asset[key] !== undefined && (!Number.isSafeInteger(asset[key]) || asset[key] < (key === 'sizeBytes' ? 0 : 1) || asset[key] > (key === 'sizeBytes' ? 100000000 : 100000))) throw new Error("Invalid image dimensions or size.");
      return {
        url: asset.url,
        ...Object.fromEntries(['alt','width','height','thumbnailUrl','source','originalName','sizeBytes'].filter(key => asset[key] !== undefined).map(key => [key,asset[key]])),
        ...(asset.originalUrl ? { originalUrl: asset.originalUrl } : {}),
      };
    });
  }
  if (body.websiteScreenshotUrl !== undefined) {
    if (body.websiteScreenshotUrl && !validUrl(body.websiteScreenshotUrl))
      throw new Error("Choose a valid website screenshot URL.");
    fields.websiteScreenshotUrl = (body.websiteScreenshotUrl as string) || null;
  }
  return fields;
}
