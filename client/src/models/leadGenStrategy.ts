import { z } from "zod";

// Lead Generation Strategy
export const leadGenStrategySchema = z.object({
  channels: z.array(z.object({
    name: z.string(),
    priority: z.enum(["high", "medium", "low"]),
  })),
  targetAudience: z.object({
    jobTitles: z.array(z.string()),
    industries: z.array(z.string()),
    companySize: z.string(),
  }),
  location: z.string().optional(),
  estimatedLeads: z.number(),
})

export type LeadGenStrategy = z.infer<typeof leadGenStrategySchema>;