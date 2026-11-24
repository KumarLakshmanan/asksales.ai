import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import {
  proposalTemplatesTable,
  type ProposalTemplateContent,
} from "../models/proposalTemplates/schema.js";
import { validateProposalTemplate } from "../../shared/proposalTemplateRules.js";
import { materializeProposalTemplate } from "../../shared/proposals.js";

type Template = typeof proposalTemplatesTable.$inferSelect;
export type AdminTemplateInput = {
  name: string;
  category?: string;
  description?: string;
  published: boolean;
  includeKnowledgeBase?: boolean;
  includeBusinessProfile?: boolean;
  coverNote?: string;
  lineItems?: Template["lineItems"];
  termsAndConditions?: string;
  templateContent?: ProposalTemplateContent;
  replaceTemplateId?: number;
  expectedVersion?: number;
};
export class TemplateLibraryError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: string[],
  ) {
    super(message);
  }
}

export class AdminProposalTemplateService {
  constructor(private database = db) {}

  async list() {
    return this.database
      .select()
      .from(proposalTemplatesTable)
      .where(isNull(proposalTemplatesTable.userId))
      .orderBy(desc(proposalTemplatesTable.updatedAt));
  }

  private async find(tx: typeof db, id: number): Promise<Template> {
    const [template] = await tx
      .select()
      .from(proposalTemplatesTable)
      .where(
        and(
          eq(proposalTemplatesTable.id, id),
          isNull(proposalTemplatesTable.userId),
        ),
      )
      .limit(1);
    if (!template) throw new TemplateLibraryError("Template not found", 404);
    return template;
  }

  private async audit(
    tx: typeof db,
    template: Template,
    actorId: number | null,
    action: string,
  ) {
    await tx.execute(
      sql`INSERT INTO proposal_template_audit(template_id,admin_id,action,snapshot) VALUES (${template.id},${actorId},${action},${JSON.stringify(template)}::jsonb)`,
    );
  }

  private async ensureBaseline(tx: typeof db, template: Template) {
    await tx.execute(sql`INSERT INTO proposal_template_audit(template_id,admin_id,action,snapshot)
      SELECT ${template.id},NULL,'version_baseline',${JSON.stringify(template)}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM proposal_template_audit WHERE template_id=${template.id} AND snapshot->>'version'=${String(template.version)})`);
  }

  async history(id: number) {
    await this.find(this.database, id);
    const result = await this.database
      .execute(sql`SELECT a.id,a.admin_id AS "adminId",a.action,a.snapshot,a.created_at AS "createdAt"
      FROM proposal_template_audit a JOIN proposal_templates t ON t.id=a.template_id
      WHERE t.id=${id} AND t.user_id IS NULL ORDER BY a.id DESC LIMIT 100`);
    return result.rows;
  }

  private async saveInTransaction(
    tx: typeof db,
    input: AdminTemplateInput,
    actorId: number,
    existing: Template | null,
    action: string,
  ) {
    if (!Number.isSafeInteger(actorId) || actorId < 1)
      throw new TemplateLibraryError("Admin authentication is required", 401);
    if (
      input.expectedVersion !== undefined &&
      existing?.version !== input.expectedVersion
    )
      throw new TemplateLibraryError(
        "This template changed while you were editing. Reload its latest version before saving.",
        409,
      );
    const errors = validateProposalTemplate(input, input.published);
    if (errors.length)
      throw new TemplateLibraryError(
        "Complete the template before saving",
        400,
        errors,
      );
    if (
      input.replaceTemplateId &&
      (!input.published ||
        existing?.published ||
        input.replaceTemplateId === existing?.id)
    )
      throw new TemplateLibraryError(
        "Choose a published template to replace when publishing a new library slot.",
        400,
      );
    const replacement = input.replaceTemplateId
      ? await this.find(tx, input.replaceTemplateId)
      : null;
    if (replacement && !replacement.published)
      throw new TemplateLibraryError(
        "The replacement template is no longer published. Reload the library and choose an available slot.",
        409,
      );
    if (input.published) {
      const count = await tx.execute(
        sql`SELECT count(*)::int AS n FROM proposal_templates WHERE user_id IS NULL AND published AND id<>${existing?.id || 0}`,
      );
      if (Number(count.rows[0]?.n || 0) - (replacement ? 1 : 0) >= 10)
        throw new TemplateLibraryError(
          "All 10 library slots are occupied. Choose a published template to replace.",
          409,
        );
    }
    // Every check precedes mutation; replacement, publication, and both audit records commit together.
    if (existing) await this.ensureBaseline(tx, existing);
    if (replacement) {
      await this.ensureBaseline(tx, replacement);
      const [retired] = await tx
        .update(proposalTemplatesTable)
        .set({
          published: false,
          version: replacement.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proposalTemplatesTable.id, replacement.id),
            isNull(proposalTemplatesTable.userId),
          ),
        )
        .returning();
      await this.audit(tx, retired, actorId, "replaced");
    }
    const data = {
      name: input.name.trim(),
      category: input.category?.trim() || "General",
      description: input.description || "",
      published: input.published,
      templateType: "document",
      isDefault: false,
      includeKnowledgeBase: input.includeKnowledgeBase !== false,
      includeBusinessProfile: input.includeBusinessProfile !== false,
      coverNote: input.coverNote ?? existing?.coverNote ?? null,
      lineItems: input.lineItems ?? existing?.lineItems ?? [],
      termsAndConditions:
        input.termsAndConditions ?? existing?.termsAndConditions ?? null,
      templateContent: input.templateContent!,
      version: (existing?.version || 0) + 1,
      updatedAt: new Date(),
    };
    const [saved] = existing
      ? await tx
          .update(proposalTemplatesTable)
          .set(data)
          .where(
            and(
              eq(proposalTemplatesTable.id, existing.id),
              isNull(proposalTemplatesTable.userId),
            ),
          )
          .returning()
      : await tx
          .insert(proposalTemplatesTable)
          .values({ ...data, userId: null })
          .returning();
    await this.audit(tx, saved, actorId, action);
    return saved as Template;
  }

  async save(input: AdminTemplateInput, actorId: number, id?: number) {
    return this.database.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(248001)`);
      return this.saveInTransaction(
        tx,
        input,
        actorId,
        id ? await this.find(tx, id) : null,
        id ? "updated" : "created",
      );
    });
  }

  async rollback(
    id: number,
    historyId: number,
    actorId: number,
    expectedVersion: number,
    replaceTemplateId?: number,
  ) {
    return this.database.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(248001)`);
      const current = await this.find(tx, id);
      const history = await tx.execute(
        sql`SELECT snapshot FROM proposal_template_audit WHERE id=${historyId} AND template_id=${id} LIMIT 1`,
      );
      const snapshot = history.rows[0]?.snapshot as Template | undefined;
      if (!snapshot || snapshot.id !== id || snapshot.userId !== null)
        throw new TemplateLibraryError("Template version not found", 404);
      const input: AdminTemplateInput = {
        name: snapshot.name,
        category: snapshot.category || "General",
        description: snapshot.description || "",
        published: snapshot.published,
        includeKnowledgeBase: snapshot.includeKnowledgeBase !== false,
        includeBusinessProfile: snapshot.includeBusinessProfile !== false,
        templateContent: snapshot.templateContent
          ? {
              ...snapshot.templateContent,
              sections: materializeProposalTemplate(
                snapshot.templateContent.sections,
                {},
              ).sections,
            }
          : undefined,
        coverNote: snapshot.coverNote || "",
        termsAndConditions: snapshot.termsAndConditions || "",
        lineItems: snapshot.lineItems || [],
        expectedVersion,
        replaceTemplateId,
      };
      return this.saveInTransaction(
        tx,
        input,
        actorId,
        current,
        `rolled_back_to_v${snapshot.version}`,
      );
    });
  }
}

export const adminProposalTemplateService = new AdminProposalTemplateService();
