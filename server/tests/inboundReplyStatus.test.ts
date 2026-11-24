import { describe, expect, it } from '@jest/globals';
import { getInboundReplyTransition } from '../utils/inboundReplyStatus.js';

describe('getInboundReplyTransition', () => {
  it('marks a new contact as replied and moves it into the interested pipeline stage', () => {
    expect(getInboundReplyTransition('new', 'new')).toEqual({
      status: 'replied',
      pipelineStatus: 'interested',
    });
  });

  it('moves a contacted lead to interested', () => {
    expect(getInboundReplyTransition('contacted', 'contacted')).toEqual({
      status: 'interested',
      pipelineStatus: 'interested',
    });
  });

  it('does not regress an advanced pipeline stage', () => {
    expect(getInboundReplyTransition('interested', 'negotiations')).toEqual({
      status: 'interested',
      pipelineStatus: 'negotiations',
    });
  });

  it('preserves terminal stages', () => {
    expect(getInboundReplyTransition('lost', 'lost')).toEqual({
      status: 'lost',
      pipelineStatus: 'lost',
    });
  });
});
