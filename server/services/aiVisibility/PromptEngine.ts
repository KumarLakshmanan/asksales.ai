import { createHash } from 'node:crypto';
import type { AiVisibilityProfile } from '../../models/aiVisibility/schema.js';

export interface GeneratedPrompt {
  kind: 'keyword' | 'aeo' | 'geo';
  prompt: string;
  normalizedPrompt: string;
  promptHash: string;
  intent: string;
  persona: string;
  locale: string;
  isGeneric: boolean;
}

const PERSONAS: Record<AiVisibilityProfile, string[]> = {
  b2b_saas: ['business buyer', 'technical evaluator'],
  ecommerce: ['product researcher', 'comparison shopper'],
  local_business: ['local customer', 'service researcher'],
  general: ['prospective customer', 'independent researcher'],
};

export function buildPrompt(
  kind: GeneratedPrompt['kind'],
  prompt: string,
  intent: string,
  persona: string,
  locale: string,
  isGeneric: boolean,
): GeneratedPrompt {
  const normalizedPrompt = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    kind,
    prompt,
    normalizedPrompt,
    promptHash: createHash('sha256').update(normalizedPrompt).digest('hex'),
    intent,
    persona,
    locale,
    isGeneric,
  };
}

export function generateAuditPrompts(input: {
  brandName: string;
  aliases: string[];
  category?: string | null;
  profile: AiVisibilityProfile;
  locale: string;
  geography?: string | null;
}): GeneratedPrompt[] {
  const category = input.category?.trim();
  const subject = category || `the services and products offered by ${input.brandName.trim()}`;
  const geography = input.geography ? ` in ${input.geography}` : '';
  const [primaryPersona, secondaryPersona] = PERSONAS[input.profile];
  const brand = input.brandName.trim();
  let language = input.locale;
  try {
    language =
      new Intl.DisplayNames(['en'], { type: 'language' }).of(input.locale.split('-')[0]) ||
      input.locale;
  } catch {
    /* retain explicit locale */
  }
  const responseLocale = ` Respond in ${language}, using the ${input.locale} locale and local terminology.`;
  const questionSets: Record<AiVisibilityProfile, [string, string]> = {
    b2b_saas: [
      `Which teams is ${brand} suitable for, and which integrations and deployment options does it support${geography}?`,
      `What are ${brand}'s pricing, security and implementation requirements${geography}?`,
    ],
    ecommerce: [
      `Which products does ${brand} sell${geography}, and how do their specifications and variants compare?`,
      `What are ${brand}'s delivery, availability and return policies${geography}?`,
    ],
    local_business: [
      `What services, facilities and experiences does ${brand} offer${geography}, and who are they suitable for?`,
      `How can a customer check ${brand}'s location, availability, pricing and booking conditions${geography}?`,
    ],
    general: [
      `What${category ? ` ${category}` : ''} services or products does ${brand} offer${geography}, and who are they suitable for?`,
      `What should a customer know about ${brand}'s pricing, availability and booking or purchase process${geography}?`,
    ],
  };
  const [offeringQuestion, decisionQuestion] = questionSets[input.profile];
  return [
    buildPrompt(
      'keyword',
      `What terms do people use when searching for ${subject}${geography}?`,
      'discovery',
      primaryPersona,
      input.locale,
      Boolean(category),
    ),
    buildPrompt(
      'keyword',
      `What should a buyer compare before choosing ${subject}${geography}?`,
      'comparison',
      secondaryPersona,
      input.locale,
      Boolean(category),
    ),
    buildPrompt('aeo', offeringQuestion, 'informational', primaryPersona, input.locale, false),
    buildPrompt('aeo', decisionQuestion, 'evaluation', secondaryPersona, input.locale, false),
    buildPrompt(
      'geo',
      category
        ? `Which providers of ${category} should a ${primaryPersona} consider${geography}, and why?${responseLocale}`
        : `${offeringQuestion} Include sources.${responseLocale}`,
      category ? 'recommendation' : 'brand_offering',
      primaryPersona,
      input.locale,
      Boolean(category),
    ),
    buildPrompt(
      'geo',
      category
        ? `Compare leading options for ${category}${geography}. Include strengths, trade-offs, and sources.${responseLocale}`
        : `${decisionQuestion} Include sources.${responseLocale}`,
      category ? 'comparison' : 'brand_decision',
      secondaryPersona,
      input.locale,
      Boolean(category),
    ),
    buildPrompt(
      'geo',
      `Is ${brand} a credible ${category ? `option for ${category}` : 'business'}${geography}? Explain with sources.${responseLocale}`,
      'brand_evaluation',
      primaryPersona,
      input.locale,
      false,
    ),
    buildPrompt(
      'geo',
      `What are the strongest alternatives to ${brand} for ${subject}${geography}, and when would each be preferred?${responseLocale}`,
      'alternatives',
      secondaryPersona,
      input.locale,
      false,
    ),
  ];
}
