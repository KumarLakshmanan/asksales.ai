/** Only mapped CSV columns may change an existing contact. A mapped blank cell
 * clears a nullable field; an unmapped column is never an implicit clear. */
export function crmImportPatch(mapped: Record<string, string | null>, mapping: Record<string, string>, stageKey: string) {
  const targets = new Set(Object.values(mapping));
  const patch: Record<string, unknown> = {};
  for (const field of ['firstName', 'lastName', 'phone', 'company', 'role', 'linkedinUrl', 'website', 'notes', 'dealValue']) {
    if (targets.has(field)) patch[field] = mapped[field] || null;
  }
  if (targets.has('tags')) patch.tags = (mapped.tags || '').split(/[,;]/).map(tag => tag.trim()).filter(Boolean);
  if (targets.has('status') && mapped.status) patch.pipelineStatus = stageKey;
  return patch;
}
