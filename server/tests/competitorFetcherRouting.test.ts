import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { withBusinessScope } from "../tenancy/businessContext.js";

const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const fetchWithScrapling = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const loadPlaywright = jest.fn();
jest.unstable_mockModule("../models/db.js", () => ({ db: { execute } }));
jest.unstable_mockModule("playwright-core", () => { loadPlaywright(); throw new Error("Node Playwright must not load for Scrapling competitor requests"); });
jest.unstable_mockModule("../middleware/creditCheck.js", () => ({ requireCredits: (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.unstable_mockModule("../services/ads/creative-intelligence/CreativeIntelligenceService.js", () => ({ creativeIntelligenceService: {} }));
const { metaAdLibraryFetcher } = await import("../services/ads/creative-intelligence/MetaAdLibraryFetcher.js");
jest.unstable_mockModule("../services/ads/creative-intelligence/MetaAdLibraryFetcher.js", () => ({ metaAdLibraryFetcher, fetchWithScrapling }));
const { default: router } = await import("../routes/creativeIntelligence.routes.js");

const originalProvider = process.env.META_AD_LIBRARY_FETCHER;
const originalFlag = process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
afterEach(() => {
  if (originalProvider === undefined) delete process.env.META_AD_LIBRARY_FETCHER;
  else process.env.META_AD_LIBRARY_FETCHER = originalProvider;
  if (originalFlag === undefined) delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
  else process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = originalFlag;
  jest.clearAllMocks();
});

// Invoke the registered Express handlers without binding a network socket.
function routeHandler(path: string) {
  const match = router.stack.find((layer) => layer.route?.path === path)?.route?.stack[0];
  if (!match) throw new Error(`Missing route: ${path}`);
  return match.handle;
}

async function get(path: string, params = {}) {
  const json = jest.fn();
  const response = { status: jest.fn().mockReturnThis(), json };
  await withBusinessScope({ userId: 42, businessProfileId: 8 }, () =>
    routeHandler(path)({ user: { id: 42 }, params } as Request, response as unknown as Response, jest.fn()),
  );
  expect(response.status).toHaveBeenCalledWith(200);
  return json.mock.calls[0][0] as Record<string, any>;
}

describe("Meta competitor analysis route provider wiring", () => {
  it("uses Scrapling throughout discovery, advertiser ads and details", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = "true";
    execute.mockResolvedValue({ rows: [{ company_name: "Own Brand", industry: "Software" }] });
    const result = { status: 200, text: "Library ID: 123456789\nOwn Brand\nSponsored\nOwn offer\nLibrary ID: 987654321\nCompetitor\nSponsored\nObserved offer", regions: [], error: null, screenshotPath: null };
    fetchWithScrapling.mockResolvedValue(result);

    const discovery = await get("/competitor-profiles");
    expect(discovery.status).toBe("succeeded");
    expect(discovery.profiles).toEqual([expect.objectContaining({ pageName: "Competitor", sampleAdCount: 1 })]);
    expect(new URL(fetchWithScrapling.mock.calls[0][0] as string).searchParams.get("q")).toBe("Software");

    const ads = await get("/competitor-profiles/:pageName/ads", { pageName: "Competitor" });
    expect(ads.references).toHaveLength(1);
    expect(ads.references[0].id).toBe("987654321");
    expect(new URL(fetchWithScrapling.mock.calls[1][0] as string).searchParams.get("q")).toBe("Competitor");

    fetchWithScrapling.mockResolvedValue({ ...result, text: "Library ID: 987654321\nAbout the advertiser" });
    const details = await get("/competitor-ads/:adId/details", { adId: "987654321" });
    expect(details.status).toBe("unavailable");
    expect(fetchWithScrapling).toHaveBeenLastCalledWith("https://business.facebook.com/ads/library/?id=987654321", "details");
    expect(loadPlaywright).not.toHaveBeenCalled();
  });

  it("exposes the active provider through capabilities", async () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    const json = jest.fn();
    routeHandler("/capabilities")({} as Request, { json } as unknown as Response, jest.fn());
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ metaAdLibraryFetcher: "scrapling" }));
  });

  it("marks competitor responses with the provider and prevents cached responses", () => {
    process.env.META_AD_LIBRARY_FETCHER = "scrapling";
    const middleware = router.stack.find((layer) => !layer.route);
    if (!middleware) throw new Error("Missing competitor response middleware");
    const setHeader = jest.fn();
    const next = jest.fn();
    middleware.handle({} as Request, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith("X-Meta-Ad-Library-Fetcher", "scrapling");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(next).toHaveBeenCalled();
  });
});
