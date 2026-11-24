import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { contentAssetsTable } from '../../../models/contentAssets/schema.js';
import { ContentAssetModel } from '../../../models/contentAssets/functions.js';
import { changeOrganicPublishSchedule, updateEditableContentAsset } from '../../../services/social/OrganicPublishLifecycleService.js';
import { brandContextSnapshot, resolveContentBrandContext } from '../../../services/content/ContentBrandContextService.js';
import { contentOutputSchemas, validateGeneratedContent, type ContentOutputType } from '../../../services/content/ContentComplianceService.js';
import { scheduledPostsInput, editSavedContentInput, changeScheduledPostInput } from '../contentManagementTools.js';
import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state.js';

function user(context: ToolContext): number {
  if (!Number.isSafeInteger(context?.userId) || context.userId <= 0) throw new Error('Unauthorized');
  return context.userId;
}
const failed = (toolName: string, error: unknown): ToolResult => ({ success: false, toolName, error: error instanceof Error ? error.message : 'Content operation failed' });

export async function executeQueryScheduledPosts(raw: unknown, context: ToolContext): Promise<ToolResult> {
  const toolName = 'query_scheduled_posts';
  try {
    const userId = user(context), input = scheduledPostsInput.parse(raw);
    if (input.from && input.to && new Date(input.from) > new Date(input.to)) throw new Error('from must not be after to');
    const conditions = [eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.status, 'scheduled')];
    if (input.scope === 'current_campaign') {
      if (!Number.isSafeInteger(context.threadId) || context.threadId <= 0) throw new Error('Current campaign is required');
      conditions.push(eq(contentAssetsTable.threadId, context.threadId));
    }
    if (input.asset_id) conditions.push(eq(contentAssetsTable.id, input.asset_id));
    if (input.from) conditions.push(gte(contentAssetsTable.scheduledPublishAt, new Date(input.from)));
    if (input.to) conditions.push(lte(contentAssetsTable.scheduledPublishAt, new Date(input.to)));
    if (input.platform) conditions.push(eq(contentAssetsTable.publishPlatform, input.platform));
    const rows = await db.select({ id: contentAssetsTable.id, title: contentAssetsTable.title,
      platform: contentAssetsTable.publishPlatform, scheduledFor: contentAssetsTable.scheduledPublishAt,
      status: contentAssetsTable.status, version: contentAssetsTable.version, parentAssetId: contentAssetsTable.parentAssetId,
    }).from(contentAssetsTable).where(and(...conditions)).orderBy(asc(contentAssetsTable.scheduledPublishAt), asc(contentAssetsTable.id)).limit(input.limit + 1).offset(input.offset);
    return { success: true, toolName, output: { posts: rows.slice(0, input.limit), hasMore: rows.length > input.limit,
      nextOffset: rows.length > input.limit ? input.offset + input.limit : null, statusSource: 'saved_schedule_not_live_provider_status' } };
  } catch (error) { return failed(toolName, error); }
}

const editableFields: Record<ContentOutputType, string[]> = {
  social: ['caption', 'hashtags', 'callToAction'], email: ['subject', 'body', 'cta'], sms: ['message'],
  social_message: ['subject', 'message'], blog: ['content', 'excerpt'], ad: ['headline', 'primaryText', 'description', 'callToAction', 'hashtags'],
};
export async function executeEditSavedContent(raw: unknown, context: ToolContext): Promise<ToolResult> {
  const toolName = 'edit_saved_content';
  try {
    const userId = user(context), input = editSavedContentInput.parse(raw);
    const asset = await ContentAssetModel.findByIdForUser(input.asset_id, userId);
    if (!asset) throw new Error('Content asset not found');
    if (input.scope === 'current_campaign' && (!Number.isSafeInteger(context.threadId) || context.threadId <= 0 || asset.threadId !== context.threadId)) throw new Error('Content asset not found in the current campaign');
    if (asset.version !== input.expected_version) throw new Error('Content version changed. Reload the asset before editing.');
    if (['scheduled', 'processing', 'published'].includes(asset.status)) throw new Error('Cancel or reconcile publishing before editing this content.');
    const type: ContentOutputType | undefined = ({ social_post: 'social', social: 'social', email: 'email', email_template: 'email',
      sms: 'sms', sms_template: 'sms', social_message: 'social_message', social_dm: 'social_message', social_chat_template: 'social_message',
      blog: 'blog', blog_post: 'blog', ad: 'ad', ad_copy: 'ad' } as Record<string, ContentOutputType>)[asset.type];
    if (!type) throw new Error('This asset type does not support text-only editing.');
    const patch = input.text_fields || {};
    if (Object.keys(patch).some(key => !editableFields[type].includes(key))) throw new Error('Text field does not belong to this content type.');
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(asset.content); } catch { throw new Error('Legacy plain-text assets must be edited in the content library.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unsupported saved content format');
    const output: Record<string, unknown> = { ...parsed, ...patch };
    if (input.title && (type === 'blog' || type === 'social')) output.title = input.title;
    contentOutputSchemas[type].parse(output);
    const brand = await resolveContentBrandContext(userId, { businessProfileId: asset.businessProfileId, brandToolkitId: asset.brandToolkitId });
    validateGeneratedContent({ type, output, context: brand, platform: String(parsed.platform || asset.channel) });
    const saved = await updateEditableContentAsset(userId, asset.id, {
      title: input.title ?? asset.title, content: JSON.stringify(output), version: input.expected_version + 1,
      approvalStatus: 'draft', approvedBy: null, approvedAt: null,
      brandContextSnapshot: brandContextSnapshot(brand), validationSnapshot: { validatedAt: new Date().toISOString(), stage: 'preview', violations: [] },
    });
    if (!saved) throw new Error('Content asset not found');
    return { success: true, toolName, output: { assetId: saved.id, version: saved.version, title: saved.title, content: saved.content, approvalStatus: saved.approvalStatus, published: false } };
  } catch (error) { return failed(toolName, error); }
}

export async function executeChangeScheduledPost(raw: unknown, context: ToolContext): Promise<ToolResult> {
  const toolName = 'change_scheduled_post';
  try {
    const userId = user(context), input = changeScheduledPostInput.parse(raw);
    if (input.scope === 'current_campaign' && (!Number.isSafeInteger(context.threadId) || context.threadId <= 0)) throw new Error('Current campaign is required');
    const result = await changeOrganicPublishSchedule(userId, [input.asset_id], input.scheduled_for ? new Date(input.scheduled_for) : undefined, {
      exactAssetOnly: true, expectedVersions: { [input.asset_id]: input.expected_version },
      expectedScheduledFor: { [input.asset_id]: input.expected_scheduled_for },
      ...(input.scope === 'current_campaign' ? { threadId: context.threadId } : {}),
    });
    return { success: true, toolName, output: { ...result, assetId: input.asset_id, action: input.action, scheduledFor: input.scheduled_for ?? null, providerSendPerformed: false } };
  } catch (error) { return failed(toolName, error); }
}
