import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { localizeGovernedReply, looksEnglish, replyTargetLanguage } from '../../orchestration/ReplyLanguage.js';
import { logger } from '../../../../utils/logger.js';

/** Localizes fixed English replies (fallbacks, clarifications, handoff
 * offers, booking links) for customers writing in another language.
 * Grounded knowledge answers already choose their language and are left
 * untouched, as are replies a playbook requires to contain exact phrases.
 * Any translation or review failure keeps the English reply. */
export class ReplyLanguageStage implements PipelineStage {
  name = 'ReplyLanguage';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const result = ctx.agentResult;
    const original = result?.replyText;
    if (!result || !original?.trim()) return ctx;
    const language = replyTargetLanguage(ctx.nlu?.customerLanguage);
    if (!language || result.answerVerification || !looksEnglish(original)) return ctx;
    const directive = ctx.metadata?.playbookDirective;
    if (directive?.compliance?.requiredPhrases?.length) return ctx;
    const verbatim = directive?.compliance?.verbatim;
    if (verbatim && verbatim !== original) return ctx;

    const translated = await localizeGovernedReply({ userId: ctx.message.userId, text: original, language });
    if (!translated) {
      ctx.metadata = { ...ctx.metadata, replyLanguage: { target: language.code, status: 'kept_english' } };
      logger.info({ conversationId: ctx.message.conversationId, language: language.code }, '[ReplyLanguage] Translation not verified; keeping English reply');
      return ctx;
    }
    result.replyText = translated;
    if (verbatim) directive.compliance = { ...directive.compliance, verbatim: translated };
    ctx.metadata = { ...ctx.metadata, replyLanguage: { target: language.code, status: 'translated' } };
    return ctx;
  }
}
