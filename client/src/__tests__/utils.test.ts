/**
 * Client Utility Tests
 * Tests: cn, formatTimeIST, formatDateTimeIST, formatShortTimeIST,
 *        normalizeUploadUrl, safeJsonParse, buildContentAssetsQuery
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cn, formatTimeIST, formatDateTimeIST, formatShortTimeIST, getApiBaseUrl, normalizeUploadUrl, safeJsonParse, buildContentAssetsQuery } from '@/lib/utils';

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
});

describe('getApiBaseUrl', () => {
  it('uses same-origin requests when no API override is configured', () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBaseUrl()).toBe('');
  });

  it('normalizes an explicit environment-specific API URL', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://dev.asksales.ai///';
    expect(getApiBaseUrl()).toBe('https://dev.asksales.ai');
  });
});

describe('cn (className merger)', () => {
  it('should merge simple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('should handle conditional classes with clsx', () => {
    expect(cn('foo', false && 'ignored', 'baz')).toBe('foo baz');
    expect(cn('foo', true && 'bar')).toBe('foo bar');
  });

  it('should merge conflicting Tailwind classes (last wins)', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('p-4', 'p-8')).toBe('p-8');
  });

  it('should handle object syntax', () => {
    const result = cn({ 'text-bold': true, 'text-italic': false });
    expect(result).toBe('text-bold');
  });

  it('should handle empty inputs', () => {
    expect(cn()).toBe('');
    expect(cn('')).toBe('');
    expect(cn(undefined as unknown as string)).toBe('');
  });
});

describe('formatTimeIST', () => {
  it('should return empty string for invalid date', () => {
    expect(formatTimeIST('invalid')).toBe('');
    expect(formatTimeIST(NaN)).toBe('');
    expect(formatTimeIST('')).toBe('');
  });

  it('should return a non-empty string for valid date', () => {
    const result = formatTimeIST(new Date('2025-01-05T08:34:00Z'));
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should accept Date, number (ms), and string inputs', () => {
    const dateObj = new Date('2025-03-15T06:00:00Z');
    const ms = dateObj.getTime();
    const iso = dateObj.toISOString();
    expect(formatTimeIST(dateObj)).toBeTruthy();
    expect(formatTimeIST(ms)).toBeTruthy();
    expect(formatTimeIST(iso)).toBeTruthy();
  });
});

describe('formatDateTimeIST', () => {
  it('should return empty string for invalid date', () => {
    expect(formatDateTimeIST('not-a-date')).toBe('');
  });

  it('should return a non-empty string for valid date', () => {
    const result = formatDateTimeIST(new Date('2025-05-13T12:30:00Z'));
    expect(result).toBeTruthy();
    // Should contain year 2025
    expect(result).toContain('2025');
  });
});

describe('formatShortTimeIST', () => {
  it('should return empty string for invalid date', () => {
    expect(formatShortTimeIST('bad')).toBe('');
  });

  it('should return HH:MM format', () => {
    const result = formatShortTimeIST(new Date('2025-01-01T10:30:00Z'));
    expect(result).toBeTruthy();
    // Should match HH:MM pattern
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});

describe('normalizeUploadUrl', () => {
  it.each(['brand_asset', 'content_asset', 'image', 'video'])(
    'normalizes persisted %s uploads from both relative and configured API URLs', (category) => {
      process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
      const path = `/uploads/1/${category}/saved.png`;
      expect(normalizeUploadUrl(path)).toBe(`/api${path}`);
      expect(normalizeUploadUrl(path.slice(1))).toBe(`/api${path}`);
      expect(normalizeUploadUrl(`https://api.example.com${path}?v=2`)).toBe(`/api${path}?v=2`);
      expect(normalizeUploadUrl(`/api${path}`)).toBe(`/api${path}`);
    },
  );

  it('preserves protected knowledge and gallery routes and temporary file previews', () => {
    for (const url of ['/api/settings/storage/files/7/download?inline=true', '/api/settings/media-galleries/assets/8/content', 'blob:local-preview']) {
      expect(normalizeUploadUrl(url)).toBe(url);
    }
  });

  it('should return empty string for null/undefined input', () => {
    expect(normalizeUploadUrl(null)).toBe('');
    expect(normalizeUploadUrl(undefined)).toBe('');
    expect(normalizeUploadUrl('')).toBe('');
  });

  it('should pass through https URLs unchanged', () => {
    const url = 'https://example.com/image.png';
    expect(normalizeUploadUrl(url)).toBe(url);
  });

  it('should pass through data URIs unchanged', () => {
    const dataUri = 'data:image/png;base64,abc123';
    expect(normalizeUploadUrl(dataUri)).toBe(dataUri);
  });

  it('should prefix /uploads/ paths with /api', () => {
    // jsdom environment: window exists but hostname is not asksales.ai → apiBase = ""
    expect(normalizeUploadUrl('/uploads/logos/logo.png')).toBe('/api/uploads/logos/logo.png');
  });

  it('should return /api/ prefixed paths as-is', () => {
    expect(normalizeUploadUrl('/api/content/image.jpg')).toBe('/api/content/image.jpg');
  });

  it('keeps upload paths on the frontend origin so security headers do not block media', () => {
    expect(normalizeUploadUrl('/api/uploads/1/image/generated.png')).toBe('/api/uploads/1/image/generated.png');
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"key":"value"}', {})).toEqual({ key: 'value' });
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"', '')).toBe('hello');
  });

  it('should return fallback for invalid JSON', () => {
    expect(safeJsonParse('not json', {})).toEqual({});
    expect(safeJsonParse('{bad}', null)).toBeNull();
  });

  it('should return fallback for null/undefined', () => {
    expect(safeJsonParse(null, 'default')).toBe('default');
    expect(safeJsonParse(undefined, 42)).toBe(42);
  });

  it('should return fallback for empty string', () => {
    expect(safeJsonParse('', 'fallback')).toBe('fallback');
  });
});

describe('buildContentAssetsQuery', () => {
  it('should build basic query with type', () => {
    const q = buildContentAssetsQuery('email');
    expect(q).toContain('type=email');
  });

  it('should include threadId when provided', () => {
    const q = buildContentAssetsQuery('social', { threadId: 42 });
    expect(q).toContain('type=social');
    expect(q).toContain('threadId=42');
  });

  it('should include groupByThread when true', () => {
    const q = buildContentAssetsQuery('blog', { groupByThread: true });
    expect(q).toContain('includeThread=true');
  });

  it('should not include optional params when omitted', () => {
    const q = buildContentAssetsQuery('sms');
    expect(q).not.toContain('threadId');
    expect(q).not.toContain('includeThread');
  });
});
