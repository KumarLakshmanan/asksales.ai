import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { z } from "zod";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../models/db.js";
import { proposalsTable } from "../models/proposals/schema.js";
import {
  proposalService,
  ProposalWorkflowError,
} from "../services/ProposalService.js";
import {
  proposalApprovalFingerprint,
  proposalSourceContext,
  reconcileProposalExpiry,
} from "../services/ProposalWorkspaceService.js";
import { logger } from "../utils/logger.js";

export const catalogSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10000).default(""),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitPrice: z.number().finite().min(0).max(9999999999),
    unit: z.string().trim().min(1).max(50).default("unit"),
    active: z.boolean().default(true),
  })
  .strict();
export const recoverySchema = z
  .object({
    outcome: z.enum(["delivered", "not_delivered"]),
    note: z.string().trim().min(5).max(2000),
  })
  .strict();
const positive = z.coerce.number().int().positive();
function handler(fn: (req: Request, userId: number) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    if (!businessOwnerUserId(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      return res.json({ success: true, data: await fn(req, businessOwnerUserId(req)) });
    } catch (error) {
      const status =
        error instanceof ProposalWorkflowError
          ? error.statusCode
          : error instanceof z.ZodError
            ? 400
            : 500;
      logger.error({ err: error }, "Proposal workspace request failed");
      return res.status(status).json({
        error:
          status === 500
            ? "Unable to complete proposal action"
            : error instanceof Error
              ? error.message
              : "Invalid request",
      });
    }
  };
}
async function owned(userId: number, id: unknown) {
  const p = await proposalService.getProposalById(userId, positive.parse(id));
  if (!p) throw new ProposalWorkflowError("Proposal not found", 404);
  return p;
}
export const proposalSources = handler(async (req, userId) => {
  const search =
    typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "";
  const [contacts, conversations, tickets] = await Promise.all([
    db.execute(
      sql`SELECT id,concat_ws(' ',first_name,last_name) AS name,email FROM crm_contacts WHERE user_id=${userId} AND deleted_at IS NULL AND (concat_ws(' ',first_name,last_name,email) ILIKE ${"%" + search + "%"}) ORDER BY updated_at DESC LIMIT 100`,
    ),
    db.execute(
      sql`SELECT id,lead_name AS name,lead_email AS email,channel FROM outreach_conversations WHERE user_id=${userId} AND concat_ws(' ',lead_name,lead_email) ILIKE ${"%" + search + "%"} ORDER BY updated_at DESC LIMIT 100`,
    ),
    db.execute(
      sql`SELECT id,subject AS name FROM support_tickets WHERE user_id=${userId} AND deleted_at IS NULL AND subject ILIKE ${"%" + search + "%"} ORDER BY updated_at DESC LIMIT 100`,
    ),
  ]);
  return {
    contacts: contacts.rows,
    conversations: conversations.rows,
    tickets: tickets.rows,
  };
});
export const proposalResolveSource = handler(async (req, userId) => {
  const schema = z
    .object({
      contactId: positive.optional(),
      outreachConversationId: positive.optional(),
      supportTicketId: positive.optional(),
      chatThreadId: positive.optional(),
    })
    .strict();
  try {
    const result = await proposalSourceContext(userId, schema.parse(req.query));
    return {
      refs: result.refs,
      recipientName: result.recipientName,
      recipientEmail: result.recipientEmail,
    };
  } catch (error) {
    throw new ProposalWorkflowError(
      error instanceof Error ? error.message : "Invalid source",
      400,
    );
  }
});
export const proposalCatalog = handler(
  async (_req, userId) =>
    (
      await db.execute(
        sql`SELECT id,name,description,currency,unit_price::float AS "unitPrice",unit,active FROM proposal_catalog WHERE user_id=${userId} ORDER BY name LIMIT 500`,
      )
    ).rows,
);
export const saveProposalCatalog = handler(async (req, userId) => {
  const d = catalogSchema.parse(req.body);
  if (req.params.id) {
    const result = await db.execute(
      sql`UPDATE proposal_catalog SET name=${d.name},description=${d.description},currency=${d.currency},unit_price=${d.unitPrice},unit=${d.unit},active=${d.active},updated_at=NOW() WHERE id=${positive.parse(req.params.id)} AND user_id=${userId} RETURNING id`,
    );
    if (!result.rows[0])
      throw new ProposalWorkflowError("Catalog item not found", 404);
    return result.rows[0];
  }
  return (
    await db.execute(
      sql`INSERT INTO proposal_catalog(user_id,name,description,currency,unit_price,unit,active) VALUES (${userId},${d.name},${d.description},${d.currency},${d.unitPrice},${d.unit},${d.active}) RETURNING id`,
    )
  ).rows[0];
});
export const proposalTimeline = handler(async (req, userId) => {
  const p = await owned(userId, req.params.id);
  return (
    await db.execute(
      sql`SELECT id,kind,created_at AS "createdAt",processed_at AS "processedAt",last_error AS "lastError" FROM proposal_events WHERE user_id=${userId} AND proposal_id=${p.id} ORDER BY id DESC LIMIT 200`,
    )
  ).rows;
});
export const proposalVersions = handler(async (req, userId) => {
  const p = await owned(userId, req.params.id);
  return (
    await db.execute(
      sql`SELECT id,snapshot - 'publicTokenHash' - 'publicTokenExpiresAt' AS snapshot,created_at AS "createdAt" FROM proposal_versions WHERE user_id=${userId} AND proposal_id=${p.id} ORDER BY id DESC LIMIT 100`,
    )
  ).rows;
});
export const approveProposal = handler(async (req, userId) => {
  const p = await owned(userId, req.params.id);
  const review = z
    .object({ expectedRevision: positive.optional() })
    .strict()
    .parse(req.body);
  if (
    review.expectedRevision !== undefined &&
    review.expectedRevision !== p.revision
  )
    throw new ProposalWorkflowError(
      "This proposal changed. Reload and review the latest version.",
      409,
    );
  if (!["draft", "sent", "viewed"].includes(p.status))
    throw new ProposalWorkflowError("This proposal cannot be approved", 409);
  if (!p.recipientEmail)
    throw new ProposalWorkflowError(
      "Save the recipient email before approving",
      400,
    );
  const [saved] = await db
    .update(proposalsTable)
    .set({
      metadata: {
        ...p.metadata,
        approvalFingerprint: proposalApprovalFingerprint(p),
        approvedAt: new Date().toISOString(),
      },
      revision: sql`${proposalsTable.revision}+1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposalsTable.id, p.id),
        eq(proposalsTable.userId, userId),
        eq(proposalsTable.revision, p.revision),
      ),
    )
    .returning();
  if (!saved)
    throw new ProposalWorkflowError(
      "Proposal changed during review; review it again",
      409,
    );
  await db.execute(
    sql`INSERT INTO proposal_events(user_id,proposal_id,event_key,kind,payload,processed_at) VALUES(${userId},${p.id},${"approval:" + p.id + ":" + saved.updatedAt.toISOString()},'approved','{}',NOW()) ON CONFLICT DO NOTHING`,
  );
  return saved;
});
export const reviseProposal = handler(async (req, userId) => {
  const p = await owned(userId, req.params.id);
  const {
    approvalFingerprint: _fingerprint,
    approvedAt: _approved,
    onboardingTicketId: _ticket,
    ...metadata
  } = p.metadata || {};
  return proposalService.createProposal(userId, {
    title: p.title,
    coverNote: p.coverNote || undefined,
    recipientName: p.recipientName || undefined,
    recipientEmail: p.recipientEmail || undefined,
    contactId: p.contactId || undefined,
    leadId: p.leadId || undefined,
    outreachConversationId: p.outreachConversationId || undefined,
    chatThreadId: p.chatThreadId || undefined,
    supportTicketId: p.metadata?.supportTicketId || undefined,
    currency: p.currency || "USD",
    signatureRequired: !!p.signatureRequired,
    discountType: p.discountType,
    discountValue: Number(p.discountValue || 0),
    taxRate: Number(p.taxRate || 0),
    validUntil:
      p.validUntil && new Date(p.validUntil) > new Date()
        ? new Date(p.validUntil)
        : undefined,
    termsAndConditions: p.termsAndConditions || undefined,
    showTermsAndConditions: !!p.showTermsAndConditions,
    lineItems: p.lineItems.map((item: Record<string, unknown>) => ({
      name: String(item.name),
      description: String(item.description || ""),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      unit: String(item.unit),
      discount: Number(item.discount || 0),
    })),
    metadata: { ...metadata, revisionOf: p.id },
    approvalRequired: true,
    autoOnboard: p.metadata?.autoOnboard !== false,
  });
});
export const recoverProposalDelivery = handler(async (req, userId) => {
  const p = await owned(userId, req.params.id),
    d = recoverySchema.parse(req.body);
  if (p.status !== "delivery_unknown")
    throw new ProposalWorkflowError(
      "Only uncertain deliveries can be reconciled",
      409,
    );
  const [saved] = await db
    .update(proposalsTable)
    .set({
      status: d.outcome === "delivered" ? "sent" : "draft",
      sentAt: d.outcome === "delivered" ? new Date() : p.sentAt,
      ...(d.outcome === "not_delivered"
        ? { publicTokenHash: null, publicTokenExpiresAt: null }
        : {}),
      metadata: {
        ...p.metadata,
        deliveryReview: {
          outcome: d.outcome,
          note: d.note,
          reviewedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposalsTable.id, p.id),
        eq(proposalsTable.userId, userId),
        eq(proposalsTable.status, "delivery_unknown"),
      ),
    )
    .returning();
  if (!saved) throw new ProposalWorkflowError("Delivery status changed", 409);
  return saved;
});
export const proposalRelated = handler(async (req, userId) => {
  const filters = z
    .object({
      contactId: positive.optional(),
      outreachConversationId: positive.optional(),
      supportTicketId: positive.optional(),
    })
    .strict()
    .parse(req.query);
  if (!Object.values(filters).some(Boolean))
    throw new ProposalWorkflowError("Select a customer or conversation", 400);
  await reconcileProposalExpiry(userId);
  return (
    await db.execute(sql`SELECT id,title,status,currency,total FROM proposals WHERE user_id=${userId}
    ${filters.contactId ? sql`AND contact_id=${filters.contactId}` : sql``}
    ${filters.outreachConversationId ? sql`AND outreach_conversation_id=${filters.outreachConversationId}` : sql``}
    ${filters.supportTicketId ? sql`AND (metadata->>'supportTicketId'=${String(filters.supportTicketId)} OR metadata->>'onboardingTicketId'=${String(filters.supportTicketId)})` : sql``}
    ORDER BY updated_at DESC LIMIT 30`)
  ).rows;
});
export const proposalPerformance = handler(async (req, userId) => {
  const query = z
    .object({
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      group: z.enum(["template", "campaign", "owner"]).default("template"),
    })
    .strict()
    .parse(req.query);
  const group =
    query.group === "template"
      ? sql`COALESCE(t.name,p.metadata->'templateSnapshot'->>'name','No template')`
      : query.group === "owner"
        ? sql`COALESCE(owner.name,'Unassigned')`
        : sql`COALESCE(campaign.name,'No campaign')`;
  if (query.from && query.to && query.from > query.to)
    throw new ProposalWorkflowError("Start date must be before end date", 400);
  await reconcileProposalExpiry(userId);
  return (
    await db.execute(sql`SELECT ${group} AS label,p.currency,count(*)::int AS total,
    count(*) FILTER(WHERE p.sent_at IS NOT NULL)::int AS sent,count(*) FILTER(WHERE p.viewed_at IS NOT NULL)::int AS viewed,
    count(*) FILTER(WHERE p.status='accepted')::int AS accepted,count(*) FILTER(WHERE p.status='rejected')::int AS rejected,
    COALESCE(sum(p.total::numeric) FILTER(WHERE p.status='accepted'),0)::float AS "acceptedValue"
    FROM proposals p LEFT JOIN proposal_templates t ON t.id=p.template_id LEFT JOIN crm_contacts c ON c.id=p.contact_id AND c.user_id=p.user_id
    LEFT JOIN users owner ON owner.id=c.assigned_to
    LEFT JOIN LATERAL (SELECT campaign.name FROM outreach_messages m JOIN outreach_campaigns campaign ON campaign.id=m.campaign_id AND campaign.user_id=p.user_id WHERE m.conversation_id=p.outreach_conversation_id AND m.user_id=p.user_id ORDER BY m.created_at DESC LIMIT 1) campaign ON TRUE
    WHERE p.user_id=${userId} ${query.from ? sql`AND p.created_at >= ${query.from}::date` : sql``} ${query.to ? sql`AND p.created_at < ${query.to}::date + INTERVAL '1 day'` : sql``}
    GROUP BY 1,p.currency ORDER BY total DESC LIMIT 100`)
  ).rows;
});

