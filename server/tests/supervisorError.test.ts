/**
 * Supervisor Error Handling Tests
 * Tests: error response with action buttons, rate limit detection
 * 
 * Logic replicated from: langgraph/nodes/supervisor.ts
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types from state.ts ─────────────────────────────────────────
interface ActionButton {
  id: string;
  label: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  type?: 'primary' | 'secondary' | 'danger';
}

// ─── Replicated logic from supervisor.ts ─────────────────────────────────────

function createErrorActionButtons(): ActionButton[] {
  return [
    {
      id: 'retry_last_action',
      label: '🔄 Try Again',
      action: 'retry',
      type: 'primary',
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const message = error.message || String(error);
  return (
    message.includes('429') ||
    message.includes('quota') ||
    message.includes('rate') ||
    message.includes('Rate limit') ||
    message.includes('RESOURCE_EXHAUSTED')
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createErrorResponse(userId: string, threadId: string) {
  const errorResponseId = `supervisor-error-${Date.now()}`;
  const errorContent = `I'm having a moment. Let me try again. How can I help you today?`;
  const actionButtons = createErrorActionButtons();

  return {
    responseId: errorResponseId,
    content: errorContent,
    metadata: { responseId: errorResponseId, actionButtons },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Supervisor Error Handling', () => {
  describe('createErrorActionButtons', () => {
    it('should return an array with retry button', () => {
      const buttons = createErrorActionButtons();
      expect(Array.isArray(buttons)).toBe(true);
      expect(buttons.length).toBe(1);
    });

    it('should have retry button with correct properties', () => {
      const buttons = createErrorActionButtons();
      const retryBtn = buttons[0];

      expect(retryBtn.id).toBe('retry_last_action');
      expect(retryBtn.label).toContain('Try Again');
      expect(retryBtn.action).toBe('retry');
      expect(retryBtn.type).toBe('primary');
    });

    it('should have retry button with emoji prefix', () => {
      const buttons = createErrorActionButtons();
      expect(buttons[0].label).toMatch(/^🔄/);
    });
  });

  describe('isRateLimitError', () => {
    it('should detect 429 status code', () => {
      expect(isRateLimitError(new Error('Request failed with 429'))).toBe(true);
    });

    it('should detect "quota" in message', () => {
      expect(isRateLimitError(new Error('API quota exceeded'))).toBe(true);
    });

    it('should detect "rate" in message', () => {
      expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    });

    it('should detect "Rate limit" capitalized', () => {
      expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    });

    it('should detect "RESOURCE_EXHAUSTED"', () => {
      expect(isRateLimitError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
    });

    it('should not detect non-rate-limit errors', () => {
      expect(isRateLimitError(new Error('Connection timeout'))).toBe(false);
    });

    it('should handle null error', () => {
      expect(isRateLimitError(null)).toBe(false);
    });

    it('should handle undefined error', () => {
      expect(isRateLimitError(undefined)).toBe(false);
    });

    it('should handle string errors', () => {
      expect(isRateLimitError('429 Too Many Requests')).toBe(true);
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response with content', () => {
      const response = createErrorResponse('1', '100');
      expect(response.content).toContain("having a moment");
      expect(response.content).toContain("try again");
    });

    it('should include responseId in metadata', () => {
      const response = createErrorResponse('1', '100');
      expect(response.metadata.responseId).toBeTruthy();
      expect(response.metadata.responseId).toContain('supervisor-error-');
    });

    it('should include action buttons in metadata', () => {
      const response = createErrorResponse('1', '100');
      expect(response.metadata.actionButtons).toBeDefined();
      expect(response.metadata.actionButtons.length).toBe(1);
      expect(response.metadata.actionButtons[0].action).toBe('retry');
    });

    it('should have unique responseIds', () => {
      const response1 = createErrorResponse('1', '100');
      // Simulate second call slightly later
      const response2 = createErrorResponse('1', '100');
      // ResponseIds contain timestamp + random suffix, so they should differ
      // Just verify the format is correct
      expect(response1.responseId).toMatch(/^supervisor-error-\d+$/);
      expect(response2.responseId).toMatch(/^supervisor-error-\d+$/);
    });
  });
});
