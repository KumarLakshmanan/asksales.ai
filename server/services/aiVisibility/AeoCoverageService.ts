export type AeoCoverageStatus = 'answered' | 'partial' | 'uncovered';
export type AeoAssetType = 'answer_block' | 'faq_page' | 'research_brief';

export interface AeoQuestionInput {
  id: number;
  question: string;
  intent: string;
  targetPage: string | null;
  active: boolean;
}

export interface AeoPageInput {
  id: number;
  url: string;
  finalUrl?: string | null;
  title?: string | null;
  metaDescription?: string | null;
  headings: Record<string, string[]>;
  contentExcerpt?: string | null;
  schemaTypes: string[];
  crawlStatus: string;
  indexable: boolean;
}

export interface AeoPageMatch {
  pageId: number;
  url: string;
  title: string | null;
  score: number;
  answerExcerpt: string | null;
  supportedSchema: boolean;
  signals: string[];
}

export interface AeoQuestionCoverage {
  questionId: number;
  question: string;
  intent: string;
  targetPage: string | null;
  active: boolean;
  status: AeoCoverageStatus;
  bestMatch: AeoPageMatch | null;
  matches: AeoPageMatch[];
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'the',
  'their',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'your',
  'should',
  'know',
  'customer',
  'prospective',
]);

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter(
    (token) => token.length > 2 && !STOP_WORDS.has(token),
  );
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function overlapRatio(needles: string[], haystack: string): number {
  if (!needles.length) return 0;
  const haystackTokens = new Set(tokens(haystack));
  return needles.filter((token) => haystackTokens.has(token)).length / needles.length;
}

function answerExcerpt(questionTokens: string[], content: string): string | null {
  const candidates = content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*[|•]\s*/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      const wordCount = candidate.split(/\s+/).length;
      // A question or navigation label is not an answer, even when it repeats every topic term.
      return wordCount >= 6 && wordCount <= 80 && !candidate.endsWith('?');
    });
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      overlap: overlapRatio(questionTokens, candidate),
    }))
    .sort((a, b) => b.overlap - a.overlap || a.candidate.length - b.candidate.length);
  const best = ranked[0];
  const minimumOverlap = 0.5;
  return best && best.overlap >= minimumOverlap ? best.candidate : null;
}

function scorePage(question: AeoQuestionInput, page: AeoPageInput): AeoPageMatch | null {
  if (page.crawlStatus !== 'completed' || !page.indexable) return null;
  const questionTokens = tokens(question.question);
  if (!questionTokens.length) return null;
  const headings = Object.values(page.headings || {})
    .flat()
    .join(' ');
  const body = page.contentExcerpt || '';
  const combined = [page.title, page.metaDescription, headings, body].filter(Boolean).join(' ');
  const generalOverlap = overlapRatio(questionTokens, combined);
  const headingOverlap = overlapRatio(questionTokens, headings);
  const conciseAnswer = answerExcerpt(
    questionTokens,
    [page.metaDescription, body].filter(Boolean).join(' '),
  );
  const supportedSchema = page.schemaTypes.some((type) => /^(FAQPage|QAPage|HowTo)$/i.test(type));
  const isTargetPage = Boolean(
    question.targetPage &&
    normalizeUrl(question.targetPage) === normalizeUrl(page.finalUrl || page.url),
  );
  const signals: string[] = [];
  if (generalOverlap >= 0.5) signals.push('topic terms found');
  if (headingOverlap >= 0.5) signals.push('question terms in headings');
  if (conciseAnswer) signals.push('concise answer passage found');
  if (supportedSchema) signals.push('answer-oriented schema');
  if (isTargetPage) signals.push('configured target page');
  const score = Math.min(
    1,
    generalOverlap * 0.5 +
      headingOverlap * 0.2 +
      (conciseAnswer ? 0.2 : 0) +
      (supportedSchema ? 0.05 : 0) +
      (isTargetPage ? 0.15 : 0),
  );
  if (score < 0.15) return null;
  return {
    pageId: page.id,
    url: page.finalUrl || page.url,
    title: page.title || null,
    score: Number(score.toFixed(2)),
    answerExcerpt: conciseAnswer,
    supportedSchema,
    signals,
  };
}

export function analyzeAeoCoverage(
  questions: AeoQuestionInput[],
  pages: AeoPageInput[],
): AeoQuestionCoverage[] {
  return questions.map((question) => {
    const matches = pages
      .map((page) => scorePage(question, page))
      .filter((match): match is AeoPageMatch => Boolean(match))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const bestMatch = matches[0] || null;
    const status: AeoCoverageStatus =
      bestMatch?.answerExcerpt && bestMatch.score >= 0.45
        ? 'answered'
        : bestMatch && bestMatch.score >= 0.25
          ? 'partial'
          : 'uncovered';
    return {
      questionId: question.id,
      question: question.question,
      intent: question.intent,
      targetPage: question.targetPage,
      active: question.active,
      status,
      bestMatch,
      matches,
    };
  });
}

export function validateFaqPageJsonLd(
  value: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, error: 'FAQPage JSON-LD must be an object.' };
  const record = value as Record<string, unknown>;
  if (record['@context'] !== 'https://schema.org')
    return {
      valid: false,
      error: 'FAQPage JSON-LD must use the schema.org context.',
    };
  if (record['@type'] !== 'FAQPage')
    return {
      valid: false,
      error: 'FAQPage JSON-LD must use the FAQPage type.',
    };
  if (!Array.isArray(record.mainEntity) || !record.mainEntity.length)
    return {
      valid: false,
      error: 'FAQPage JSON-LD must contain at least one question.',
    };
  for (const entity of record.mainEntity) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity))
      return { valid: false, error: 'Every FAQ entity must be an object.' };
    const question = entity as Record<string, unknown>;
    if (
      question['@type'] !== 'Question' ||
      typeof question.name !== 'string' ||
      question.name.trim().length < 5
    ) {
      return {
        valid: false,
        error: 'Every FAQ entity must contain a valid Question name.',
      };
    }
    const acceptedAnswer = question.acceptedAnswer;
    if (!acceptedAnswer || typeof acceptedAnswer !== 'object' || Array.isArray(acceptedAnswer))
      return {
        valid: false,
        error: 'Every FAQ question must contain an accepted answer.',
      };
    const answer = acceptedAnswer as Record<string, unknown>;
    if (
      answer['@type'] !== 'Answer' ||
      typeof answer.text !== 'string' ||
      answer.text.trim().split(/\s+/).length < 6
    ) {
      return {
        valid: false,
        error: 'Every accepted answer must contain grounded answer text.',
      };
    }
  }
  return { valid: true };
}

export function buildGroundedAeoAsset(coverage: AeoQuestionCoverage, assetType: AeoAssetType) {
  const match = coverage.bestMatch;
  if (assetType === 'research_brief')
    return {
      title: `Research brief: ${coverage.question}`,
      type: 'content_brief',
      content: [
        `# ${coverage.question}`,
        '',
        'Research brief — an answer has not been verified.',
        '',
        `Target page: ${coverage.targetPage || 'Choose an existing relevant page or create a new one.'}`,
        '',
        '## Evidence to collect',
        '- Ask the business owner for current service, product, pricing or policy facts relevant to this question.',
        '- Record a first-party source URL and review date for each claim.',
        ...(match
          ? [`- Review the related page: ${match.url}. Its content is not yet a verified answer.`]
          : []),
        '',
        '## Writing task',
        'Write a direct answer using only the collected evidence. Include limitations and a clear next step for the reader.',
        '',
        '## Verification',
        'After the answer is published on the website, re-analyze and check coverage. Create FAQ schema only from a verified answer.',
      ].join('\n'),
      validation: {
        valid: true,
        validator: 'research_brief_v1',
        sourcePage: match?.url || null,
        coverageScore: match?.score || 0,
      },
    };
  if (!match?.answerExcerpt)
    throw new Error(
      'No verified crawl passage answers this question. Refresh the analysis after adding a supported answer to the website.',
    );
  if (assetType === 'answer_block') {
    return {
      title: `Answer block: ${coverage.question}`,
      type: 'answer_block',
      content: [
        `## ${coverage.question}`,
        '',
        match.answerExcerpt,
        '',
        `Source page: ${match.url}`,
        '',
        'Editorial review required: confirm the wording and every factual claim against the linked source before approval.',
      ].join('\n'),
      validation: {
        valid: true,
        validator: 'grounded_aeo_answer_v1',
        sourcePage: match.url,
        coverageScore: match.score,
      },
    };
  }
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: coverage.question,
        acceptedAnswer: { '@type': 'Answer', text: match.answerExcerpt },
      },
    ],
  };
  const validation = validateFaqPageJsonLd(jsonLd);
  if (!validation.valid) throw new Error(validation.error);
  return {
    title: `FAQPage schema: ${coverage.question}`,
    type: 'faq_page',
    content: JSON.stringify(jsonLd, null, 2),
    validation: {
      valid: true,
      validator: 'faq_page_schema_v1',
      sourcePage: match.url,
      coverageScore: match.score,
    },
  };
}
