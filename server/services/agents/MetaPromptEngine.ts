/**
 * Meta-Prompt Engine / Composer
 * 
 * Generates optimized prompts dynamically from campaign context, ICP data,
 * and brand toolkit settings. Uses LLM to build intelligent prompt trees
 * for various content generation tasks.
 */

import type { LLMChatOptions, LLMResponse } from './LLMProvider';
import { LLMProviderFactory } from './LLMProviderFactory';
import type { ICPProfile } from '../ICPGenerationService';
import { logger } from '../../utils/logger.js';

export interface MetaPromptContext {
  icp: ICPProfile;
  brandToolkit?: BrandToolkit;
  campaignObjective?: string;
  contentType: 'ad_copy' | 'email' | 'social_post' | 'blog' | 'video_script' | 'dm' | 'landing_page';
  targetPlatform?: string;
  additionalContext?: string;
}

export interface BrandToolkit {
  id?: number;
  brandName: string;
  tagline?: string;
  missionStatement?: string;
  brandValues?: string[];
  primaryColors?: string[];
  secondaryColors?: string[];
  voicePersonalityTraits?: string[];
  voiceDos?: string[];
  voiceDonts?: string[];
  voiceKeywords?: string[];
  contentPillars?: string[];
  audiencePainPoints?: string[];
  audienceGoals?: string[];
  audienceLanguageStyle?: string[];
  ctas?: string[];
}

export interface GeneratedPrompt {
  id: string;
  type: string;
  title: string;
  prompt: string;
  systemContext: string;
  suggestedParameters: {
    temperature: number;
    maxTokens: number;
    tone: string;
  };
  variations?: GeneratedPrompt[];
}

export interface MetaPromptTree {
  rootPrompt: GeneratedPrompt;
  branches: {
    hook: GeneratedPrompt;
    body: GeneratedPrompt;
    cta: GeneratedPrompt;
  };
  variations: GeneratedPrompt[];
  metadata: {
    contextUsed: string[];
    confidenceScore: number;
    suggestedIterations: number;
    createdAt: Date;
  };
}

export class MetaPromptEngine {
  // LLM providers are obtained per-user when needed
  constructor() {
    // No provider at construction time — provider is fetched per-user in each method
  }

  private async complete(userId: number | undefined, options: Pick<LLMChatOptions, 'messages' | 'temperature' | 'max_tokens' | 'response_format' | 'loggingContext'>): Promise<LLMResponse> {
    if (!userId) throw new Error('A user is required for prompt generation.');
    return LLMProviderFactory.createChatCompletionWithFallback(userId, { ...options, model: '' });
  }

  /**
   * Generate a complete prompt tree for content generation
   */
  async generatePromptTree(context: MetaPromptContext, userId?: number): Promise<MetaPromptTree> {
    logger.info({ contentType: context.contentType }, '[MetaPromptEngine] Generating prompt tree for');

    const systemPrompt = this.buildMetaSystemPrompt(context);
    const userPrompt = this.buildMetaUserPrompt(context);

    const response = await this.complete(userId, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      ...(userId ? {
        loggingContext: {
          userId,
          purpose: 'meta_prompt_generation',
          service: 'MetaPromptEngine',
          action: `generate_prompt_tree_${context.contentType}`,
        },
      } : {}),
    });

    if (!response.success || !response.content) {
      throw new Error(response.error || 'Failed to generate meta-prompt');
    }

    const parsedData = JSON.parse(response.content);

    return this.structurePromptTree(parsedData, context);
  }

  /**
   * Generate a single optimized prompt for a specific task
   */
  async generateSinglePrompt(
    context: MetaPromptContext,
    task: string,
    userId?: number
  ): Promise<GeneratedPrompt> {
    logger.info({ task: task }, '[MetaPromptEngine] Generating single prompt for task');

    const systemPrompt = `You are an expert prompt engineer specializing in marketing and sales content.
Your job is to create the most effective prompt for generating ${context.contentType} content.

Consider:
1. The target audience's psychology and pain points
2. Brand voice and messaging guidelines
3. Platform-specific best practices
4. Conversion optimization principles

Generate a prompt that will produce highly effective, on-brand content.`;

    const brandContext = this.buildBrandContext(context.brandToolkit);
    const icpContext = this.buildICPContext(context.icp);

    const userPrompt = `Task: ${task}

${icpContext}

${brandContext}

Platform: ${context.targetPlatform || 'General'}
Campaign Objective: ${context.campaignObjective || 'Generate engaging content'}
Additional Context: ${context.additionalContext || 'None'}

Generate an optimized prompt for this task. Return JSON:
{
  "title": "Brief title for this prompt",
  "prompt": "The actual prompt text to use",
  "systemContext": "System context/instructions to prepend",
  "suggestedParameters": {
    "temperature": 0.7,
    "maxTokens": 1000,
    "tone": "professional"
  }
}`;

    const response = await this.complete(userId, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      ...(userId ? {
        loggingContext: {
          userId,
          purpose: 'single_prompt_generation',
          service: 'MetaPromptEngine',
          action: `generate_single_prompt_${context.contentType}`,
        },
      } : {}),
    });

    if (!response.success || !response.content) {
      throw new Error(response.error || 'Failed to generate prompt');
    }

    const parsedData = JSON.parse(response.content);

    return {
      id: `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: context.contentType,
      title: parsedData.title || task,
      prompt: parsedData.prompt || '',
      systemContext: parsedData.systemContext || '',
      suggestedParameters: parsedData.suggestedParameters || {
        temperature: 0.7,
        maxTokens: 1000,
        tone: 'professional',
      },
    };
  }

  /**
   * Generate multiple prompt variations for A/B testing
   */
  async generatePromptVariations(
    context: MetaPromptContext,
    basePrompt: string,
    count: number = 3,
    userId?: number
  ): Promise<GeneratedPrompt[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
      throw new Error('Prompt variation count must be an integer from 1 to 20.');
    }
    logger.info({ count }, `[MetaPromptEngine] Generating ${count} prompt variations`);

    const systemPrompt = `You are an expert prompt engineer. Generate ${count} meaningful variations of the given prompt.
Each variation should:
1. Approach the topic from a different angle
2. Use different persuasion techniques
3. Vary in tone while staying on-brand
4. Target different emotional triggers

Return a JSON object with exactly ${count} usable prompts in its "variations" array, each with a unique strategy.`;

    const brandContext = this.buildBrandContext(context.brandToolkit);

    const userPrompt = `Base Prompt: "${basePrompt}"

${brandContext}

Generate ${count} variations optimized for ${context.contentType}.
Return JSON:
{
  "variations": [
    {
      "title": "Variation name/strategy",
      "prompt": "The varied prompt",
      "systemContext": "System context if needed",
      "suggestedParameters": {"temperature": 0.7, "maxTokens": 1000, "tone": "professional"},
      "strategy": "Explanation of the approach"
    }
  ]
}`;

    const response = await this.complete(userId, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
      ...(userId ? {
        loggingContext: {
          userId,
          purpose: 'prompt_variation_generation',
          service: 'MetaPromptEngine',
          action: `generate_variations_${context.contentType}`,
        },
      } : {}),
    });

    if (!response.success || !response.content) {
      throw new Error(response.error || 'Failed to generate variations');
    }

    const parsedData = JSON.parse(response.content);
    const variations = Array.isArray(parsedData) ? parsedData : parsedData?.variations;
    if (!Array.isArray(variations) || variations.length !== count) {
      throw new Error(`The provider must return exactly ${count} prompt variations.`);
    }
    if (variations.some((item: unknown) => !item || typeof item !== 'object'
      || typeof (item as { prompt?: unknown }).prompt !== 'string'
      || !(item as { prompt: string }).prompt.trim())) {
      throw new Error('The provider returned an empty or invalid prompt variation.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return variations.map((v: any, idx: number) => ({
      id: `variation_${Date.now()}_${idx}`,
      type: context.contentType,
      title: v.title || `Variation ${idx + 1}`,
      prompt: v.prompt.trim(),
      systemContext: v.systemContext || '',
      suggestedParameters: v.suggestedParameters || {
        temperature: 0.7,
        maxTokens: 1000,
        tone: 'professional',
      },
    }));
  }

  /**
   * Build the meta-system prompt for prompt tree generation
   */
  private buildMetaSystemPrompt(context: MetaPromptContext): string {
    return `You are a meta-prompt composer - an AI that creates optimal prompts for content generation.

Your task is to analyze the provided context and generate a complete "prompt tree" with:
1. A ROOT PROMPT: The main comprehensive prompt
2. BRANCH PROMPTS: Specialized prompts for hook, body, and CTA generation
3. VARIATIONS: Alternative approaches for A/B testing

Guidelines:
- Incorporate all brand guidelines and voice traits
- Address specific audience pain points and goals
- Optimize for the target platform's best practices
- Include psychological triggers and persuasion techniques
- Make prompts specific and actionable

Content Type: ${context.contentType}
Target Platform: ${context.targetPlatform || 'General'}

Return a structured JSON response with the complete prompt tree.`;
  }

  /**
   * Build user prompt for meta-prompt generation
   */
  private buildMetaUserPrompt(context: MetaPromptContext): string {
    const icpContext = this.buildICPContext(context.icp);
    const brandContext = this.buildBrandContext(context.brandToolkit);

    return `Generate a complete prompt tree for creating ${context.contentType} content.

${icpContext}

${brandContext}

Campaign Objective: ${context.campaignObjective || 'Generate high-converting content'}
Additional Context: ${context.additionalContext || 'None provided'}

Return JSON:
{
  "rootPrompt": {
    "title": "Main content generation prompt",
    "prompt": "Complete prompt for generating the full content",
    "systemContext": "System instructions to prepend",
    "suggestedParameters": {"temperature": 0.7, "maxTokens": 2000, "tone": "professional"}
  },
  "branches": {
    "hook": {
      "title": "Hook generation prompt",
      "prompt": "Prompt specifically for generating attention-grabbing hooks",
      "systemContext": "Hook-specific instructions",
      "suggestedParameters": {"temperature": 0.8, "maxTokens": 500, "tone": "engaging"}
    },
    "body": {
      "title": "Body content prompt",
      "prompt": "Prompt for generating the main body content",
      "systemContext": "Body content instructions",
      "suggestedParameters": {"temperature": 0.7, "maxTokens": 1500, "tone": "professional"}
    },
    "cta": {
      "title": "CTA generation prompt",
      "prompt": "Prompt for generating compelling CTAs",
      "systemContext": "CTA-specific instructions",
      "suggestedParameters": {"temperature": 0.6, "maxTokens": 300, "tone": "action-oriented"}
    }
  },
  "variations": [
    {
      "title": "Alternative approach 1",
      "prompt": "Alternative prompt using different strategy",
      "systemContext": "Alternative context",
      "suggestedParameters": {"temperature": 0.8, "maxTokens": 2000, "tone": "conversational"}
    }
  ],
  "confidenceScore": 0.85,
  "suggestedIterations": 3,
  "contextUsed": ["icp_industry", "brand_voice", "pain_points"]
}`;
  }

  /**
   * Build ICP context string
   */
  private buildICPContext(icp: ICPProfile): string {
    return `ICP (Ideal Customer Profile):
- Target Audience: ${icp.targetAudience || 'Not specified'}
- Industry: ${icp.industry || 'General'}
- Company Size: ${icp.targetCompanySizeRange || 'Varies'}
- Primary Pain Point: ${icp.primaryPainPoint || 'Not specified'}
- Value Proposition: ${icp.primaryValueProposition || 'Not specified'}
- Primary Channels: ${(icp.primaryChannels || []).join(', ') || 'Not specified'}
- Job Titles: ${(icp.primaryJobTitles || []).join(', ') || 'Not specified'}
- Budget Range: ${icp.budgetRange || 'Not specified'}`;
  }

  /**
   * Build brand context string
   */
  private buildBrandContext(toolkit?: BrandToolkit): string {
    if (!toolkit) {
      return 'Brand Guidelines: None provided - use professional defaults.';
    }

    return `Brand Guidelines:
- Brand Name: ${toolkit.brandName || 'Not specified'}
- Tagline: ${toolkit.tagline || 'None'}
- Mission: ${toolkit.missionStatement || 'None'}
- Brand Values: ${(toolkit.brandValues || []).join(', ') || 'Not specified'}
- Voice Traits: ${(toolkit.voicePersonalityTraits || []).join(', ') || 'Professional'}
- Voice Do's: ${(toolkit.voiceDos || []).join(', ') || 'None specified'}
- Voice Don'ts: ${(toolkit.voiceDonts || []).join(', ') || 'None specified'}
- Key Words: ${(toolkit.voiceKeywords || []).join(', ') || 'None'}
- Content Pillars: ${(toolkit.contentPillars || []).join(', ') || 'None'}
- Preferred CTAs: ${(toolkit.ctas || []).join(', ') || 'None'}
- Audience Pain Points: ${(toolkit.audiencePainPoints || []).join(', ') || 'None'}
- Audience Goals: ${(toolkit.audienceGoals || []).join(', ') || 'None'}
- Language Style: ${(toolkit.audienceLanguageStyle || []).join(', ') || 'Professional'}`;
  }

  /**
   * Structure the raw response into a MetaPromptTree
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private structurePromptTree(data: any, context: MetaPromptContext): MetaPromptTree {
    const timestamp = Date.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatPrompt = (raw: any, type: string, idx?: number): GeneratedPrompt => ({
      id: `${type}_${timestamp}_${idx || 0}`,
      type: context.contentType,
      title: raw?.title || type,
      prompt: raw?.prompt || '',
      systemContext: raw?.systemContext || '',
      suggestedParameters: raw?.suggestedParameters || {
        temperature: 0.7,
        maxTokens: 1000,
        tone: 'professional',
      },
    });

    return {
      rootPrompt: formatPrompt(data.rootPrompt, 'root'),
      branches: {
        hook: formatPrompt(data.branches?.hook, 'hook'),
        body: formatPrompt(data.branches?.body, 'body'),
        cta: formatPrompt(data.branches?.cta, 'cta'),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      variations: (data.variations || []).map((v: any, idx: number) =>
        formatPrompt(v, 'variation', idx)
      ),
      metadata: {
        contextUsed: data.contextUsed || [],
        confidenceScore: data.confidenceScore || 0.7,
        suggestedIterations: data.suggestedIterations || 2,
        createdAt: new Date(),
      },
    };
  }
}
