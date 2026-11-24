import { describe, expect, it } from '@jest/globals';
import { auditPageType, rankAuditCandidates } from '../services/aiVisibility/PageTypes.js';

const site = (path: string) => `https://orocircle.com${path}`;

describe('analysis page types', () => {
  it('lets the first path segment decide, so slugs never change the type', () => {
    expect(auditPageType(site('/'))).toBe('homepage');
    expect(auditPageType(site('/blogs/'))).toBe('blog');
    expect(auditPageType(site('/blogs/nandi-hills-sunrise/'))).toBe('blog');
    expect(auditPageType(site('/blogs/package-post/find-a-package-thats-made-for-you/'))).toBe('blog');
    expect(auditPageType(site('/team-outing-resorts-inbangalore/'))).toBe('other');
    expect(auditPageType(site('/contact-us/'))).toBe('contact');
    expect(auditPageType('https://www.anantabliss.com/contact-ananta-bliss')).toBe('contact');
    expect(auditPageType('https://example.com/about-us')).toBe('about');
    expect(auditPageType('https://example.com/2024/05/launch-notes')).toBe('blog');
    expect(auditPageType('https://example.com/services/audits')).toBe('services');
    expect(auditPageType('https://example.com/team')).toBe('team');
  });
});

describe('choosing the pages an analysis crawls', () => {
  const posts = Array.from({ length: 19 }, (_, index) => site(`/blogs/post-${index}/`));
  const pages = [
    '/', '/careers/', '/blogs/', '/contact-us/', '/private-villas-in-bangalore/',
    '/events-venue-in-bangalore/', '/privacy-policy/', '/thank-you/', '/blogs-old/',
  ].map(site);

  it('crawls the key pages before articles even when posts come first in the sitemap', () => {
    const ranked = rankAuditCandidates(site('/'), [], [...posts, ...pages], 11);
    expect(ranked[0]).toBe(site('/'));
    expect(ranked).toEqual(
      expect.arrayContaining([site('/contact-us/'), site('/private-villas-in-bangalore/'), site('/blogs/')]),
    );
    expect(ranked.filter((url) => /\/blogs\/post-/.test(url))).toHaveLength(5);
    expect(ranked).not.toContain(site('/privacy-policy/'));
  });

  it('keeps at most three pages from one section among the key pages', () => {
    const services = Array.from({ length: 6 }, (_, index) => `https://example.com/services/s-${index}`);
    const ranked = rankAuditCandidates('https://example.com/', [], [...services, 'https://example.com/contact'], 5);
    expect(ranked).toEqual([
      'https://example.com/',
      'https://example.com/services/s-0',
      'https://example.com/services/s-1',
      'https://example.com/services/s-2',
      'https://example.com/contact',
    ]);
  });

  it('fills the rest with whatever is left and never repeats a page', () => {
    const ranked = rankAuditCandidates(site('/'), [site('/contact-us/')], [...pages, ...posts], 40, (url) =>
      url.replace(/\/$/, ''),
    );
    expect(new Set(ranked).size).toBe(ranked.length);
    expect(ranked).toContain(site('/privacy-policy/'));
    expect(ranked.indexOf(site('/contact-us/'))).toBe(1);
  });
});
