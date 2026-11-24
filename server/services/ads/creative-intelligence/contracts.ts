import { z } from "zod";
import { safeReferenceUrl } from "./researchSignals.js";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(2000);
const publicUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => safeReferenceUrl(value) !== null,
    "Use a public HTTPS URL without credentials or token parameters.",
  )
  .transform((value) => safeReferenceUrl(value)!);
export const researchInputSchema = z
  .object({
    requestId: z.string().uuid(),
    source: z.enum(["manual", "meta_library"]),
    query: z.string().trim().min(2).max(100).optional(),
    pageId: z.string().regex(/^\d{1,40}$/).optional(),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .default("IN"),
    accountId: id.optional(),
    references: z
      .array(
        z
          .object({
            pageName: z.string().trim().min(1).max(200),
            url: publicUrl.optional(),
            body: z.string().trim().max(5000).default(""),
            notes: z.string().trim().max(3000).default(""),
            format: z
              .enum(["image", "video", "carousel", "unknown"])
              .default("unknown"),
          })
          .strict()
          .refine(
            (ref) => Boolean(ref.body || ref.notes),
            "Add observed copy or notes.",
          ),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === "manual" && !value.references.length)
      ctx.addIssue({
        code: "custom",
        message: "Add at least one competitor reference.",
        path: ["references"],
      });
    if (
      value.source === "meta_library" &&
      ((!value.query && !value.pageId) || !value.accountId || value.references.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Select an account and advertiser profile or search terms for library research; manual references belong in a separate run.",
      });
  });
export const briefInputSchema = z
  .object({
    requestId: z.string().uuid(),
    researchRunIds: z
      .array(id)
      .min(1)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
    campaignId: id.optional(),
    businessFacts: z.string().trim().min(10).max(6000),
    audience: text,
    objective: z
      .enum([
        "awareness",
        "traffic",
        "engagement",
        "leads",
        "sales",
        "app_installs",
      ])
      .default("leads"),
    language: z.string().trim().min(1).max(80).default("English"),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .default("IN"),
    landingUrl: publicUrl.optional(),
    constraints: z.string().trim().max(3000).default(""),
  })
  .strict();
export const conceptSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    title: text,
    format: z.enum(["image", "video", "carousel", "text"]),
    hook: text,
    headline: z.string().trim().min(1).max(40),
    copyDirection: text,
    visualDirection: text,
    scenes: z.array(text).max(8),
    ctaText: z.string().trim().min(1).max(120),
    ctaType: z.enum([
      "learn_more",
      "shop_now",
      "sign_up",
      "book_now",
      "contact_us",
      "download",
    ]),
    rationale: text,
    evidenceIds: z.array(z.string().max(100)).min(1).max(20),
    uncertainty: text,
    testVariable: text,
    requiredAssets: z.array(text).max(10),
  })
  .strict();
export const conceptsSchema = z
  .object({ concepts: z.array(conceptSchema).min(1).max(3) })
  .strict()
  .refine(
    (value) =>
      new Set(value.concepts.map((c) => c.id)).size === value.concepts.length,
    "Concept IDs must be unique.",
  );
export const selectConceptSchema = z
  .object({ revision: id, conceptId: z.string().regex(/^[a-z0-9-]{1,60}$/) })
  .strict();
export type ResearchInput = z.infer<typeof researchInputSchema>;
export type BriefInput = z.infer<typeof briefInputSchema>;
export class CreativeIntelligenceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assertCreativeIntelligenceEnabled() {
  if (process.env.AD_CREATIVE_INTELLIGENCE_ENABLED !== "true")
    throw new CreativeIntelligenceError(
      503,
      "Creative research is not enabled.",
    );
}
