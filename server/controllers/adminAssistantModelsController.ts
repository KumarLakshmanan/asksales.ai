import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { getAdminCredentialsByPlatform, LLM_ADMIN_PLATFORMS, sortActiveCredentials } from '../models/adminApiCredentials/functions.js';
import { assistantModelConnections, getManagedAssistantModels, mergeAssistantModelCatalog, modelConnectionReady } from '../services/assistants/AssistantModelCatalogService.js';
import { ASSISTANT_MODEL_PROVIDERS } from '../../shared/assistantModelCatalog.js';
import { normalizeLLMModelName } from '../utils/llmConstants.js';
import { logger } from '../utils/logger.js';

const modelInput = z.object({
  provider: z.enum(ASSISTANT_MODEL_PROVIDERS),
  credentialId: z.number().int().positive(),
  model: z.string().trim().min(1).max(250).regex(/^\S+$/, 'Model ID must not contain spaces'),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(10000),
  expectedVersion: z.number().int().min(0),
  original: z.object({ provider: z.enum(ASSISTANT_MODEL_PROVIDERS), model: z.string().trim().min(1).max(250) }).strict().optional(),
}).strict();
async function allModelCredentials() {
  const groups = await Promise.all(LLM_ADMIN_PLATFORMS.map(provider => getAdminCredentialsByPlatform(provider)));
  const rows = groups.flat();
  const active = sortActiveCredentials(rows);
  return [...active, ...rows.filter(row => !row.isActive)];
}
export async function getAdminAssistantModels(req: Request, res: Response) {
  try {
    const [credentials, managed] = await Promise.all([allModelCredentials(), getManagedAssistantModels()]);
    return res.json({ models: mergeAssistantModelCatalog(credentials, managed), connections: assistantModelConnections(credentials),
      canManage: req.user?.role === 'super_admin' });
  } catch (error) {
    logger.error({ err: error }, 'Unable to read assistant model catalog');
    return res.status(503).json({ error: 'Model catalog could not be loaded. Try again.' });
  }
}
class CatalogConflict extends Error {}
export async function saveAdminAssistantModel(req: Request, res: Response) {
  const parsed = modelInput.safeParse(req.body);
  const id = req.params.id === undefined ? null : Number(req.params.id);
  if (!parsed.success || (id !== null && (!Number.isSafeInteger(id) || id < 1)))
    return res.status(400).json({ error: parsed.success ? 'Invalid model entry' : parsed.error.issues[0]?.message || 'Invalid model configuration' });
  const input = parsed.data;
  input.model = normalizeLLMModelName(input.provider, input.model);
  try {
    const credentials = await allModelCredentials();
    const connection = credentials.find(item => item.id === input.credentialId && item.platform === input.provider);
    if (!connection || (input.enabled && !modelConnectionReady(connection)))
      return res.status(400).json({ error: 'Choose a configured connection for this provider before enabling the model.' });
    const result = await db.transaction(async (tx: typeof db) => {
      // Catalog entries are global. Serialize create/rename operations so
      // version conflicts and provider/model identity are checked together.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(20261019,327)`);
      const rows = await getManagedAssistantModels(tx);
      const existing = id === null ? undefined : rows.find(row => row.id === id);
      const original = input.original;
      const legacy = original && id === null ? mergeAssistantModelCatalog(credentials, rows)
        .find(row => row.provider === original.provider && row.model === original.model) : undefined;
      if (original && id === null && (!legacy || legacy.id !== null))
        throw new CatalogConflict('This model changed. Reload the catalog before saving.');
      if (id !== null && (!existing || existing.version !== input.expectedVersion))
        throw new CatalogConflict('This model changed. Reload the catalog before saving.');
      const duplicate = rows.find(row => row.provider === input.provider && row.model === input.model && row.id !== id);
      if (duplicate) throw new CatalogConflict('This provider and model ID already exist. Edit that entry instead.');
      const sameLabel = mergeAssistantModelCatalog(credentials, rows).find(row => (id === null || row.id !== id)
        && !(row.provider === input.provider && row.model === input.model)
        && !(legacy && row.provider === legacy.provider && row.model === legacy.model)
        && row.label.toLowerCase() === input.label.toLowerCase());
      if (sameLabel) throw new CatalogConflict('Choose a distinct display name so assistants can identify this model.');
      if (id === null && input.expectedVersion !== 0) throw new CatalogConflict('Reload the catalog before saving.');
      if (legacy && (legacy.provider !== input.provider || legacy.model !== input.model)) {
        await tx.execute(sql`INSERT INTO assistant_model_catalog(provider,model,label,description,enabled,display_order,credential_id,updated_by)
          VALUES(${legacy.provider},${legacy.model},${legacy.label},${legacy.description},false,${legacy.order},${legacy.credentialId},${Number(req.user?.id)})`);
      }
      // A changed identity is a new entry. Retain a disabled original so old
      // published selections cannot silently resolve through legacy settings.
      const changedIdentity = existing && (existing.provider !== input.provider || existing.model !== input.model);
      if (changedIdentity) await tx.execute(sql`UPDATE assistant_model_catalog SET enabled=false,version=version+1,updated_at=NOW(),updated_by=${Number(req.user?.id)} WHERE id=${id}`);
      const saved = id === null || changedIdentity
        ? await tx.execute(sql`INSERT INTO assistant_model_catalog(provider,model,label,description,enabled,display_order,credential_id,updated_by)
          VALUES(${input.provider},${input.model},${input.label},${input.description},${input.enabled},${input.order},${input.credentialId},${Number(req.user?.id)}) RETURNING id`)
        : await tx.execute(sql`UPDATE assistant_model_catalog SET label=${input.label},description=${input.description},enabled=${input.enabled},
          display_order=${input.order},credential_id=${input.credentialId},version=version+1,updated_at=NOW(),updated_by=${Number(req.user?.id)} WHERE id=${id} RETURNING id`);
      await tx.execute(sql`INSERT INTO admin_credential_audit(credential_id,platform,action,admin_id,changed_fields,message)
        VALUES(${input.credentialId},${input.provider},'update',${Number(req.user?.id)},${JSON.stringify(['assistant_model_catalog'])}::jsonb,'Assistant model catalog updated')`);
      return saved.rows[0];
    });
    return res.status(id === null ? 201 : 200).json({ success: true, id: Number(result.id) });
  } catch (error) {
    if (error instanceof CatalogConflict) return res.status(409).json({ error: error.message });
    logger.error({ err: error }, 'Unable to save assistant model');
    return res.status(500).json({ error: 'Model could not be saved. Try again.' });
  }
}
