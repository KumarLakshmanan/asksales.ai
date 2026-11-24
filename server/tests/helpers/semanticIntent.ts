import { routerOutputSchema, type SemanticRequest } from '../../mastra/routerSchema.js';

export function semanticRequest(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return { status: 'none', taskRelation: 'unspecified', contentOperation: 'none', generationReviewId: null,
    brandToolkit: 'none', outreachOperation: 'none', scope: 'current_campaign',
    lead: { requirements: null, limit: null, location: null, searchVariants: false },
    generation: { image: null, video: null, format: null, variationCount: null, length: null, exactCta: null },
    paidCampaignSelection: { kind: 'unspecified', campaignIds: [], platforms: null }, ...overrides };
}

export function intentWith(request: Partial<SemanticRequest> = {}, overrides: Record<string, unknown> = {}) {
  return routerOutputSchema.parse({ intent: 'task', action: 'new_task', hiredAgents: ['content_studio'], mode: 'hire_agent',
    isAffirmative: false, isDomainMatch: true, navigationTarget: null, response: 'Understood.',
    nextAgent: 'content_studio', suggestAgents: false, recommendedAgents: [],
    semanticRequest: semanticRequest(request), ...overrides });
}
