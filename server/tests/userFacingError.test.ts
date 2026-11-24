import { describe, expect, it } from '@jest/globals';
import {
  AI_SERVICE_UNAVAILABLE_MESSAGE,
  sanitizeErrorFields,
  sanitizeAssistantContent,
  toUserFacingError,
} from '../../shared/userFacingError.js';

describe('user-facing error sanitization', () => {
  it('preserves full assistant catalogs while still hiding infrastructure errors', () => {
    const catalog = 'Instagram workflow details. '.repeat(200);
    expect(sanitizeAssistantContent(catalog)).toBe(catalog);
    expect(sanitizeAssistantContent('Lightning dunning decision is deny for project: projects/740750721991'))
      .toBe(AI_SERVICE_UNAVAILABLE_MESSAGE);
    expect(toUserFacingError(catalog).length).toBe(2000);
  });
  it('replaces a serialized validation issue list stored inside chat text', () => {
    const issues = JSON.stringify([
      { expected: 'string', code: 'invalid_type', path: ['subject'], message: 'Invalid input: expected string, received undefined' },
      { expected: 'string', code: 'invalid_type', path: ['body'], message: 'Invalid input: expected string, received undefined' },
    ], null, 2);
    expect(sanitizeAssistantContent(`❌ Email template was not generated. ${issues}`))
      .toBe('❌ Email template was not generated. Generation did not complete.');
    const table = 'Leads: [{"name":"Ada","company":"Acme"}]';
    expect(sanitizeAssistantContent(table)).toBe(table);
  });
  it('hides provider billing and project details', () => {
    expect(toUserFacingError(
      'Lightning dunning decision is deny for project: projects/740750721991',
    )).toBe(AI_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it('preserves actionable validation errors', () => {
    expect(toUserFacingError('Select at least one lead before sending.'))
      .toBe('Select at least one lead before sending.');
  });

  it('sanitizes nested tool results without changing successful output', () => {
    const sanitized = sanitizeErrorFields({
      toolResults: [{
        success: false,
        error: 'Lightning dunning decision is deny for project: projects/740750721991',
      }, { success: true, error: undefined }],
      output: { leadCount: 12 },
    });

    expect(sanitized).toEqual({
      toolResults: [
        { success: false, error: AI_SERVICE_UNAVAILABLE_MESSAGE },
        { success: true, error: undefined },
      ],
      output: { leadCount: 12 },
    });
  });
});
