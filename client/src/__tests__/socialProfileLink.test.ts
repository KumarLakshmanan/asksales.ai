import { describe, expect, it } from 'vitest';
import { socialProfileLink } from '@/lib/social-profile-link';

describe('social profile display links', () => {
  it.each(['https://maps.google.com/place/123', 'https://facebook.com.evil.test/page', 'javascript:alert(1)'])('does not label %s as Facebook', url => {
    expect(socialProfileLink('Facebook', url)).toBeNull();
  });
  it('preserves genuine platform URLs', () => {
    expect(socialProfileLink('Facebook', 'https://m.facebook.com/hotel')).toBe('https://m.facebook.com/hotel');
    expect(socialProfileLink('Twitter', 'https://x.com/hotel')).toBe('https://x.com/hotel');
  });
  it('uses a profile path and validates handles', () => {
    expect(socialProfileLink('LinkedIn', null, '@person')).toBe('https://www.linkedin.com/in/person');
    expect(socialProfileLink('Instagram', null, 'https://evil.test')).toBeNull();
  });
});
