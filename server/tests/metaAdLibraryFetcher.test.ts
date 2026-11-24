import { afterEach, describe, expect, it, jest } from "@jest/globals";

const launch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const loadPlaywright = jest.fn();
const fetchWithScrapling = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Keep provider selection real while isolating browsers and the Python process.
const { metaAdLibraryFetcher } = await import("../services/ads/creative-intelligence/MetaAdLibraryFetcher.js");
jest.unstable_mockModule("playwright-core", () => { loadPlaywright(); return { chromium: { launch } }; });
jest.unstable_mockModule("../services/ads/creative-intelligence/MetaAdLibraryFetcher.js", () => ({ metaAdLibraryFetcher, fetchWithScrapling }));
const { searchPublicMetaAds, inspectPublicMetaAd } = await import("../services/ads/creative-intelligence/PublicMetaAdLibraryService.js");

const originalProvider = process.env.META_AD_LIBRARY_FETCHER;
afterEach(() => {
  if (originalProvider === undefined) delete process.env.META_AD_LIBRARY_FETCHER;
  else process.env.META_AD_LIBRARY_FETCHER = originalProvider;
  jest.clearAllMocks();
});
const response = (text: string, extra = {}) => ({ status: 200, text, regions: [], screenshotPath: null, error: null, ...extra });

describe("public competitor research provider", () => {
  it("defaults to Scrapling and rejects invalid provider configuration", () => {
    delete process.env.META_AD_LIBRARY_FETCHER;
    expect(metaAdLibraryFetcher()).toBe("scrapling");
    process.env.META_AD_LIBRARY_FETCHER = " Playwright ";
    expect(metaAdLibraryFetcher()).toBe("playwright");
    process.env.META_AD_LIBRARY_FETCHER = "typo";
    expect(() => metaAdLibraryFetcher()).toThrow("playwright or scrapling");
  });
  it("uses Scrapling for advertiser cards with the existing India search and parsing", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    fetchWithScrapling.mockResolvedValue(response("Library ID: 123456789\nExample Advertiser\nSponsored\nBook a demo"));
    const result = await searchPublicMetaAds("software & salons");
    expect(result).toMatchObject({ status: "succeeded", ads: [{ id: "123456789", pageName: "Example Advertiser", body: "Book a demo" }] });
    const url = new URL(fetchWithScrapling.mock.calls[0][0] as string);
    expect(url.searchParams.get("country")).toBe("IN");
    expect(url.searchParams.get("q")).toBe("software & salons");
    expect(launch).not.toHaveBeenCalled();
    expect(loadPlaywright).not.toHaveBeenCalled();
  });
  it.each([
    ["No ads found", {}, "empty"],
    ["Log in to continue", {}, "provider_error"],
    ["No ads found", { status: 403 }, "provider_error"],
    ["No ads found", { status: 429 }, "provider_error"],
    ["", { error: "dependency_missing" }, "provider_error"],
  ])("distinguishes empty results from provider errors", async (text, extra, status) => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    fetchWithScrapling.mockResolvedValue(response(text, extra));
    expect((await searchPublicMetaAds("software")).status).toBe(status);
  });
  it("contains bridge failures without silently falling back", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    fetchWithScrapling.mockRejectedValue(new Error("process timed out"));
    expect((await searchPublicMetaAds("software")).status).toBe("provider_error");
    expect((await inspectPublicMetaAd("123456789")).status).toBe("provider_error");
    expect(launch).not.toHaveBeenCalled();
  });
  it("fetches selected ad details with Scrapling and parses public reach", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    fetchWithScrapling.mockResolvedValue(response("Library ID: 123456789\nAbout the advertiser", { regions: ["Transparency by location\nUnited Kingdom\nAd delivery\nReach\n1,234\nAbout the advertiser"] }));
    expect(await inspectPublicMetaAd("123456789")).toMatchObject({ status: "succeeded", reach: 1234, reachLocation: "United Kingdom", engagement: { likes: null, comments: null, shares: null } });
    expect(fetchWithScrapling).toHaveBeenCalledWith("https://business.facebook.com/ads/library/?id=123456789", "details");
    expect(launch).not.toHaveBeenCalled();
  });
  it("rejects mismatched detail IDs and preserves unavailable reach", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    fetchWithScrapling.mockResolvedValue(response("Library ID: 987654321"));
    expect((await inspectPublicMetaAd("123456789")).status).toBe("provider_error");
    fetchWithScrapling.mockResolvedValue(response("Library ID: 123456789\nAbout the advertiser"));
    expect(await inspectPublicMetaAd("123456789")).toMatchObject({ status: "unavailable", reach: null });
    await expect(inspectPublicMetaAd("invalid")).rejects.toThrow("Invalid Library ID");
  });
  it("retains the Playwright search and detail flows when selected", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "playwright";
    launch.mockRejectedValue(new Error("browser unavailable in unit test"));
    expect((await searchPublicMetaAds("software")).status).toBe("provider_error");
    expect((await inspectPublicMetaAd("123456789")).status).toBe("provider_error");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(fetchWithScrapling).not.toHaveBeenCalled();
  });
});
