import { enforceSocialPostMediaConstraints, scopeGenerationRequest, type RequestConstraintContext } from './contentRequestConstraints.js';

type ChatMessage = { role: string; content: string };

export function removeAmbiguousSavedCampaignSelection(
  args: Record<string, unknown>,
  _messages: ChatMessage[],
  candidateCampaignCount: number,
  context?: RequestConstraintContext,
): Record<string, unknown> {
  const selection = context?.intentAnalysis?.semanticRequest?.paidCampaignSelection;
  if (selection?.kind === 'single' && selection.campaignIds.length === 1) return args;
  if (selection?.kind !== 'ambiguous' && selection?.kind !== 'multiple' && candidateCampaignCount <= 1) return args;
  const constrained = { ...args };
  delete constrained.campaign_id;
  delete constrained.asset_ids;
  delete constrained.review_revision;
  return constrained;
}

/** Intent is model-derived. Tenant ownership and reviewed revisions remain code gates. */
export function enforceAdRequestConstraints(
  toolName: string,
  args: Record<string, unknown>,
  messages: ChatMessage[],
  context?: RequestConstraintContext,
): Record<string, unknown> {
  const request = context?.intentAnalysis?.semanticRequest;
  if (toolName === 'generate_ad') {
    const scoped = scopeGenerationRequest(toolName, messages, context);
    const count = request?.generation.variationCount ?? scoped.defaults.number_of_variations;
    const { post_format, ...mediaArgs } = enforceSocialPostMediaConstraints(
      { ...args, post_format: args.ad_format }, scoped.messages,
      { ...scoped.defaults, post_format: scoped.defaults.ad_format }, context,
    );
    return { ...mediaArgs, ...(typeof post_format === 'string' ? { ad_format: post_format } : {}),
      ...(count !== undefined ? { number_of_variations: count } : {}) };
  }
  if (!['publish_ads', 'publish_meta_ads', 'publish_google_ads'].includes(toolName)) return args;
  const constrained = { ...args };
  // A model-supplied fingerprint never proves that the user saw a review.
  delete constrained.review_revision;
  const selection = request?.paidCampaignSelection;
  if (!selection) return constrained;
  if (selection.platforms !== null) constrained.platforms = selection.platforms;
  if (selection.kind === 'single' && selection.campaignIds.length === 1) {
    constrained.campaign_id = selection.campaignIds[0];
    delete constrained.asset_ids;
  } else if (selection.kind !== 'unspecified') {
    delete constrained.campaign_id;
    delete constrained.asset_ids;
  } else if (request.taskRelation === 'new') {
    // A new named campaign needs lookup. Independently selected assets remain
    // valid for a new campaign and still pass the normal asset ownership gate.
    delete constrained.campaign_id;
  }
  return constrained;
}
