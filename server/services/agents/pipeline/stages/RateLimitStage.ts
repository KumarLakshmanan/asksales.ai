import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import { logger } from '../../../../utils/logger.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { policyRulesFromConfig } from '../PolicyRuleSchema.js';

export function configuredRate(ctx: PipelineContext): { limit: number; windowSeconds: number; action: 'block' | 'escalate' } {
  const config = ctx.metadata?.agentConfig || {};
  const rule = policyRulesFromConfig(config.escalationRules)
    .find((item) => item.enabled && item.type === 'rate_limit');
  return {
    limit: rule?.type === 'rate_limit' ? rule.config.limit : 60,
    windowSeconds: rule?.type === 'rate_limit' ? rule.config.windowSeconds : 60,
    action: rule?.type === 'rate_limit' ? rule.config.action : 'block',
  };
}

export class RateLimitStage implements PipelineStage {
  name = 'RateLimit';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const { limit, windowSeconds, action } = configuredRate(ctx);
    if (ctx.message.metadata?.dryRun === true) {
      ctx.metadata = { ...ctx.metadata, rateLimit: { limit, windowSeconds, action, simulated: true } };
      return ctx;
    }

    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const senderHash = crypto.createHash('sha256')
      .update(`${ctx.message.userId}:${ctx.message.channel}:${ctx.message.senderIdentifier || ctx.message.conversationId}`)
      .digest('hex')
      .slice(0, 32);
    const bucketKey = crypto.createHash('sha256')
      .update(`${senderHash}:${windowSeconds}:${bucket}`)
      .digest('hex');
    try {
      const result = await db.execute(sql`
        INSERT INTO support_rate_limit_buckets (bucket_key, user_id, channel, request_count, expires_at)
        VALUES (${bucketKey}, ${ctx.message.userId}, ${ctx.message.channel}, 1, NOW() + (${windowSeconds} * INTERVAL '1 second'))
        ON CONFLICT (bucket_key) DO UPDATE
          SET request_count = support_rate_limit_buckets.request_count + 1
        RETURNING request_count
      `);
      const count = Number((result.rows[0] as { request_count?: number } | undefined)?.request_count || 0);
      ctx.metadata = { ...ctx.metadata, rateLimit: { limit, windowSeconds, count } };
      if (count > limit) {
        ctx.policyViolations.push({
          ruleId: 'tenant_rate_limit',
          ruleType: 'rate_limit',
          message: `Inbound AI request limit exceeded (${limit} per ${windowSeconds} seconds).`,
        });
        throw new PipelineHalt(
          'Inbound AI request rate limit exceeded.',
          ctx,
          action === 'escalate' ? 'human_handoff' : 'no_op',
        );
      }
      return ctx;
    } catch (error) {
      if (error instanceof PipelineHalt) throw error;
      logger.error({ err: error, userId: ctx.message.userId, channel: ctx.message.channel }, '[RateLimitStage] Distributed rate-limit check failed');
      throw new PipelineHalt('Inbound AI request rate limit could not be verified.', ctx, 'no_op');
    }
  }

  static async purgeExpired(): Promise<number> {
    const result = await db.execute(sql`DELETE FROM support_rate_limit_buckets WHERE expires_at < NOW() RETURNING bucket_key`);
    return result.rows.length;
  }
}
