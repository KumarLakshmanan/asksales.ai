import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { savedBrandToolkitId } from '../../utils/emailTemplates.js';

/**
 * Brand Toolkit selection for outreach workflows.
 *
 * A workflow (outreach thread, campaign, follow-up) stores the brand it was
 * created with. Precedence at creation:
 *   1. the brand explicitly chosen for this workflow (request body),
 *   2. the brand selected in the chat thread that launched it,
 *   3. a snapshot of the business's current default brand.
 * Every candidate is validated against the owner and the active business, so a
 * caller can never attach another tenant's toolkit.
 */

type QueryDb = Pick<typeof db, 'execute'>;

async function activeToolkitId(userId: number, toolkitId: number | null, queryDb: QueryDb): Promise<number | null> {
  if (!toolkitId) return null;
  const scope = currentBusinessScope();
  const result = await queryDb.execute(sql`
    SELECT id FROM brand_toolkits
    WHERE id = ${toolkitId} AND user_id = ${userId} AND is_active = true
      ${scope ? sql`AND business_profile_id = ${scope.businessProfileId}` : sql``}
    LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { id?: unknown } | undefined)?.id);
}

export async function threadSelectedBrandToolkitId(userId: number, threadId: unknown, queryDb: QueryDb = db): Promise<number | null> {
  const id = savedBrandToolkitId(threadId);
  if (!id) return null;
  const result = await queryDb.execute(sql`
    SELECT metadata->>'selectedBrandToolkitId' AS toolkit_id FROM chat_threads
    WHERE id = ${id} AND user_id = ${userId} LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { toolkit_id?: unknown } | undefined)?.toolkit_id);
}

export async function defaultBrandToolkitId(userId: number, queryDb: QueryDb = db): Promise<number | null> {
  const scope = currentBusinessScope();
  const result = await queryDb.execute(sql`
    SELECT id FROM brand_toolkits
    WHERE user_id = ${userId} AND is_active = true
      ${scope ? sql`AND business_profile_id = ${scope.businessProfileId}` : sql``}
    ORDER BY is_default DESC, created_at DESC
    LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { id?: unknown } | undefined)?.id);
}

export class WorkflowBrandError extends Error {
  readonly code = 'BRAND_TOOLKIT_NOT_FOUND';
  readonly status = 404;
  constructor() { super('The selected Brand Toolkit was not found in this business.'); this.name = 'WorkflowBrandError'; }
}

/** Resolve the brand to save on a new workflow. An invalid explicit choice is an error, never silently replaced. */
export async function resolveWorkflowBrandToolkitId(
  userId: number,
  options: { requestedBrandToolkitId?: unknown; threadId?: unknown } = {},
  queryDb: QueryDb = db,
): Promise<number | null> {
  const requested = options.requestedBrandToolkitId;
  if (requested !== undefined && requested !== null && requested !== '') {
    const explicit = await activeToolkitId(userId, savedBrandToolkitId(requested), queryDb);
    if (!explicit) throw new WorkflowBrandError();
    return explicit;
  }
  const fromThread = await activeToolkitId(userId, await threadSelectedBrandToolkitId(userId, options.threadId, queryDb), queryDb);
  return fromThread ?? defaultBrandToolkitId(userId, queryDb);
}

/** The brand saved on an outreach conversation (NULL for legacy rows → default brand). */
export async function conversationBrandToolkitId(userId: number, conversationId: unknown, queryDb: QueryDb = db): Promise<number | null> {
  const id = savedBrandToolkitId(conversationId);
  if (!id) return null;
  const result = await queryDb.execute(sql`
    SELECT brand_toolkit_id FROM outreach_conversations WHERE id = ${id} AND user_id = ${userId} LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { brand_toolkit_id?: unknown } | undefined)?.brand_toolkit_id);
}

/** The brand saved on the conversation that owns an outreach message (follow-up origin). */
export async function outreachMessageBrandToolkitId(userId: number, messageId: unknown, queryDb: QueryDb = db): Promise<number | null> {
  const id = savedBrandToolkitId(messageId);
  if (!id) return null;
  const result = await queryDb.execute(sql`
    SELECT c.brand_toolkit_id FROM outreach_messages m
    JOIN outreach_conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
    WHERE m.id = ${id} AND m.user_id = ${userId} LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { brand_toolkit_id?: unknown } | undefined)?.brand_toolkit_id);
}

/** The brand saved on an outreach campaign (NULL for legacy rows → default brand). */
export async function campaignBrandToolkitId(userId: number, campaignId: unknown, queryDb: QueryDb = db): Promise<number | null> {
  const id = savedBrandToolkitId(campaignId);
  if (!id) return null;
  const result = await queryDb.execute(sql`
    SELECT brand_toolkit_id FROM outreach_campaigns WHERE id = ${id} AND user_id = ${userId} LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { brand_toolkit_id?: unknown } | undefined)?.brand_toolkit_id);
}

/** The brand saved on a support ticket (NULL only when the business had no brand when it opened). */
export async function supportTicketBrandToolkitId(userId: number, ticketId: unknown, queryDb: QueryDb = db): Promise<number | null> {
  const id = savedBrandToolkitId(ticketId);
  if (!id) return null;
  const result = await queryDb.execute(sql`
    SELECT brand_toolkit_id FROM support_tickets WHERE id = ${id} AND user_id = ${userId} LIMIT 1`);
  return savedBrandToolkitId((result.rows[0] as { brand_toolkit_id?: unknown } | undefined)?.brand_toolkit_id);
}

/**
 * Resolve the brand to save on a record that belongs to a customer workflow
 * (proposal, ticket). Precedence: explicit choice, then a brand inherited
 * from the record it replaces (a proposal revision), then the parent outreach
 * conversation, then the parent support ticket, then the launching chat
 * thread, then a snapshot of the current default. Inherited brands that were
 * since deactivated are skipped; an invalid explicit choice is an error.
 */
export async function resolveRecordBrandToolkitId(
  userId: number,
  options: { requestedBrandToolkitId?: unknown; inheritedBrandToolkitId?: unknown; conversationId?: unknown; supportTicketId?: unknown; threadId?: unknown } = {},
  queryDb: QueryDb = db,
): Promise<number | null> {
  // Without a business scope the business of the new row is unknown, so a
  // candidate could belong to another of the owner's businesses (and the owner
  // trigger would reject the insert). Save no brand: the row keeps the default.
  if (!currentBusinessScope()) return null;
  const requested = options.requestedBrandToolkitId;
  if (requested !== undefined && requested !== null && requested !== '') {
    return resolveWorkflowBrandToolkitId(userId, { requestedBrandToolkitId: requested }, queryDb);
  }
  const inherited = await activeToolkitId(userId, savedBrandToolkitId(options.inheritedBrandToolkitId), queryDb);
  if (inherited) return inherited;
  const fromConversation = await activeToolkitId(userId, await conversationBrandToolkitId(userId, options.conversationId, queryDb), queryDb);
  if (fromConversation) return fromConversation;
  const fromTicket = await activeToolkitId(userId, await supportTicketBrandToolkitId(userId, options.supportTicketId, queryDb), queryDb);
  if (fromTicket) return fromTicket;
  return resolveWorkflowBrandToolkitId(userId, { threadId: options.threadId }, queryDb);
}
