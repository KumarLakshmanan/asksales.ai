import { describe, expect, it } from '@jest/globals';
import {
  automaticPipelineRequest,
  completedWidgetToolToSuppress,
  hasSuccessfulWidgetContinuation,
  shouldAutoCompleteWidgetContinuation,
} from '../mastra/agents/BaseAgent.js';

describe('automatic specialist pipeline context', () => {
  it('replays the original campaign request after an assistant handoff', () => {
    expect(automaticPipelineRequest({
      messages: [{ role: 'assistant', content: 'ICP complete' }],
      agentPipeline: ['icp_generation', 'lead_generation'],
      agentPipelineIndex: 1,
      pipelineRequest: 'Generate five hotel leads and stop at review.',
    } as never)).toBe('Generate five hotel leads and stop at review.');
  });

  it('does not override a fresh user instruction', () => {
    expect(automaticPipelineRequest({
      messages: [{ role: 'user', content: 'Actually, stop here.' }],
      agentPipeline: ['icp_generation', 'lead_generation'],
      agentPipelineIndex: 1,
      pipelineRequest: 'Generate five hotel leads.',
    } as never)).toBeNull();
  });

  it('lets specialist pre-processing classify the original request instead of an assistant handoff', () => {
    const state = {
      messages: [{ role: 'assistant', content: 'Your ICP is ready.' }],
      agentPipeline: ['icp_generation', 'content_studio', 'performance_marketing'],
      agentPipelineIndex: 1,
      pipelineRequest: 'Create Meta and Google ad copy and stop at review.',
    } as never;

    expect(automaticPipelineRequest(state)).toMatch(/Meta and Google ad copy/);
  });

  it('trusts only a successful server widget result for the completed specialist tool', () => {
    const tools = ['generate_email_template'];
    expect(hasSuccessfulWidgetContinuation({
      widgetContinuation: { widgetId: 50, toolName: 'generate_email_template', success: true },
    }, tools)).toBe(true);
    expect(hasSuccessfulWidgetContinuation({
      widgetContinuation: { widgetId: 50, toolName: 'generate_email_template', success: false },
    }, tools)).toBe(false);
    expect(hasSuccessfulWidgetContinuation({
      widgetContinuation: { widgetId: 50, toolName: 'publish_meta_ads', success: true },
    }, tools)).toBe(false);
    expect(hasSuccessfulWidgetContinuation({}, tools)).toBe(false);
  });

  it('auto-completes a verified final widget when another pipeline agent remains', () => {
    const state = {
      widgetContinuation: { widgetId: 54, toolName: 'generate_ad', success: true },
      agentPipeline: ['content_studio', 'performance_marketing'],
      agentPipelineIndex: 0,
    };
    expect(shouldAutoCompleteWidgetContinuation(state as never, ['generate_ad'], [])).toBe(true);
    expect(shouldAutoCompleteWidgetContinuation(
      state as never,
      ['generate_ad'],
      [{ toolName: 'generate_ad', toolCallId: 'next', success: true, result: { pendingWidget: true } }],
    )).toBe(false);
    expect(shouldAutoCompleteWidgetContinuation({
      ...state,
      agentPipelineIndex: 1,
    } as never, ['generate_ad'], [])).toBe(false);
  });

  it('suppresses the already-executed widget tool only on its trusted continuation turn', () => {
    const trustedState = {
      messages: [{
        role: 'user',
        content: '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]\nContinue the remaining campaign steps.',
      }],
      widgetContinuation: { widgetId: 56, toolName: 'generate_ad', success: true },
    };
    expect(completedWidgetToolToSuppress(trustedState as never)).toBe('generate_ad');
    expect(completedWidgetToolToSuppress({
      ...trustedState,
      messages: [{ role: 'user', content: 'Create another variation.' }],
    } as never)).toBeNull();
    expect(completedWidgetToolToSuppress({
      ...trustedState,
      widgetContinuation: { widgetId: 56, toolName: 'generate_ad', success: false },
    } as never)).toBeNull();
  });

  it('keeps ad generation available only for requested platforms that are still missing', () => {
    const state = {
      messages: [{
        role: 'user',
        content: '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]\nContinue the remaining campaign steps.',
      }],
      pipelineRequest: 'Generate ad creatives for Meta and Google, then prepare the campaign review.',
      widgetContinuation: {
        widgetId: 70,
        toolName: 'generate_ad',
        success: true,
        completedToolInputs: [{ platform: 'meta' }],
      },
    };
    expect(completedWidgetToolToSuppress(state as never)).toBeNull();
    expect(completedWidgetToolToSuppress({
      ...state,
      widgetContinuation: {
        ...state.widgetContinuation,
        completedToolInputs: [{ platform: 'meta' }, { platform: 'google' }],
      },
    } as never)).toBe('generate_ad');
  });
});
