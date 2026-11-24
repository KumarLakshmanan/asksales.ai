import type { PipelineContext } from "./ChannelGateway.js";

export interface PipelineStage {
  name: string;
  execute(ctx: PipelineContext): Promise<PipelineContext>;
}

export class PipelineHalt extends Error {
  constructor(public reason: string, public ctx: PipelineContext, public outcome: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error') {
    super(reason);
    Object.setPrototypeOf(this, PipelineHalt.prototype);
  }
}
