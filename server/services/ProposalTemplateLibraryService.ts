import { sql } from "drizzle-orm";
import { db } from "../models/db.js";

export async function getFavoriteProposalTemplateIds(userId: number) {
  const result = await db.execute(sql`
    SELECT f.template_id AS id FROM proposal_template_favorites f
    JOIN proposal_templates t ON t.id=f.template_id
    WHERE f.user_id=${userId} AND (t.user_id=${userId} OR (t.user_id IS NULL AND t.published))
    ORDER BY f.created_at DESC`);
  return result.rows.map((row: { id: number }) => row.id);
}

export async function setProposalTemplateFavorite(
  userId: number,
  templateId: number,
  favorite: boolean,
) {
  if (!favorite) {
    await db.execute(
      sql`DELETE FROM proposal_template_favorites WHERE user_id=${userId} AND template_id=${templateId}`,
    );
    return { templateId, favorite: false };
  }
  // The access check and insert are one statement; private templates and unpublished standards cannot be added.
  const result = await db.execute(sql`
    INSERT INTO proposal_template_favorites(user_id,template_id)
    SELECT ${userId},id FROM proposal_templates
    WHERE id=${templateId} AND (user_id=${userId} OR (user_id IS NULL AND published))
    ON CONFLICT(business_profile_id, user_id,template_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING template_id`);
  return result.rows.length ? { templateId, favorite: true } : null;
}
