import { expect, it } from '@jest/globals';
import { createConversationClarification, answersPendingClarification, readPendingClarification } from '../mastra/conversationClarification.js';
import type { RouterOutput } from '../mastra/routerSchema.js';

it('persists the field and owned resume target and answers only the matching question', () => {
  const pending = createConversationClarification({currentAgent:'lead_generation',runContext:{userId:1,threadId:2,runId:'saved-run',actionId:'review-1'}},
    {response:'Which platform?',clarification:{requiredField:'lead.platform',answersQuestionId:null}} as RouterOutput,33);
  expect(readPendingClarification(pending)).toEqual(pending);
  expect(pending).toMatchObject({requiredField:'lead.platform',sourceMessageId:33,resumeTarget:{agent:'lead_generation',runId:'saved-run',actionId:'review-1'}});
  expect(answersPendingClarification(pending,{action:'question'} as RouterOutput)).toBe(false);
  expect(answersPendingClarification(pending,{clarification:{answersQuestionId:pending.id},needsClarification:false} as RouterOutput)).toBe(true);
  expect(answersPendingClarification(pending,{clarification:{answersQuestionId:'different'},needsClarification:false} as RouterOutput)).toBe(false);
  expect(readPendingClarification({id:pending.id,status:'answered'})).toBeUndefined();
});
