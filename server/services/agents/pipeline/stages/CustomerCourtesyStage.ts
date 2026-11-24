import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { customerCourtesy } from '../../orchestration/CustomerTurnUnderstanding.js';
import { cancelAssistantFollowUps } from '../../../assistants/AssistantFollowUps.js';
import { UNCHANGED_CRM_DECISION } from '../../../../../shared/crmPipeline.js';

export class CustomerCourtesyStage implements PipelineStage {
  name='CustomerCourtesy';
  async execute(ctx:PipelineContext):Promise<PipelineContext>{
    if(ctx.metadata?.skipAgentGeneration||ctx.metadata?.activeHandoff||ctx.metadata?.suspendPlaybookForHandoff
      ||ctx.metadata?.verifiedHandoffConsent||ctx.metadata?.activePlaybookSelection
      ||ctx.message.metadata?.publicReply||ctx.message.channel.endsWith('_comment')
      ||ctx.message.metadata?.executionMode==='advisory'||ctx.message.metadata?.forceApproval===true)return ctx;
    const courtesy=customerCourtesy(ctx.message.inboundText);
    if(!courtesy)return ctx;
    // Stop only this enquiry's unsent assistant check-ins, never global opt-in,
    // bookings, staff ownership or other contacts. Later messages can continue.
    if(courtesy.closeEnquiry && ctx.message.metadata?.executionMode==='customer'&&!ctx.message.metadata?.dryRun)
      await cancelAssistantFollowUps(ctx.message.conversationId,'customer_declined_enquiry');
    ctx.nlu={intent:'smalltalk',secondaryIntents:[],entities:{},needsHuman:false,
      semanticRequest:{action:'other',service:'general',explicit:false,topicSwitch:false,pricingRequested:false,media:'none',confidence:1},
      sentiment:{label:'neutral',score:0},urgency:'low',riskLevel:'low',riskFactors:[],classificationConfidence:1,
      summary:'The customer acknowledged or politely declined this enquiry.',crmStageDecision:{...UNCHANGED_CRM_DECISION}};
    ctx.agentResult={replyText:courtesy.replyText,confidence:1,escalated:false,groundingStatus:'not_required',
      handoff:{required:false},effectProposals:[],toolCallsExecuted:[]};
    ctx.confidence=1;
    ctx.metadata={...ctx.metadata,customerCourtesy:courtesy.closeEnquiry?'declined':'acknowledged',
      skipAgentGeneration:true,suppressBusinessEffects:true,suppressAssistantFollowUp:true};
    return ctx;
  }
}
