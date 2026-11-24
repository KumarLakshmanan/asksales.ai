import { whatsappTemplateRejectionReason } from '../../../shared/whatsappTemplateStatus';

export function whatsappTemplateControls(template: {
  wabaTemplateId?: string | null; metaStatus?: string | null; status?: string;
  submissionStatus?: string; hasLocalChanges?: boolean; metaRejectionReason?: string | null;
}) {
  const linked = Boolean(template.wabaTemplateId);
  const meta = String(template.metaStatus || template.status || '').toUpperCase();
  const uncertain = ['submitting', 'submission_uncertain'].includes(template.submissionStatus || '');
  const waiting = linked && meta === 'PENDING';
  return {
    feedbackReason: (meta === 'REJECTED' || template.submissionStatus === 'submission_failed')
      ? whatsappTemplateRejectionReason(template.metaRejectionReason) : null,
    linked,
    canEdit: !uncertain && !waiting,
    canSubmit: template.submissionStatus !== 'identity_conflict' && !uncertain && !waiting && (!linked || (['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'].includes(meta)
      && (meta !== 'APPROVED' || template.hasLocalChanges === true))),
    categoryLocked: linked && meta === 'APPROVED',
    notice: template.submissionStatus === 'identity_conflict' ? 'Review the connected business account and template identity before submitting.'
      : uncertain ? 'Sync with Meta before editing or retrying this submission.'
      : waiting ? 'Meta is reviewing this template. Sync its status before making further changes.'
        : linked ? 'Name and language are fixed for a Meta-linked template. Local changes need a new Meta review before use.' : null,
  };
}
