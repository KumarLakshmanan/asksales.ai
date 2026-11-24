import type { Browser, Page } from "playwright-core";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { logger } from "../../../utils/logger.js";
import type { CreativeReference } from "../../../../shared/adCreativeIntelligence.js";
import { fetchWithScrapling, metaAdLibraryFetcher } from "./MetaAdLibraryFetcher.js";

export interface PublicLibraryAd {
  id: string;
  pageName: string;
  body: string;
  url: string;
  startDate: string | null;
  format: "image" | "video" | "carousel" | "unknown";
  engagement: { likes: number | null; comments: number | null; shares: number | null };
}

export interface PublicAdDetails {
  status: "succeeded" | "unavailable" | "provider_error";
  reach: number | null;
  reachLocation: string | null;
  reachBreakdown: Array<{ location: string; ageRange: string; gender: string; reach: number }>;
  regionalReach?: Array<{ location: string; reach: number }>;
  engagement: { likes: null; comments: null; shares: null };
  message: string;
}

const MAX_ADS = 60;
const LIBRARY_URL = "https://business.facebook.com/ads/library/";

export function publicLibraryUrl(query: string): string {
  const url = new URL(LIBRARY_URL);
  url.search = new URLSearchParams({
    active_status: "active", ad_type: "all", country: "IN",
    is_targeted_country: "false", media_type: "all",
    q: query, search_type: "keyword_unordered",
  }).toString();
  return url.toString();
}

/** Parse only visible ad cards. An unrecognized layout must not become an empty result. */
export function parsePublicLibraryText(text: string): PublicLibraryAd[] {
  const chunks = text.split(/(?=\bLibrary ID:\s*\d{6,40}\b)/i).filter((chunk) => /^Library ID:/i.test(chunk.trimStart())).slice(0, MAX_ADS);
  const ads: PublicLibraryAd[] = [];
  for (const chunk of chunks) {
    const id = /\bLibrary ID:\s*(\d{6,40})\b/i.exec(chunk)?.[1];
    const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
    const sponsored = lines.findIndex((line) => line.toLowerCase() === "sponsored");
    const pageName = sponsored > 0 ? lines[sponsored - 1] : "";
    if (!id || !pageName || pageName.length > 200 || /^(image|video|active|inactive|platforms)$/i.test(pageName)) continue;
    const body = lines.slice(sponsored + 1).filter((line) => !/^(see ad details|open dropdown|see summary details)$/i.test(line)).join("\n").slice(0, 2500);
    const started = /Started running on\s+([^\n]+)/i.exec(chunk)?.[1]?.trim();
    const parsedStart = started ? Date.parse(`${started} 00:00:00 GMT`) : NaN;
    const format = /\bcarousel\b/i.test(chunk) ? "carousel" : /\bvideo\s*:/i.test(chunk) ? "video" : /\bimage\s*:/i.test(chunk) ? "image" : "unknown";
    ads.push({ id, pageName, body, url: `https://business.facebook.com/ads/library/?id=${id}`, startDate: Number.isFinite(parsedStart) ? new Date(parsedStart).toISOString() : null, format, engagement: { likes: null, comments: null, shares: null } });
  }
  const unique = new Map<string, PublicLibraryAd>();
  for (const ad of ads) if (!unique.has(ad.id)) unique.set(ad.id, ad);
  return [...unique.values()];
}

export function parseTransparencyByLocation(text: string): Pick<PublicAdDetails, "reach" | "reachLocation" | "reachBreakdown"> {
  const section = text.split("Transparency by location")[1]?.split("About the advertiser")[0] || "";
  const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
  const reachMatch = /\b(?:EU )?Ad delivery\s+Reach\s+([\d,]+)/i.exec(section);
  const reach = reachMatch ? Number(reachMatch[1].replaceAll(",", "")) : null;
  const reachLocation = /anywhere in the EU\b/i.test(section) ? "European Union" : /anywhere in the United Kingdom\b/i.test(section) ? "United Kingdom" : lines[0] || null;
  const breakdownStart = lines.findIndex((line, index) => line === "Location" && lines[index + 1] === "Age range" && lines[index + 2] === "Gender" && lines[index + 3] === "Reach");
  const reachBreakdown: PublicAdDetails["reachBreakdown"] = [];
  if (breakdownStart >= 0) for (let i = breakdownStart + 4; i + 3 < lines.length && reachBreakdown.length < 600; i += 4) {
    const value = lines[i + 3];
    if (!/^[\d,]+$/.test(value)) break;
    reachBreakdown.push({ location: lines[i], ageRange: lines[i + 1], gender: lines[i + 2], reach: Number(value.replaceAll(",", "")) });
  }
  return { reach, reachLocation, reachBreakdown };
}

/** Inspect only the selected public Library ID. Meta's detail panel does not expose reaction counts. */
export async function inspectPublicMetaAd(adId: string): Promise<PublicAdDetails> {
  if (!/^\d{6,40}$/.test(adId)) throw new Error("Invalid Library ID");
  const provider = metaAdLibraryFetcher();
  logger.info({ provider, operation: "ad_details", adId }, "[CreativeIntelligence] Using Meta Ad Library fetcher");
  if (provider === "scrapling") return inspectScraplingAd(adId);
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.META_AD_LIBRARY_CHROME_PATH ? { executablePath: process.env.META_AD_LIBRARY_CHROME_PATH } : { channel: "chrome" }) });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const response = await page.goto(`https://business.facebook.com/ads/library/?id=${adId}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? "unknown"}`);
    const linkedAd = page.getByRole("dialog", { name: "Link to ad" });
    await linkedAd.getByText(`Library ID: ${adId}`, { exact: true }).waitFor({ timeout: 10000 });
    const trigger = linkedAd.getByText(/See (ad|summary) details/i).first();
    await trigger.click({ timeout: 7000 });
    const dialog = page.getByRole("dialog", { name: "Ad details" });
    await dialog.getByText("About the advertiser", { exact: true }).waitFor({ timeout: 7000 });
    const dialogText = await dialog.innerText();
    if (!dialogText.includes(`Library ID: ${adId}`)) throw new Error("Ad detail did not match the requested Library ID");
    const transparency = dialog.getByText("Transparency by location", { exact: true });
    if (!await transparency.count()) return { status: "unavailable", reach: null, reachLocation: null, reachBreakdown: [], engagement: { likes: null, comments: null, shares: null }, message: "This ad detail shows About the advertiser only. Meta does not show reach or engagement counts here." };
    await transparency.click();
    const tabs = dialog.getByRole("tab");
    const regions: Array<Pick<PublicAdDetails, "reach" | "reachLocation" | "reachBreakdown">> = [];
    const tabCount = await tabs.count();
    for (let index = 0; index < Math.max(1, tabCount); index++) {
      if (tabCount) await tabs.nth(index).click();
      await dialog.getByText(/^(?:EU )?Ad delivery$/i).waitFor({ timeout: 7000 });
      regions.push(parseTransparencyByLocation(await dialog.innerText()));
    }
    const primary = regions.find((region) => region.reachLocation === "European Union" && region.reach !== null) || regions.find((region) => region.reach !== null) || regions[0];
    const regionalReach = regions.filter((region): region is typeof region & { reach: number; reachLocation: string } => region.reach !== null && region.reachLocation !== null).map((region) => ({ location: region.reachLocation, reach: region.reach }));
    return { status: primary.reach === null ? "unavailable" : "succeeded", ...primary, regionalReach, engagement: { likes: null, comments: null, shares: null }, message: primary.reach === null ? "Transparency by location was present, but a reach value was not shown." : "Estimated reach from Meta's Transparency by location section. Likes, comments and shares are not shown in this detail panel." };
  } catch (error) {
    logger.warn({ adId, reason: error instanceof Error ? error.message : "unknown" }, "[CreativeIntelligence] Public ad detail unavailable");
    return { status: "provider_error", reach: null, reachLocation: null, reachBreakdown: [], engagement: { likes: null, comments: null, shares: null }, message: "The public ad detail could not be inspected. Retry or open the ad in Meta Ad Library." };
  } finally { await browser?.close().catch(() => undefined); }
}

async function diagnoseScreenshot(path: string, status: number | null): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return status === 403 || status === 429
    ? "Meta denied automated access to the public page. Open the public Library manually or retry later."
    : "The public page layout or loading state could not be verified; inspect the saved screenshot.";
  try {
    const image = await readFile(path);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 12000, maxRetries: 0 });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 100,
      messages: [{ role: "user", content: [
        { type: "text", text: "Classify this public Meta Ad Library screenshot in one short sentence: access blocked, login/CAPTCHA, empty results, loading, or layout changed. Do not suggest bypassing access controls." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
      ] }],
    });
    const classification = response.choices[0]?.message?.content?.toLowerCase() || "";
    if (status === 403 || status === 429 || /blocked|denied|forbidden|blank/.test(classification))
      return "Meta denied automated access to the public page. Open the public Library manually or retry later.";
    if (/login|log in|captcha|sign in/.test(classification))
      return "The public page requires an interactive check. Open the Library manually; no automated bypass will be attempted.";
    if (/loading/.test(classification))
      return "The public page did not finish loading. Retry the search later.";
    if (/layout|changed/.test(classification))
      return "The public page layout may have changed. Review the saved screenshot and update the extractor.";
    return "Screenshot analysis was inconclusive; review the saved screenshot.";
  } catch {
    return "Screenshot analysis was unavailable; inspect the saved screenshot.";
  }
}

export async function searchPublicMetaAds(query: string): Promise<{ status: "succeeded" | "empty" | "provider_error"; ads: PublicLibraryAd[]; message: string }> {
  const provider = metaAdLibraryFetcher();
  logger.info({ provider, operation: "search" }, "[CreativeIntelligence] Using Meta Ad Library fetcher");
  if (provider === "scrapling") return searchScraplingAds(query);
  const url = publicLibraryUrl(query);
  let browser: Browser | undefined;
  let page: Page | undefined;
  let httpStatus: number | null = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.META_AD_LIBRARY_CHROME_PATH ? { executablePath: process.env.META_AD_LIBRARY_CHROME_PATH } : { channel: "chrome" }) });
    page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    httpStatus = response?.status() ?? null;
    if (!response?.ok()) throw new Error(`HTTP ${httpStatus ?? "unknown"}`);
    await page.getByText(/Library ID:\s*\d+/i).first().waitFor({ timeout: 8000 }).catch(() => undefined);
    const text = await page.locator("body").innerText({ timeout: 5000 });
    const ads = parsePublicLibraryText(text);
    if (ads.length) return { status: "succeeded", ads, message: "Public active ads observed in a bounded search sample." };
    if (/no ads found|no results found|0 results/i.test(text)) return { status: "empty", ads: [], message: "No public active ads were shown for this search." };
    throw new Error("No recognizable ad cards or empty-results message");
  } catch (error) {
    let screenshotPath: string | null = null;
    if (page) {
      try {
        screenshotPath = join(await mkdtemp(join(tmpdir(), "meta-ad-library-")), "error.png");
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
      } catch { screenshotPath = null; }
    }
    const diagnosis = screenshotPath ? await diagnoseScreenshot(screenshotPath, httpStatus) : "The browser could not load the public page.";
    logger.warn({ httpStatus, screenshotPath, reason: error instanceof Error ? error.message : "unknown", diagnosis }, "[CreativeIntelligence] Public Meta Ad Library search unavailable");
    return { status: "provider_error", ads: [], message: `Public Meta Ad Library search is unavailable. ${diagnosis}` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function scraplingFailure(error: string | null): string {
  return error === "dependency_missing"
    ? "Scrapling is not installed in the configured Python environment. Install scripts/requirements-scrapling.txt using the Python executable configured for Meta Ad Library."
    : "Scrapling could not load or recognize the public Meta page. Retry or open Meta Ad Library.";
}

async function searchScraplingAds(query: string): Promise<{ status: "succeeded" | "empty" | "provider_error"; ads: PublicLibraryAd[]; message: string }> {
  try {
    const result = await fetchWithScrapling(publicLibraryUrl(query), "search");
    if (result.error || result.status === null || result.status >= 400) {
      logger.warn({ provider: "scrapling", httpStatus: result.status, error: result.error, screenshotPath: result.screenshotPath }, "[CreativeIntelligence] Public search unavailable");
      return { status: "provider_error", ads: [], message: scraplingFailure(result.error) };
    }
    const ads = parsePublicLibraryText(result.text);
    if (ads.length) return { status: "succeeded", ads, message: "Public active ads observed in a bounded search sample." };
    if (/no ads found|no results found|0 results/i.test(result.text)) return { status: "empty", ads: [], message: "No public active ads were shown for this search." };
    const diagnosis = result.screenshotPath ? await diagnoseScreenshot(result.screenshotPath, result.status) : scraplingFailure(null);
    logger.warn({ provider: "scrapling", screenshotPath: result.screenshotPath, diagnosis }, "[CreativeIntelligence] Public search layout unavailable");
    return { status: "provider_error", ads: [], message: `Public Meta Ad Library search is unavailable. ${diagnosis}` };
  } catch (error) {
    logger.warn({ provider: "scrapling", reason: error instanceof Error ? error.message : "unknown" }, "[CreativeIntelligence] Scrapling search failed");
    return { status: "provider_error", ads: [], message: scraplingFailure(null) };
  }
}

async function inspectScraplingAd(adId: string): Promise<PublicAdDetails> {
  const unavailable = { reach: null, reachLocation: null, reachBreakdown: [], engagement: { likes: null, comments: null, shares: null } } as const;
  try {
    const result = await fetchWithScrapling(`https://business.facebook.com/ads/library/?id=${adId}`, "details");
    if (result.error || result.status === null || result.status >= 400 || !result.text.includes(`Library ID: ${adId}`)) {
      logger.warn({ provider: "scrapling", adId, httpStatus: result.status, error: result.error, screenshotPath: result.screenshotPath }, "[CreativeIntelligence] Public detail unavailable");
      return { ...unavailable, reachBreakdown: [], status: "provider_error", message: scraplingFailure(result.error) };
    }
    if (!result.regions.length) return { ...unavailable, reachBreakdown: [], status: "unavailable", message: "This ad detail shows About the advertiser only. Meta does not show reach or engagement counts here." };
    const regions = result.regions.map(parseTransparencyByLocation);
    const primary = regions.find((region) => region.reachLocation === "European Union" && region.reach !== null) || regions.find((region) => region.reach !== null) || regions[0];
    const regionalReach = regions.filter((region): region is typeof region & { reach: number; reachLocation: string } => region.reach !== null && region.reachLocation !== null).map((region) => ({ location: region.reachLocation, reach: region.reach }));
    return { ...primary, regionalReach, engagement: { likes: null, comments: null, shares: null }, status: primary.reach === null ? "unavailable" : "succeeded", message: primary.reach === null ? "Transparency by location was present, but a reach value was not shown." : "Estimated reach from Meta's Transparency by location section. Likes, comments and shares are not shown in this detail panel." };
  } catch (error) {
    logger.warn({ provider: "scrapling", adId, reason: error instanceof Error ? error.message : "unknown" }, "[CreativeIntelligence] Scrapling detail failed");
    return { ...unavailable, reachBreakdown: [], status: "provider_error", message: scraplingFailure(null) };
  }
}

export function asCreativeReferences(ads: PublicLibraryAd[]): CreativeReference[] {
  const observedAt = new Date().toISOString();
  return ads.map((ad) => ({
    id: ad.id, source: "meta_library", pageName: ad.pageName, pageId: null,
    estimatedEuReach: null, url: ad.url, bodies: ad.body ? [ad.body] : [],
    titles: [], descriptions: [], captions: [], platforms: [], format: ad.format,
    notes: "Observed on public Meta Ad Library search page; text extraction may be incomplete.",
    observedAt, startDate: ad.startDate, endDate: null, signals: [], engagement: ad.engagement,
  }));
}
