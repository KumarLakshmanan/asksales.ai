import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { sentimentAnalysisService } from "../../../SentimentAnalysisService.js";
import { db } from "../../../../models/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../../utils/logger.js";

export class SentimentStage implements PipelineStage {
  name = "SentimentAnalysis";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const { userId, inboundText, rawMessageId } = ctx.message;
    if (!inboundText || !inboundText.trim()) return ctx;

    try {
      // NLU already evaluates sentiment with conversation context. Reuse it,
      // including unavailable/fail-closed results; don't make a second model
      // call that could contradict that same turn's classification.
      const sentiment = ctx.nlu
        ? { sentiment: ctx.nlu.sentiment.label, score: ctx.nlu.sentiment.score, keywords: [] }
        : await sentimentAnalysisService.analyzeSentiment(userId, inboundText);
      ctx.sentiment = {
        sentiment: sentiment.sentiment,
        score: sentiment.score,
        keywords: sentiment.keywords,
      };

      // Persist on database message row if rawMessageId is present
      if (rawMessageId && ctx.message.metadata?.dryRun !== true) {
        await db.execute(sql`
          UPDATE outreach_messages 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            sentiment: sentiment.sentiment,
            sentimentScore: sentiment.score,
            sentimentKeywords: sentiment.keywords,
          })}::jsonb,
          updated_at = NOW()
          WHERE waba_message_id = ${rawMessageId} AND user_id = ${userId}
        `);
      }

      // Sentiment is evidence for the final decision, never authority for a
      // business write. Ticket creation must be proposed by the specialist and
      // committed by the canonical effect stage after delivery/approval.
    } catch (err) {
      logger.error({ err }, '[SentimentStage] Sentiment analysis failed');
      // Default to neutral on failure (non-blocking)
      ctx.sentiment = { sentiment: 'neutral', score: 0, keywords: [] };
    }

    return ctx;
  }
}
