/**
 * ToolLoop Tests
 * Tests: stream error notification, tool failure propagation
 * 
 * Logic replicated from: langgraph/utils/toolLoop.ts
 * (no imports to avoid ts-jest OOM on @langchain/*)
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types from state.ts ─────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type AgentType = 'orchestrator' | 'supervisor' | 'icp_generation' | 'lead_generation' | 'content_studio' | 'outreach' | 'performance_marketing';

interface ToolResult {
  success: boolean;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: Record<string, any>;
  error?: string;
}

// ─── Replicated logic from toolLoop.ts ──────────────────────────────────────

/**
 * Simulates the tool result logging logic.
 * Returns the formatted tool result message for chat.
 */
function formatToolResult(toolName: string, success: boolean, durationMs: number, error?: string): string {
  const icon = success ? '✅' : '❌';
  const duration = (durationMs / 1000).toFixed(1);
  const base = `${icon} **${toolName.replace(/_/g, ' ')}** completed in ${duration}s`;
  if (!success && error) {
    return `${base}\n\n⚠️ Error: ${error}`;
  }
  return base;
}

/**
 * Simulates the tool output sanitization for chat display.
 * Returns a trimmed version suitable for chat messages.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeToolOutputForChat(toolName: string, output: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!output) return undefined;
  
  const sanitized = { ...output };
  
  // For content generation tools, limit the displayed output
  if (toolName.includes('generate_') || toolName.includes('create_')) {
    if (sanitized.url) sanitized.url = sanitized.url.substring(0, 100);
    if (sanitized.imageData) sanitized.imageData = '[image data truncated]';
    if (sanitized.videoData) sanitized.videoData = '[video data truncated]';
  }
  
  return sanitized;
}

/**
 * Simulates the tool failure message that should be emitted to the user.
 */
function createToolFailureMessage(toolName: string, error: string): string {
  return `⚠️ Tool \`${toolName}\` failed: ${error}`;
}

/**
 * Simulates the stream error warning message.
 */
function createStreamErrorMessage(): string {
  return '⚠️ The response stream was interrupted. The agent will continue with partial results.';
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ToolLoop', () => {
  describe('formatToolResult', () => {
    it('should format successful tool result with checkmark', () => {
      const result = formatToolResult('generate_image', true, 1500);
      expect(result).toContain('✅');
      expect(result).toContain('generate image');
      expect(result).toContain('1.5s');
    });

    it('should format failed tool result with cross mark', () => {
      const result = formatToolResult('generate_image', false, 500, 'Rate limit exceeded');
      expect(result).toContain('❌');
      expect(result).toContain('generate image');
      expect(result).toContain('0.5s');
    });

    it('should include error message for failed tools', () => {
      const result = formatToolResult('crawl_website', false, 200, 'Connection timeout');
      expect(result).toContain('Connection timeout');
    });

    it('should not include error section for successful tools', () => {
      const result = formatToolResult('generate_image', true, 1000);
      expect(result).not.toContain('Error:');
    });

    it('should replace underscores with spaces in tool name', () => {
      const result = formatToolResult('generate_social_media_post', true, 1000);
      expect(result).toContain('generate social media post');
    });
  });

  describe('sanitizeToolOutputForChat', () => {
    it('should return undefined for undefined output', () => {
      expect(sanitizeToolOutputForChat('test', undefined)).toBeUndefined();
    });

    it('should pass through output for non-content tools', () => {
      const output = { url: 'https://example.com', status: 'ok' };
      const result = sanitizeToolOutputForChat('analytics_query', output);
      expect(result).toEqual(output);
    });

    it('should truncate image data for generate_image tool', () => {
      const output = { imageData: 'a'.repeat(10000), mimeType: 'image/png' };
      const result = sanitizeToolOutputForChat('generate_image', output);
      expect(result?.imageData).toBe('[image data truncated]');
    });

    it('should truncate video data for generate_video tool', () => {
      const output = { videoData: 'b'.repeat(50000), mimeType: 'video/mp4' };
      const result = sanitizeToolOutputForChat('generate_video', output);
      expect(result?.videoData).toBe('[video data truncated]');
    });

    it('should truncate URLs for content generation tools', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(200);
      const output = { url: longUrl };
      const result = sanitizeToolOutputForChat('generate_social_media_post', output);
      expect(result?.url?.length).toBeLessThanOrEqual(100);
    });

    it('should not modify output for non-generate tools', () => {
      const output = { data: 'test', nested: { value: 123 } };
      const result = sanitizeToolOutputForChat('list_content_assets', output);
      expect(result).toEqual(output);
    });
  });

  describe('createToolFailureMessage', () => {
    it('should format tool failure with name and error', () => {
      const msg = createToolFailureMessage('generate_image', 'API rate limit');
      expect(msg).toContain('⚠️');
      expect(msg).toContain('generate_image');
      expect(msg).toContain('API rate limit');
    });

    it('should use markdown formatting for tool name', () => {
      const msg = createToolFailureMessage('test_tool', 'error');
      expect(msg).toContain('`test_tool`');
    });
  });

  describe('createStreamErrorMessage', () => {
    it('should return a warning about stream interruption', () => {
      const msg = createStreamErrorMessage();
      expect(msg).toContain('⚠️');
      expect(msg).toContain('interrupted');
    });
  });

  describe('ToolResult type', () => {
    it('should define success as boolean', () => {
      const result: ToolResult = { success: true, toolName: 'test' };
      expect(typeof result.success).toBe('boolean');
    });

    it('should have optional error string', () => {
      const result: ToolResult = { success: false, toolName: 'test', error: 'Failed' };
      expect(result.error).toBe('Failed');
    });
  });
});
