import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  researchInputSchema,
  briefInputSchema,
  CreativeIntelligenceError,
} from "../../services/ads/creative-intelligence/contracts.js";
import { creativeIntelligenceService as service } from "../../services/ads/creative-intelligence/CreativeIntelligenceService.js";
import type { ToolContext } from "./toolRegistry.js";

async function run(
  name: string,
  context: ToolContext,
  action: (userId: number) => Promise<unknown>,
) {
  try {
    const userId = Number(context?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new CreativeIntelligenceError(401, "Authentication required.");
    const { getEffectiveModuleAccess } =
      await import("../../models/platformAccess/functions.js");
    const access = (await getEffectiveModuleAccess(userId)).find(
      (module) => module.key === "performance_marketing",
    );
    if (!access?.enabled)
      throw new CreativeIntelligenceError(
        403,
        "Performance marketing is unavailable for this account.",
      );
    return { success: true, toolName: name, output: await action(userId) };
  } catch (error) {
    return {
      success: false,
      toolName: name,
      error:
        error instanceof CreativeIntelligenceError
          ? error.message
          : "Creative research could not complete. Review the inputs and try again.",
    };
  }
}
export const researchAdCreativesTool = createTool({
  id: "research_ad_creatives",
  description:
    "Save manual competitor observations or queue a Meta Ads Library search. Returns a saved run ID, not generated creatives. Never publishes.",
  inputSchema: researchInputSchema,
  execute: async (input, { mastra }) =>
    run(
      "research_ad_creatives",
      (mastra as unknown as { __toolContext: ToolContext })?.__toolContext,
      (userId) => service.createResearch(userId, input),
    ),
});
export const suggestCreativeBriefsTool = createTool({
  id: "suggest_ad_creative_briefs",
  description:
    "Queue evidence-grounded creative suggestions from owned completed research and reviewed product facts. Returns a pending brief ID; poll with get_ad_creative_research. Never generates media or launches ads.",
  inputSchema: briefInputSchema,
  execute: async (input, { mastra }) =>
    run(
      "suggest_ad_creative_briefs",
      (mastra as unknown as { __toolContext: ToolContext })?.__toolContext,
      async (userId) => {
        const { getBalance } =
          await import("../../models/wallets/functions.js");
        if ((await getBalance(userId)) <= 0)
          throw new CreativeIntelligenceError(
            402,
            "Recharge credits before generating suggestions.",
          );
        return service.createBrief(userId, input);
      },
    ),
});
export const getCreativeResearchTool = createTool({
  id: "get_ad_creative_research",
  description:
    "Read an owned research run or saved brief. Selected ready briefs include exact reviewed generate_ad inputs and provenance. Pending work is not complete.",
  inputSchema: z
    .object({
      kind: z.enum(["research", "brief"]),
      id: z.number().int().positive(),
    })
    .strict(),
  execute: async (input, { mastra }) =>
    run(
      "get_ad_creative_research",
      (mastra as unknown as { __toolContext: ToolContext })?.__toolContext,
      async (userId) => {
        if (input.kind === "research")
          return service.research(userId, input.id);
        const brief = await service.brief(userId, input.id);
        const generationInputs =
          brief.status === "ready" && brief.selected_concept_id
            ? await service.generationInputs(userId, {
                creative_brief_id: brief.id,
                creative_brief_revision: brief.revision,
                creative_concept_id: brief.selected_concept_id,
              })
            : null;
        return {
          brief,
          generationInputs,
          reviewUrl: `/dashboard/ads?tab=recommendations&creativeBrief=${brief.id}`,
        };
      },
    ),
});
