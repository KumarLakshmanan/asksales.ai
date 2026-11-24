import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { responseWrapper } from '../middleware/responseWrapper.js';

const processTurn = jest.fn<(input: unknown) => Promise<unknown>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({ channelGateway: { process: processTurn } }));
const { simulateSupportTurn } = await import('../controllers/supportOrchestrationController.js');

const app = express();
app.use(express.json());
app.use(responseWrapper);
app.use((req, _res, next) => { req.user = { id: 1, name: 'Synthetic QA', email: 'qa@example.invalid' }; next(); });
app.post('/api/support/ai/simulate', simulateSupportTurn);
beforeEach(() => { processTurn.mockReset(); });

describe('simulator controller through public response middleware', () => {
  it('retains the known routing setup error in the projected terminal error envelope', async () => {
    const error = 'Assistant replies are disabled. No legacy agent fallback is permitted.';
    processTurn.mockResolvedValue({ success: false, method: 'no_op', error, context: { metadata: { assistantRoutingBlocked: true } } });
    const result = await request(app).post('/api/support/ai/simulate').send({ message: 'Synthetic internal test', channel: 'email' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: false, code: 'SUPPORT_ASSISTANT_UNAVAILABLE', error, outcome: 'no_op', sideEffectsSuppressed: true });
    expect(result.body).not.toHaveProperty('piiTypes');
    expect(processTurn).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', conversationId: expect.any(Number),
      metadata: expect.objectContaining({ executionMode: 'preview', conversationKind: 'owner_simulator' }),
    }));
  });

  it('does not expose arbitrary pipeline diagnostics in failed previews', async () => {
    processTurn.mockResolvedValue({ success: false, method: 'error', error: 'private pipeline diagnostic', context: {} });
    const result = await request(app).post('/api/support/ai/simulate').send({ message: 'Synthetic test' });
    expect(result.body).toMatchObject({ success: false, code: 'SUPPORT_SIMULATION_FAILED', error: 'The reply preview could not be generated. Please try again.' });
    expect(JSON.stringify(result.body)).not.toContain('private pipeline diagnostic');
  });

  it('keeps a complete successful preview shape and its isolated conversation ID', async () => {
    processTurn.mockResolvedValue({ success: true, method: 'auto_sent', context: { message: { inboundText: 'Redacted test' }, confidence: 0.9,
      agentResult: { replyText: 'Suggested reply', toolCallsExecuted: [] }, metadata: { privacy: { piiTypes: ['name'] } }, policyViolations: [],
    } });
    const result = await request(app).post('/api/support/ai/simulate').send({ message: 'Synthetic test', previewSessionId: -1709404692 });
    expect(result.body).toMatchObject({ success: true, previewSessionId: -1709404692, toolMode: 'read_only', outcome: 'auto_sent',
      replyText: 'Suggested reply', piiTypes: ['name'], toolCalls: [], sideEffectsSuppressed: true,
    });
  });
});
