import type { PlaybookFieldState } from '../../../models/supportOrchestration/schema.js';

/** Operational references only: no raw contact values and no CRM identity write.
 * Token and vault must remain paired; the existing audited vault reader still
 * enforces tenant/conversation authorization when an operator reveals a value. */
export function supportContactReferences(fields?: Record<string, PlaybookFieldState>) {
  return ['contact.fullName', 'callback.preferredPhone'].flatMap(fieldKey => {
    const field = fields?.[fieldKey];
    const pattern = fieldKey === 'contact.fullName' ? /^\[NAME_\d+\]$/ : /^\[PHONE_\d+\]$/;
    if (!field || !['collected', 'verified'].includes(field.status)
      || typeof field.value !== 'string' || !pattern.test(field.value)
      || !Number.isSafeInteger(field.vaultRef) || Number(field.vaultRef) <= 0) return [];
    return [{ fieldKey, placeholder: field.value, vaultRef: field.vaultRef! }];
  });
}
