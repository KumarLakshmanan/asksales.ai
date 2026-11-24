import { jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  addResearchSignals,
  normalizeLibraryAd,
  safeReferenceUrl,
} from "../services/ads/creative-intelligence/researchSignals.js";
import { fetchLibraryResearch } from "../services/ads/creative-intelligence/MetaAdsLibraryResearchService.js";
import { businessSearchTerms, groupAdProfiles } from "../services/ads/creative-intelligence/CompetitorProfileDiscovery.js";
import { parsePublicLibraryText, parseTransparencyByLocation, publicLibraryUrl } from "../services/ads/creative-intelligence/PublicMetaAdLibraryService.js";
import {
  briefInputSchema,
  researchInputSchema,
} from "../services/ads/creative-intelligence/contracts.js";
import {
  CreativeIntelligenceService,
  conceptGenerationInputs,
  validateConceptEvidence,
} from "../services/ads/creative-intelligence/CreativeIntelligenceService.js";
import type {
  CreativeBrief,
  CreativeConcept,
} from "../../shared/adCreativeIntelligence.js";

const observedAt = "2026-10-06T00:00:00.000Z";
const reference = normalizeLibraryAd(
  {
    id: "123",
    ad_creative_bodies: ["Actual creative"],
    ad_creative_link_titles: ["A title"],
    publisher_platforms: ["INSTAGRAM"],
    eu_total_reach: 1200,
    ad_delivery_start_time: "2026-09-06",
  },
  observedAt,
)!;
const concept: CreativeConcept = {
  id: "concept-a",
  title: "Demonstrate the product",
  format: "video",
  hook: "Show the workflow",
  headline: "See the workflow",
  copyDirection: "Describe the approved benefit",
  visualDirection: "Approved screen capture",
  scenes: ["Demonstrate feature"],
  ctaText: "Book a demo",
  ctaType: "book_now",
  rationale: "Test a clearer opening",
  evidenceIds: ["123"],
  uncertainty: "Competitor outcomes unknown",
  testVariable: "Opening hook",
  requiredAssets: ["Approved recording"],
};
const brief: CreativeBrief = {
  id: 7,
  status: "ready",
  revision: 2,
  selected_concept_id: "concept-a",
  concepts: [concept],
  evidence: [reference],
  message: null,
  created_at: observedAt,
  input: {
    businessFacts: "A shared appointment calendar",
    audience: "Salon owners",
    objective: "leads",
    language: "Tamil",
    country: "IN",
    constraints: "No revenue claims",
    researchRunIds: [1],
  },
};

describe("competitor research contracts", () => {
  it("builds India All ads public searches and extracts bounded visible advertiser cards", () => {
    const url = new URL(publicLibraryUrl("appointment software"));
    expect(url.hostname).toBe("business.facebook.com");
    expect(url.searchParams.get("country")).toBe("IN");
    expect(url.searchParams.get("ad_type")).toBe("all");
    expect(url.searchParams.get("q")).toBe("appointment software");
    expect(parsePublicLibraryText("Active\nLibrary ID: 123456789\nStarted running on Oct 1, 2026\nSee ad details\nImage: Example\nExample Advertiser\nSponsored\nBook a demo\nLibrary ID: 123456789\nExample Advertiser\nSponsored\nDuplicate")).toEqual([
      {id:"123456789",pageName:"Example Advertiser",body:expect.stringContaining("Book a demo"),url:"https://business.facebook.com/ads/library/?id=123456789",startDate:"2026-10-01T00:00:00.000Z",format:"image",engagement:{likes:null,comments:null,shares:null}},
    ]);
    expect(parsePublicLibraryText("Log in to continue")).toEqual([]);
    expect(parsePublicLibraryText("Active\nLibrary ID: 987654321\nVideo: Sample\nAnother Advertiser\nSponsored\nSee this offer\n1,234 reactions\n56 comments\n7 shares")[0]).toMatchObject({format:"video",engagement:{likes:null,comments:null,shares:null}});
    expect(parseTransparencyByLocation("Ad details\nTransparency by location\nUnited Kingdom\nAd delivery\nReach\n559,836\nReach by location, age and gender\nLocation\nAge range\nGender\nReach\nUnited Kingdom\n25-34\nFemale\n63,983\nAbout the advertiser")).toEqual({reach:559836,reachLocation:"United Kingdom",reachBreakdown:[{location:"United Kingdom",ageRange:"25-34",gender:"Female",reach:63983}]});
    expect(parseTransparencyByLocation("Ad details\nTransparency by location\nEuropean Union\nUnited Kingdom\nWe provide additional information for ads that were shown on Meta technologies anywhere in the EU.\nEU ad delivery\nReach\n145,709\nReach by location, age and gender\nLocation\nAge range\nGender\nReach\nAustria\n25-34\nFemale\n150\nAbout the disclaimer\nAbout the advertiser")).toEqual({reach:145709,reachLocation:"European Union",reachBreakdown:[{location:"Austria",ageRange:"25-34",gender:"Female",reach:150}]});
    expect(parseTransparencyByLocation("Ad details\nAbout the advertiser")).toEqual({reach:null,reachLocation:null,reachBreakdown:[]});
  });
  it("accepts a Page-scoped library research run and rejects an unscoped one", () => {
    const scoped = researchInputSchema.parse({requestId:"ab20b13b-6959-4fdb-9576-c35b96a4e051",source:"meta_library",accountId:9,country:"GB",pageId:"123"});
    expect(scoped.pageId).toBe("123");
    expect(researchInputSchema.safeParse({requestId:"ab20b13b-6959-4fdb-9576-c35b96a4e051",source:"meta_library",accountId:9,country:"GB"}).success).toBe(false);
  });
  it("preserves plural creative arrays and never infers video from Instagram", () => {
    expect(reference.bodies).toEqual(["Actual creative"]);
    expect(reference.titles).toEqual(["A title"]);
    expect(reference.format).toBe("unknown");
    expect(reference.estimatedEuReach).toBe(1200);
    expect(reference.url).toBe("https://www.facebook.com/ads/library/?id=123");
    expect(normalizeLibraryAd({ id: 123 }, observedAt)).toBeNull();
  });
  it("deduplicates IDs, counts actual text repetition and handles invalid or future delivery dates", () => {
    expect(addResearchSignals([reference, reference])[0].signals).toEqual([
      "30 days between delivery dates and observation; continuous delivery is unverified",
    ]);
    expect(
      addResearchSignals([
        reference,
        { ...reference, id: "456" },
      ])[0].signals.join(" "),
    ).toContain("2 distinct references");
    expect(
      addResearchSignals([{ ...reference, startDate: "2999-01-01" }])[0]
        .signals,
    ).toEqual([]);
    expect(
      addResearchSignals([{ ...reference, startDate: "bad-date" }])[0].signals,
    ).toEqual([]);
  });
  it.each([
    "https://example.com/?access_token=secret",
    "http://example.com",
    "https://user:password@example.com",
    "https://127.0.0.1",
    "https://localhost",
    "javascript:alert(1)",
    "https://[::1]",
    "https://example.com?API_KEY=secret",
  ])("rejects unsafe reference URL %s", (value) =>
    expect(safeReferenceUrl(value)).toBeNull(),
  );
  it("accepts public references without fragments and does not fetch them", () =>
    expect(safeReferenceUrl("https://example.com/ad#details")).toBe(
      "https://example.com/ad",
    ));
  it("requires observed text, strict owner-free input and supported media", () => {
    const input = {
      requestId: "a8928c95-862a-46c1-aa2b-19fc9cdbedc6",
      source: "manual",
      references: [{ pageName: "Example", body: "Observed text" }],
    };
    expect(researchInputSchema.parse(input).references[0].format).toBe(
      "unknown",
    );
    expect(researchInputSchema.parse({
      ...input,
      references: [{ pageName: "Example", body: "Observed", url: "https://example.com/ad#access_token=discard" }],
    }).references[0].url).toBe("https://example.com/ad");
    expect(
      researchInputSchema.safeParse({ ...input, user_id: 9 }).success,
    ).toBe(false);
    expect(
      researchInputSchema.safeParse({
        ...input,
        references: [{ pageName: "Example" }],
      }).success,
    ).toBe(false);
    expect(
      briefInputSchema.safeParse({
        requestId: input.requestId,
        researchRunIds: [1, 1],
        businessFacts: "Approved facts",
        audience: "Owners",
      }).success,
    ).toBe(false);
  });
});

describe("read-only Meta library adapter", () => {
  const input = {
    query: "appointments",
    country: "GB",
    accessToken: "never-expose-this-token",
    version: "v25.0",
  };
  it("returns unsupported coverage without a network call", async () => {
    const fetcher = jest.fn<typeof fetch>();
    expect(
      (await fetchLibraryResearch({ ...input, country: "IN" }, fetcher)).status,
    ).toBe("coverage_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses core plural fields, array country filters and bounded cursor paging on a fixed host", async () => {
    const fetcher = jest.fn<typeof fetch>();
    fetcher
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "123",
                ad_creative_bodies: ["Actual creative"],
                ad_snapshot_url: "https://facebook.com/?access_token=secret",
              },
            ],
            paging: {
              next: "https://malicious.example/",
              cursors: { after: "next-cursor" },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "456", ad_creative_bodies: ["Actual creative"] }],
          }),
        ),
      );
    const result = await fetchLibraryResearch(input, fetcher);
    expect(result.status).toBe("succeeded");
    expect(result.references).toHaveLength(2);
    const url = new URL(String(fetcher.mock.calls[1][0]));
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.searchParams.get("after")).toBe("next-cursor");
    expect(url.searchParams.get("ad_reached_countries")).toBe('["GB"]');
    expect(url.searchParams.get("fields")).not.toContain("eu_total_reach");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("distinguishes provider denial and empty results without leaking provider messages", async () => {
    const fetcher = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 190, message: input.accessToken } }),
          { status: 400 },
        ),
      );
    const result = await fetchLibraryResearch(input, fetcher);
    expect(result.status).toBe("permission_required");
    expect(result.message).toContain("Reconnect Meta Ads");
    expect(result.message).toContain("Meta error 190");
    expect(JSON.stringify(result)).not.toContain(input.accessToken);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: 200, error_subcode: 123, message: input.accessToken } }), { status: 403 }));
    const archiveDenial = await fetchLibraryResearch(input, fetcher);
    expect(archiveDenial.status).toBe("permission_required");
    expect(archiveDenial.message).toContain("Meta error 200/123");
    expect(JSON.stringify(archiveDenial)).not.toContain(input.accessToken);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: 100, message: input.accessToken } }), { status: 403 }));
    expect((await fetchLibraryResearch(input, fetcher)).status).toBe("provider_error");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    expect((await fetchLibraryResearch(input, fetcher)).status).toBe("empty");
  });
  it("keeps incomplete results explicitly partial", async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "1" }],
          paging: { next: "present", cursors: { after: "same" } },
        }),
      ),
    );
    // Each response body must be independently readable.
    fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "1" }],
            paging: { next: "present", cursors: { after: "same" } },
          }),
        ),
    );
    expect((await fetchLibraryResearch(input, fetcher)).status).toBe("partial");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("queries selected advertiser by Page ID without relying on a keyword", async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "123", page_id: "456", page_name: "Example" }, { id: "999", page_id: "999", page_name: "Other" }] })));
    const result = await fetchLibraryResearch({ ...input, query: "", pageId: "456" }, fetcher);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("search_page_ids")).toBe('["456"]');
    expect(url.searchParams.has("search_terms")).toBe(false);
    expect(result.references[0].pageId).toBe("456");
    expect(result.references).toHaveLength(1);
  });
});

describe("automatic advertiser discovery", () => {
  it("uses saved business categories and excludes the user's own brand", () => {
    expect(businessSearchTerms({ company_name: "My Brand", sub_industry: "Appointment software", industry: "Software", target_market: "Salons" })).toEqual(["Appointment software", "Software", "Salons"]);
    const ads = [
      { ...reference, pageId: "1", pageName: "My Brand" },
      { ...reference, id: "124", pageId: "2", pageName: "Other Brand" },
    ];
    expect(groupAdProfiles([{ term: "Software", references: ads }], "My Brand", "1")).toEqual([expect.objectContaining({ pageId: "2", pageName: "Other Brand", sampleAdCount: 1, matchedTerms: ["Software"] })]);
  });
});

describe("creative brief grounding and handoff", () => {
  it("rejects invented evidence IDs and duplicate concept IDs", () => {
    expect(() =>
      validateConceptEvidence(
        { concepts: [{ ...concept, evidenceIds: ["invented"] }] },
        [reference],
      ),
    ).toThrow();
    expect(() =>
      validateConceptEvidence({ concepts: [concept, concept] }, [reference]),
    ).toThrow();
    expect(
      validateConceptEvidence({ concepts: [concept] }, [reference]),
    ).toEqual([concept]);
  });
  it("preserves exact CTA, language, constraints and provenance without enabling media generation", () => {
    const inputs = conceptGenerationInputs(brief);
    expect(inputs).toMatchObject({
      cta_text: "Book a demo",
      cta_type: "book_now",
      language: "Tamil",
      creative_brief_id: 7,
      creative_brief_revision: 2,
      creative_concept_id: "concept-a",
      auto_generate_image: false,
      auto_generate_video: false,
      include_video_prompt: true,
    });
    expect(inputs.content_instructions).toContain("No revenue claims");
    expect(() =>
      conceptGenerationInputs({ ...brief, selected_concept_id: null }),
    ).toThrow();
  });
  it("scopes saved reads by owner and rejects inaccessible records", async () => {
    const dialect = new PgDialect();
    const execute = jest
      .fn<(query: unknown) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValue({ rows: [] });
    const service = new CreativeIntelligenceService({ execute });
    await expect(service.brief(12, 7)).rejects.toThrow("not found");
    const query = dialect.sqlToQuery(execute.mock.calls[0][0] as never);
    expect(query.sql).toContain("user_id=");
    expect(query.params).toEqual([7, 12]);
    await expect(service.research(0, 7)).rejects.toThrow("Authentication");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("rejects stale selected revisions before generation", async () => {
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = "true";
    const service = new CreativeIntelligenceService({
      execute: async () => ({ rows: [brief] }),
    });
    await expect(
      service.generationInputs(12, {
        creative_brief_id: 7,
        creative_brief_revision: 1,
        creative_concept_id: "concept-a",
      }),
    ).rejects.toThrow("changed");
    delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
  });
  it("preserves saved reads while disabling all new generation when flag is off", async () => {
    delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
    const service = new CreativeIntelligenceService({
      execute: async () => ({ rows: [brief] }),
    });
    expect(await service.brief(12, 7)).toEqual(brief);
    await expect(service.createResearch(12, {})).rejects.toThrow("not enabled");
    await expect(
      service.generationInputs(12, { creative_brief_id: 7 }),
    ).rejects.toThrow("not enabled");
  });
});
