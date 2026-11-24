import type { CrmConfiguration } from '../../shared/crmConfiguration.js';
import { crmContactStatusForStage } from '../../shared/crmPipeline.js';

export interface InboundReplyTransition {
  status: string;
  pipelineStatus: string;
}

const TERMINAL_STATUSES = new Set(['won', 'lost', 'converted', 'rejected']);
const EARLY_PIPELINE_STAGES = new Set(['new', 'contacted']);

/**
 * Advance a CRM contact after a genuine inbound reply without regressing
 * contacts that are already further through (or finished with) the pipeline.
 */
export function getInboundReplyTransition(
  status: string | null | undefined,
  pipelineStatus: string | null | undefined,
  configuration?: CrmConfiguration,
): InboundReplyTransition {
  const currentStatus = status || 'new';
  const currentPipelineStatus = pipelineStatus || 'new';
  if (configuration) {
    const current = configuration.stages.find(stage => stage.key === currentPipelineStatus);
    if (current?.type === 'won' || current?.type === 'lost') {
      return { status: crmContactStatusForStage(current, currentStatus), pipelineStatus: current.key };
    }
    const replyStage = configuration.stages.find(stage => stage.key === 'interested' && stage.type === 'active')
      || configuration.stages.find(stage => stage.type === 'active');
    if (TERMINAL_STATUSES.has(currentStatus) || !replyStage || (current?.type !== 'entry' && currentPipelineStatus !== 'contacted')) {
      return { status: currentStatus, pipelineStatus: currentPipelineStatus };
    }
    return { status: currentStatus === 'contacted' ? 'interested' : 'replied', pipelineStatus: replyStage.key };
  }

  if (
    TERMINAL_STATUSES.has(currentStatus) ||
    TERMINAL_STATUSES.has(currentPipelineStatus) ||
    !EARLY_PIPELINE_STAGES.has(currentPipelineStatus)
  ) {
    return {
      status: currentStatus,
      pipelineStatus: currentPipelineStatus,
    };
  }

  return {
    status: currentStatus === 'contacted' ? 'interested' : 'replied',
    pipelineStatus: 'interested',
  };
}
