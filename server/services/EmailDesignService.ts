import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../models/db.js';
import { outreachSettings } from '../models/outreachSettings/schema.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { DEFAULT_EMAIL_DESIGN_PREFERENCES, isEmailDesignId, type EmailDesignPreferences, type EmailDesignId } from '../../shared/emailDesigns.js';
import { getBrandInfo, renderBrandedEmail } from '../utils/emailTemplates.js';

export async function getEmailDesignPreferences(userId: number): Promise<EmailDesignPreferences> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Invalid email design scope');
  const [row] = await db.select({ preferences: outreachSettings.emailDesignPreferences }).from(outreachSettings)
    .where(and(eq(outreachSettings.userId, userId), eq(outreachSettings.businessProfileId, scope.businessProfileId)));
  return row?.preferences ?? { ...DEFAULT_EMAIL_DESIGN_PREFERENCES };
}
export async function saveEmailDesignPreferences(userId: number, preferences: EmailDesignPreferences): Promise<EmailDesignPreferences | null> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId || !isEmailDesignId(preferences.outreach) || !isEmailDesignId(preferences.assistant)) throw new Error('Invalid email design preferences');
  return db.transaction(async (tx: typeof db) => {
    await tx.insert(outreachSettings).values({ userId, businessProfileId: scope.businessProfileId, enableAutoFollowUp: false }).onConflictDoNothing();
    const where = and(eq(outreachSettings.userId, userId), eq(outreachSettings.businessProfileId, scope.businessProfileId));
    const [row] = await tx.select().from(outreachSettings).where(where).for('update');
    const current = row.emailDesignPreferences ?? DEFAULT_EMAIL_DESIGN_PREFERENCES;
    if (current.revision !== preferences.revision) return null;
    const saved = { outreach: preferences.outreach, assistant: preferences.assistant, revision: randomUUID() };
    await tx.update(outreachSettings).set({ emailDesignPreferences: saved, updatedAt: new Date() }).where(where);
    return saved;
  });
}
/** Call before storing a durable send intent so retries retain its reviewed HTML. */
/** brandToolkitId is the brand saved on the workflow; omit it only for items without one. */
export async function prepareDesignedEmail(userId: number, body: string, kind: 'outreach' | 'assistant', requestedDesign?: EmailDesignId, brandToolkitId?: number | null): Promise<string> {
  if (/<!doctype\s+html/i.test(body) && requestedDesign === undefined) return body;
  const preferences = await getEmailDesignPreferences(userId);
  const content = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? body;
  return renderBrandedEmail({ brand: await getBrandInfo(userId, brandToolkitId), body: content, designId: requestedDesign ?? preferences[kind] });
}
