import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { ProposalWorkflowError } from '../services/ProposalService.js';
import { proposalLifecycleService } from '../services/ProposalLifecycleService.js';

const positive = z.coerce.number().int().positive();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicFeedbackSchema = z.object({
  kind: z.enum(['question', 'change_request']),
  content: z.string().trim().min(1).max(10_000),
  authorName: z.string().trim().max(255).optional(),
  requestKey: z.string().trim().min(8).max(100),
}).strict();
const sellerReplySchema = z.object({ content: z.string().trim().min(1).max(10_000) }).strict();
const resolveSchema = z.object({ resolved: z.boolean() }).strict();
const revisionSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
  feedbackId: z.number().int().positive().optional(),
  draftKey: z.string().trim().min(8).max(100).optional(),
}).strict();
const followupSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  steps: z.array(z.object({
    afterDays: z.number().int().min(1).max(90),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    subject: z.string().trim().min(1).max(500),
    message: z.string().trim().min(1).max(10_000),
  }).strict()).min(1).max(10),
}).strict().superRefine((value, context) => {
  const slots = value.steps.map(step => `${step.afterDays}:${step.localTime}`);
  if (new Set(slots).size !== slots.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Each follow-up needs a different day and time' });
});
const pauseSchema = z.object({ paused: z.boolean() }).strict();

function respondError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid proposal lifecycle request', issues: error.issues });
  if (error instanceof ProposalWorkflowError) return res.status(error.statusCode).json({ error: error.message });
  logger.error({ err: error }, 'Proposal lifecycle request failed');
  return res.status(500).json({ error: 'Unable to complete proposal action' });
}

function seller(handler: (req: Request, userId: number) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response) => {
    if (!businessOwnerUserId(req)) return res.status(401).json({ error: 'Unauthorized' });
    try { return res.status(status).json({ success: true, data: await handler(req, businessOwnerUserId(req)) }); }
    catch (error) { return respondError(res, error); }
  };
}

export const getPublicProposalFeedback = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const result = await proposalLifecycleService.publicFeedback(tokenSchema.parse(req.params.token));
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.json({ success: true, data: result });
  } catch (error) { return respondError(res, error); }
};

export const createPublicProposalFeedback = async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const result = await proposalLifecycleService.submitPublicFeedback(tokenSchema.parse(req.params.token), publicFeedbackSchema.parse(req.body));
    if (!result) return res.status(404).json({ error: 'Proposal not found' });
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return respondError(res, error); }
};

export const listProposalFeedback = seller((req, userId) => proposalLifecycleService.listFeedback(userId, positive.parse(req.params.id)));
export const replyToProposalFeedback = seller((req, userId) => proposalLifecycleService.replyToFeedback(userId, positive.parse(req.params.id), positive.parse(req.params.feedbackId), sellerReplySchema.parse(req.body).content), 201);
export const resolveProposalFeedback = seller((req, userId) => proposalLifecycleService.resolveFeedback(userId, positive.parse(req.params.id), positive.parse(req.params.feedbackId), resolveSchema.parse(req.body).resolved));
export const createProposalRevision = seller((req, userId) => proposalLifecycleService.createRevision(userId, positive.parse(req.params.id), revisionSchema.parse(req.body)), 201);
export const previewProposalFollowups = seller((req, userId) => proposalLifecycleService.previewFollowups(userId, positive.parse(req.params.id), followupSchema.parse(req.body)));
export const configureProposalFollowups = seller((req, userId) => proposalLifecycleService.scheduleFollowups(userId, positive.parse(req.params.id), followupSchema.parse(req.body)));
export const pauseProposalFollowups = seller((req, userId) => proposalLifecycleService.setFollowupsPaused(userId, positive.parse(req.params.id), pauseSchema.parse(req.body).paused));
export const proposalOnboardingResources = seller((_req, userId) => proposalLifecycleService.onboardingResources(userId));
