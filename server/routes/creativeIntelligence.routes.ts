import { Router, type Request, type Response } from "express";
import { ZodError, z } from "zod";
import { businessOwnerUserId } from "../tenancy/businessContext.js";
import { requireCredits } from "../middleware/creditCheck.js";
import { creativeIntelligenceService as service } from "../services/ads/creative-intelligence/CreativeIntelligenceService.js";
import {
  assertCreativeIntelligenceEnabled,
  CreativeIntelligenceError,
  selectConceptSchema,
} from "../services/ads/creative-intelligence/contracts.js";
import { COMMERCIAL_LIBRARY_COUNTRIES } from "../services/ads/creative-intelligence/MetaAdsLibraryResearchService.js";
import { discoverCompetitorProfiles, getCompetitorProfileAds } from "../services/ads/creative-intelligence/CompetitorProfileDiscovery.js";
import { inspectPublicMetaAd } from "../services/ads/creative-intelligence/PublicMetaAdLibraryService.js";
import { metaAdLibraryFetcher } from "../services/ads/creative-intelligence/MetaAdLibraryFetcher.js";
import { logger } from "../utils/logger.js";

const router = Router();
const positiveId = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const advertiserNameSchema = z.string().trim().min(1).max(200);
const handler =
  (fn: (req: Request, userId: number) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      const userId = positiveId.parse(
        businessOwnerUserId(req),
      );
      res.status(status).json(await fn(req, userId));
    } catch (error) {
      if (error instanceof ZodError) {
        res
          .status(400)
          .json({
            error: error.issues.map((issue) => issue.message).join(" "),
          });
        return;
      }
      if (error instanceof CreativeIntelligenceError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res
        .status(503)
        .json({
          error:
            "Creative research is unavailable. Check configuration and try again.",
        });
    }
  };
router.get("/capabilities", (_req, res) =>
  res.json({
    enabled: process.env.AD_CREATIVE_INTELLIGENCE_ENABLED === "true",
    commercialLibraryCountries: COMMERCIAL_LIBRARY_COUNTRIES,
    metaAdLibraryFetcher: metaAdLibraryFetcher(),
  }),
);
// Report the selected server-side provider for live public competitor requests.
router.use(["/competitor-profiles", "/competitor-ads"], (_req, res, next) => {
  res.setHeader("X-Meta-Ad-Library-Fetcher", metaAdLibraryFetcher());
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get("/competitor-profiles", handler(async (req, userId) => {
  assertCreativeIntelligenceEnabled();
  const started = Date.now();
  try {
    const result = await discoverCompetitorProfiles(userId);
    logger.info({userId, country:"IN", source:"public_page", status:result.status, profileCount:result.profiles.length, durationMs:Date.now()-started}, "[CreativeIntelligence] Advertiser discovery");
    return result;
  } catch (error) {
    logger.warn({userId, country:"IN", durationMs:Date.now()-started, reason:error instanceof Error?error.message:'unknown'}, "[CreativeIntelligence] Advertiser discovery failed");
    throw error;
  }
}));
router.get("/competitor-profiles/:pageName/ads", handler(async (req, userId) => {
  assertCreativeIntelligenceEnabled();
  const pageName = advertiserNameSchema.parse(req.params.pageName);
  const started = Date.now();
  try {
    const result = await getCompetitorProfileAds(userId, pageName);
    logger.info({userId, country:"IN", source:"public_page", status:result.status, adCount:result.references.length, durationMs:Date.now()-started}, "[CreativeIntelligence] Advertiser ads fetched");
    return result;
  } catch (error) {
    logger.warn({userId, country:"IN", durationMs:Date.now()-started, reason:error instanceof Error?error.message:'unknown'}, "[CreativeIntelligence] Advertiser ads fetch failed");
    throw error;
  }
}));
router.get("/competitor-ads/:adId/details", handler(async (req) => {
  assertCreativeIntelligenceEnabled();
  const adId = z.string().regex(/^\d{6,40}$/).parse(req.params.adId);
  return inspectPublicMetaAd(adId);
}));
// Saved records remain readable with the flag off; new work is gated in the service.
router.get(
  "/briefs",
  handler((_req, userId) => service.history(userId)),
);
router.get(
  "/briefs/:id",
  handler((req, userId) =>
    service.brief(userId, positiveId.parse(req.params.id)),
  ),
);
router.get(
  "/research/:id",
  handler((req, userId) =>
    service.research(userId, positiveId.parse(req.params.id)),
  ),
);
router.post(
  "/research",
  handler((req, userId) => service.createResearch(userId, req.body), 202),
);
router.post(
  "/briefs",
  requireCredits,
  handler((req, userId) => service.createBrief(userId, req.body), 202),
);
router.patch(
  "/briefs/:id",
  handler((req, userId) => {
    const input = selectConceptSchema.parse(req.body);
    return service.selectConcept(
      userId,
      positiveId.parse(req.params.id),
      input.revision,
      input.conceptId,
    );
  }),
);
router.post(
  "/briefs/:id/draft-review",
  handler((req, userId) => {
    const input = selectConceptSchema.parse(req.body);
    return service.createDraftReview(userId, positiveId.parse(req.params.id), input.revision, input.conceptId);
  }),
);
router.post(
  "/briefs/:id/generation-inputs",
  handler(async (req, userId) => {
    assertCreativeIntelligenceEnabled();
    const input = selectConceptSchema.parse(req.body);
    return service.generationInputs(userId, {
      creative_brief_id: positiveId.parse(req.params.id),
      creative_brief_revision: input.revision,
      creative_concept_id: input.conceptId,
    });
  }),
);
export default router;
