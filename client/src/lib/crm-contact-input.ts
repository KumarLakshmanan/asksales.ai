import { isEmailAddress } from '../../../shared/emailAddress';
// Callers retain their own create/partial-edit requirements and display copy.
// These shared predicates accept already-normalized field values.
export const validContactEmail = (value: string) =>
  !value || isEmailAddress(value);
export const validContactAmount = (value: string) =>
  !value || /^\d{1,10}(\.\d{1,2})?$/.test(value);
