import { describe, expect, it } from '@jest/globals';
import {
  analyzeAeoCoverage,
  buildGroundedAeoAsset,
  validateFaqPageJsonLd,
  type AeoPageInput,
  type AeoQuestionInput,
} from '../services/aiVisibility/AeoCoverageService.js';

const question: AeoQuestionInput = {
  id: 7,
  question: 'How does Orbit automate sales reports?',
  intent: 'informational',
  targetPage: 'https://orbit.test/reporting',
  active: true,
};

const page: AeoPageInput = {
  id: 11,
  url: 'https://orbit.test/reporting',
  finalUrl: 'https://orbit.test/reporting',
  title: 'Automated sales reporting | Orbit',
  metaDescription: 'Learn how Orbit creates useful sales reports for revenue teams.',
  headings: { h1: ['Automated sales reporting'], h2: ['How Orbit builds each report'] },
  contentExcerpt: 'Orbit automatically builds sales reports from verified CRM activity every morning. Teams can review each source before sharing the report.',
  schemaTypes: ['SoftwareApplication'],
  crawlStatus: 'completed',
  indexable: true,
};

describe('AI Visibility AEO coverage', () => {
  it('maps a question to the strongest verified page and extracts a grounded concise answer', () => {
    const [coverage] = analyzeAeoCoverage([question], [
      page,
      { ...page, id: 12, url: 'https://orbit.test/about', finalUrl: 'https://orbit.test/about', title: 'About Orbit', headings: { h1: ['About'] }, contentExcerpt: 'Orbit is a software company serving revenue teams.' },
    ]);

    expect(coverage.status).toBe('answered');
    expect(coverage.bestMatch).toEqual(expect.objectContaining({ pageId: 11, url: 'https://orbit.test/reporting' }));
    expect(coverage.bestMatch?.answerExcerpt).toContain('sales reports');
    expect(coverage.bestMatch?.signals).toEqual(expect.arrayContaining(['concise answer passage found', 'configured target page']));
  });

  it('does not count blocked, noindexed, or unrelated pages as answers', () => {
    const [coverage] = analyzeAeoCoverage([question], [
      { ...page, crawlStatus: 'blocked' },
      { ...page, id: 12, indexable: false },
      { ...page, id: 13, url: 'https://orbit.test/careers', finalUrl: 'https://orbit.test/careers', title: 'Careers', metaDescription: 'Open roles and employee benefits.', headings: { h1: ['Join our team'] }, contentExcerpt: 'Browse open roles and employee benefits.' },
    ]);

    expect(coverage.status).toBe('uncovered');
    expect(coverage.bestMatch).toBeNull();
  });

  it('creates answer-block and schema drafts only from the verified answer passage', () => {
    const [coverage] = analyzeAeoCoverage([question], [page]);
    const answer = buildGroundedAeoAsset(coverage, 'answer_block');
    const faq = buildGroundedAeoAsset(coverage, 'faq_page');

    expect(answer.type).toBe('answer_block');
    expect(answer.content).toContain(coverage.bestMatch?.answerExcerpt);
    expect(answer.content).toContain('Source page: https://orbit.test/reporting');
    expect(faq.type).toBe('faq_page');
    expect(validateFaqPageJsonLd(JSON.parse(faq.content))).toEqual({ valid: true });
  });

  it('does not turn a repeated question or generic navigation into an answer', () => {
    const pricing = { ...question, question: "What should a customer know about Aimplify pricing, availability and booking or purchase process in India?" };
    const [coverage] = analyzeAeoCoverage([pricing], [{ ...page, title: 'Aimplify platform', metaDescription: null, headings: {}, contentExcerpt: 'HR & Recruitment Finance & Accounting Sales & Marketing Customer Support To know more about us Frequently Asked Questions What makes Aimplify different from other AI platforms? What should a customer know about Aimplify pricing, availability and booking or purchase process in India?' }]);
    expect(coverage.status).not.toBe('answered');
    expect(coverage.bestMatch?.answerExcerpt).toBeFalsy();
    expect(() => buildGroundedAeoAsset(coverage, 'answer_block')).toThrow('No verified crawl passage');
    expect(buildGroundedAeoAsset(coverage, 'research_brief').type).toBe('content_brief');
  });

  it('rejects FAQPage structures without a grounded accepted answer', () => {
    expect(validateFaqPageJsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'What is Orbit?', acceptedAnswer: { '@type': 'Answer', text: '' } }],
    })).toEqual(expect.objectContaining({ valid: false }));
  });
});
