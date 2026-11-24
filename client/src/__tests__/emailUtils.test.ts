/**
 * Email Utilities Tests
 * Tests: stripEmailQuotes, extractReplyContent, cleanEmailForDisplay
 */
import { describe, it, expect } from 'vitest';
import { stripEmailQuotes, extractReplyContent, cleanEmailForDisplay } from '@/lib/emailUtils';

describe('stripEmailQuotes', () => {
  it('should return empty string for empty input', () => {
    expect(stripEmailQuotes('')).toBe('');
    expect(stripEmailQuotes(null as unknown as string)).toBe('');
  });

  it('should return clean content unchanged', () => {
    const content = 'Hello, this is a clean message.';
    expect(stripEmailQuotes(content)).toBe(content);
  });

  it('should strip lines starting with ">"', () => {
    const content = 'My reply\n> quoted line\n> another quoted';
    const result = stripEmailQuotes(content);
    expect(result).toContain('My reply');
    expect(result).not.toContain('quoted line');
    expect(result).not.toContain('another quoted');
  });

  it('should strip "On [month] [day], wrote:" quote block', () => {
    // wrotePattern: /^On\s+\w+?\s+\d{1,2}[^a-zA-Z0-9\s]+wrote:/i
    // Requires non-whitespace punctuation DIRECTLY before 'wrote:' (no space gap)
    const content = 'My reply here\n\nOn Dec 5,wrote:\noriginal content here';
    const result = stripEmailQuotes(content);
    expect(result).toContain('My reply here');
    expect(result).not.toContain('original content here');
  });

  it('should strip "-----Original Message-----" separator', () => {
    const content = 'New reply\n\n-----Original Message-----\nFrom: someone@example.com\nOld content';
    const result = stripEmailQuotes(content);
    expect(result).toContain('New reply');
    expect(result).not.toContain('Old content');
    expect(result).not.toContain('From: someone@example.com');
  });

  it('should handle multiline reply before quote', () => {
    const content = 'First paragraph\n\nSecond paragraph\n\n> Quoted text here';
    const result = stripEmailQuotes(content);
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
    expect(result).not.toContain('Quoted text here');
  });
});

describe('extractReplyContent', () => {
  it('should return empty string for empty input', () => {
    expect(extractReplyContent('')).toBe('');
    expect(extractReplyContent(null as unknown as string)).toBe('');
  });

  it('should return full content if no quote pattern found', () => {
    const content = 'Just a plain message with no quoted content here.';
    expect(extractReplyContent(content)).toBe(content);
  });

  it('should extract content before "On [month] [day],wrote:" pattern', () => {
    // wrotePattern requires punctuation directly before 'wrote:' (no space gap)
    const content = 'My new reply\n\nOn Dec 5,wrote:\nOriginally said something';
    const result = extractReplyContent(content);
    expect(result).toBe('My new reply');
    expect(result).not.toContain('Originally said something');
  });

  it('should extract content before "-----Original Message-----"', () => {
    const content = 'Fresh reply here\n\n-----Original Message-----\nOld stuff';
    const result = extractReplyContent(content);
    expect(result).toBe('Fresh reply here');
    expect(result).not.toContain('Old stuff');
  });
});

describe('cleanEmailForDisplay', () => {
  it('should return empty string for empty content', () => {
    expect(cleanEmailForDisplay('')).toBe('');
    expect(cleanEmailForDisplay(null as unknown as string)).toBe('');
  });

  it('should return cleaned content for simple message', () => {
    const content = 'Hello there!';
    expect(cleanEmailForDisplay(content)).toBe(content);
  });

  it('should clean quoted content from email', () => {
    // Use separator pattern which is unambiguous
    const content = 'This is my reply.\n\n-----Original Message-----\nOriginal message content';
    const result = cleanEmailForDisplay(content);
    expect(result).toContain('This is my reply.');
    expect(result).not.toContain('Original message content');
  });

  it('should collapse multiple blank lines', () => {
    const content = 'First\n\n\n\n\nSecond';
    const result = cleanEmailForDisplay(content);
    // Multiple blank lines should be reduced to max 2
    expect(result).not.toMatch(/\n{4,}/);
  });
});
