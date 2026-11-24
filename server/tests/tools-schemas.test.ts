/**
 * Test 6: Tool Schema Validation
 *
 * Tests the Zod schemas for every tool — required fields, optional fields,
 * enum constraints, and type validation.
 *
 * Schemas are replicated from: langgraph/tools/index.ts
 * Uses plain inline validation to avoid importing @langchain/*
 */
import { describe, it, expect } from '@jest/globals';

// ─── Helper: Minimal Schema Validator ──────────────────────────────────
// Replicating Zod-style validation inline to avoid the @langchain/zod import chain

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'enum' | 'object';

interface FieldDef {
  type: FieldType;
  required: boolean;
  enumValues?: string[];
  arrayType?: FieldType;
}

interface SchemaSpec {
  name: string;
  fields: Record<string, FieldDef>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateInput(schema: SchemaSpec, input: Record<string, any>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  // Check required fields
  for (const [field, def] of Object.entries(schema.fields)) {
    if (def.required && (input[field] === undefined || input[field] === null)) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }
    if (input[field] === undefined || input[field] === null) continue;
    // Type checks
    if (def.type === 'string' && typeof input[field] !== 'string') errors.push(`${field} must be string`);
    if (def.type === 'number' && typeof input[field] !== 'number') errors.push(`${field} must be number`);
    if (def.type === 'boolean' && typeof input[field] !== 'boolean') errors.push(`${field} must be boolean`);
    if (def.type === 'array' && !Array.isArray(input[field])) errors.push(`${field} must be array`);
    if (def.type === 'enum' && def.enumValues && !def.enumValues.includes(input[field])) {
      errors.push(`${field} must be one of: ${def.enumValues.join(', ')}`);
    }
  }
  // Check for unknown fields
  for (const key of Object.keys(input)) {
    if (!schema.fields[key]) errors.push(`Unknown field: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

// ─── Schema Definitions (replicated from tools/index.ts) ──────────────

const schemas: Record<string, SchemaSpec> = {
  generate_icp: {
    name: 'generate_icp',
    fields: {
      user_message: { type: 'string', required: true },
    },
  },
  save_business_profile: {
    name: 'save_business_profile',
    fields: {
      company_name: { type: 'string', required: true },
      industry: { type: 'string', required: false },
      city: { type: 'string', required: false },
      country: { type: 'string', required: false },
      description: { type: 'string', required: false },
    },
  },
  generate_lead_inputs: {
    name: 'generate_lead_inputs',
    fields: {
      icp_id: { type: 'number', required: false },
      platforms: { type: 'array', required: false, arrayType: 'string' },
    },
  },
  execute_lead_workflow: {
    name: 'execute_lead_workflow',
    fields: {
      thread_id: { type: 'number', required: false },
      platforms: { type: 'array', required: false, arrayType: 'string' },
    },
  },
  select_brand_toolkit: {
    name: 'select_brand_toolkit',
    fields: {
      action: { type: 'enum', required: true, enumValues: ['list', 'select', 'create', 'skip'] },
      toolkit_id: { type: 'number', required: false },
      toolkit_name: { type: 'string', required: false },
    },
  },
  generate_image: {
    name: 'generate_image',
    fields: {
      prompt: { type: 'string', required: true },
      provider: { type: 'enum', required: false, enumValues: ['google', 'openrouter'] },
      model: { type: 'string', required: false },
    },
  },
  generate_video: {
    name: 'generate_video',
    fields: {
      prompt: { type: 'string', required: true },
      provider: { type: 'enum', required: false, enumValues: ['google', 'openrouter'] },
      model: { type: 'string', required: false },
    },
  },
  generate_image_from_image: {
    name: 'generate_image_from_image',
    fields: {
      prompt: { type: 'string', required: true },
      source_image_id: { type: 'string', required: false },
      provider: { type: 'enum', required: false, enumValues: ['google', 'openrouter'] },
      model: { type: 'string', required: false },
    },
  },
  generate_video_from_image: {
    name: 'generate_video_from_image',
    fields: {
      prompt: { type: 'string', required: true },
      source_image_id: { type: 'string', required: false },
      provider: { type: 'enum', required: false, enumValues: ['google', 'openrouter'] },
      model: { type: 'string', required: false },
    },
  },
  generate_social_media_post: {
    name: 'generate_social_media_post',
    fields: {
      platform: { type: 'enum', required: true, enumValues: ['linkedin', 'twitter', 'facebook', 'instagram', 'all'] },
      topic: { type: 'string', required: true },
      include_image_prompt: { type: 'boolean', required: false },
      include_video_prompt: { type: 'boolean', required: false },
      auto_generate_image: { type: 'boolean', required: false },
      auto_generate_video: { type: 'boolean', required: false },
      hashtags: { type: 'boolean', required: false },
      brand_toolkit_id: { type: 'number', required: false },
    },
  },
  generate_social_chat_template: {
    name: 'generate_social_chat_template',
    fields: {
      platform: { type: 'enum', required: true, enumValues: ['linkedin', 'instagram', 'twitter', 'messenger'] },
      objective: { type: 'string', required: true },
      tone: { type: 'enum', required: false, enumValues: ['professional', 'friendly', 'casual', 'persuasive'] },
      recipient_context: { type: 'string', required: false },
      include_follow_ups: { type: 'boolean', required: false },
      include_image_prompt: { type: 'boolean', required: false },
      include_video_prompt: { type: 'boolean', required: false },
      auto_generate_image: { type: 'boolean', required: false },
      auto_generate_video: { type: 'boolean', required: false },
    },
  },
  generate_email_template: {
    name: 'generate_email_template',
    fields: {
      subject_line: { type: 'string', required: false },
      recipient_role: { type: 'string', required: true },
      email_body_points: { type: 'array', required: false, arrayType: 'string' },
      tone: { type: 'enum', required: false, enumValues: ['professional', 'friendly', 'urgent', 'persuasive'] },
    },
  },
  generate_sms_template: {
    name: 'generate_sms_template',
    fields: {
      campaign_name: { type: 'string', required: false },
      target_audience: { type: 'string', required: false },
      key_message: { type: 'string', required: true },
      call_to_action: { type: 'string', required: false },
    },
  },
  send_outreach_messages: {
    name: 'send_outreach_messages',
    fields: {
      lead_ids: { type: 'array', required: true, arrayType: 'number' },
      channel: { type: 'enum', required: true, enumValues: ['email', 'sms'] },
      template_id: { type: 'string', required: true },
    },
  },
  generate_ad: {
    name: 'generate_ad',
    fields: {
      platform: { type: 'enum', required: true, enumValues: ['facebook', 'instagram'] },
      goal: { type: 'string', required: true },
      headline: { type: 'string', required: false },
      primary_text: { type: 'string', required: false },
      include_image_prompt: { type: 'boolean', required: false },
      include_video_prompt: { type: 'boolean', required: false },
      auto_generate_image: { type: 'boolean', required: false },
      auto_generate_video: { type: 'boolean', required: false },
    },
  },
  publish_meta_ads: {
    name: 'publish_meta_ads',
    fields: {
      campaign_id: { type: 'string', required: true },
      budget: { type: 'number', required: true },
      placements: { type: 'array', required: false, arrayType: 'string' },
    },
  },
  analytics_query: {
    name: 'analytics_query',
    fields: {
      question: { type: 'string', required: true },
      query_type: { type: 'enum', required: true, enumValues: ['campaign', 'lead', 'outreach', 'overview'] },
    },
  },
  switch_agent: {
    name: 'switch_agent',
    fields: {
      target_agent: { type: 'enum', required: true, enumValues: ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'] },
      reason: { type: 'string', required: true },
    },
  },
  tasks_completed: {
    name: 'tasks_completed',
    fields: {
      summary: { type: 'string', required: true },
    },
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────

describe('generate_icp Schema', () => {
  const s = schemas.generate_icp;
  it('accepts valid input with user_message', () => {
    expect(validateInput(s, { user_message: 'I want to target SaaS companies' }).valid).toBe(true);
  });
  it('rejects missing user_message', () => {
    const r = validateInput(s, {});
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Missing required field: user_message');
  });
  it('rejects non-string user_message', () => {
    expect(validateInput(s, { user_message: 123 }).valid).toBe(false);
  });
});

describe('save_business_profile Schema', () => {
  const s = schemas.save_business_profile;
  it('accepts valid full input', () => {
    expect(validateInput(s, {
      company_name: 'Acme Corp', industry: 'SaaS', city: 'SF', country: 'US', description: 'B2B platform',
    }).valid).toBe(true);
  });
  it('accepts minimal input (only company_name)', () => {
    expect(validateInput(s, { company_name: 'Acme Corp' }).valid).toBe(true);
  });
  it('rejects missing company_name', () => {
    const r = validateInput(s, { industry: 'SaaS' });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Missing required field: company_name');
  });
  it('optional fields can be omitted', () => {
    expect(validateInput(s, { company_name: 'Test' }).valid).toBe(true);
  });
});

describe('generate_lead_inputs Schema', () => {
  const s = schemas.generate_lead_inputs;
  it('accepts empty input (all fields optional)', () => {
    expect(validateInput(s, {}).valid).toBe(true);
  });
  it('accepts icp_id only', () => {
    expect(validateInput(s, { icp_id: 42 }).valid).toBe(true);
  });
  it('accepts platforms array', () => {
    expect(validateInput(s, { platforms: ['linkedin', 'google_maps'] }).valid).toBe(true);
  });
  it('rejects non-number icp_id', () => {
    expect(validateInput(s, { icp_id: 'abc' }).valid).toBe(false);
  });
  it('rejects non-array platforms', () => {
    expect(validateInput(s, { platforms: 'linkedin' }).valid).toBe(false);
  });
});

describe('execute_lead_workflow Schema', () => {
  const s = schemas.execute_lead_workflow;
  it('accepts empty input (all optional)', () => {
    expect(validateInput(s, {}).valid).toBe(true);
  });
  it('accepts thread_id and platforms', () => {
    expect(validateInput(s, { thread_id: 5, platforms: ['linkedin'] }).valid).toBe(true);
  });
  it('rejects non-number thread_id', () => {
    expect(validateInput(s, { thread_id: 'five' }).valid).toBe(false);
  });
});

describe('select_brand_toolkit Schema', () => {
  const s = schemas.select_brand_toolkit;
  it('accepts list action', () => {
    expect(validateInput(s, { action: 'list' }).valid).toBe(true);
  });
  it('accepts select action with toolkit_id', () => {
    expect(validateInput(s, { action: 'select', toolkit_id: 7 }).valid).toBe(true);
  });
  it('accepts select action with toolkit_name', () => {
    expect(validateInput(s, { action: 'select', toolkit_name: 'Corporate' }).valid).toBe(true);
  });
  it('accepts create and skip actions', () => {
    expect(validateInput(s, { action: 'create' }).valid).toBe(true);
    expect(validateInput(s, { action: 'skip' }).valid).toBe(true);
  });
  it('rejects invalid action enum', () => {
    expect(validateInput(s, { action: 'delete' }).valid).toBe(false);
  });
  it('rejects missing action', () => {
    const r = validateInput(s, {});
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Missing required field: action');
  });
});

describe('generate_image Schema', () => {
  const s = schemas.generate_image;
  it('accepts valid prompt', () => {
    expect(validateInput(s, { prompt: 'A futuristic cityscape' }).valid).toBe(true);
  });
  it('accepts OpenRouter image model overrides and rejects unknown providers', () => {
    expect(validateInput(s, { prompt: 'Launch visual', provider: 'openrouter', model: 'bytedance-seed/seedream-5-0-pro' }).valid).toBe(true);
    expect(validateInput(s, { prompt: 'Launch visual', provider: 'unknown' }).valid).toBe(false);
  });
  it('rejects missing prompt', () => {
    expect(validateInput(s, {}).valid).toBe(false);
  });
  it('rejects non-string prompt', () => {
    expect(validateInput(s, { prompt: 42 }).valid).toBe(false);
  });
});

describe('generate_video Schema', () => {
  const s = schemas.generate_video;
  it('accepts valid prompt', () => {
    expect(validateInput(s, { prompt: 'A product demo animation' }).valid).toBe(true);
  });
  it('accepts OpenRouter Seedance overrides', () => {
    expect(validateInput(s, { prompt: 'A product demo animation', provider: 'openrouter', model: 'bytedance/seedance-2.5' }).valid).toBe(true);
  });
  it('rejects missing prompt', () => {
    expect(validateInput(s, {}).valid).toBe(false);
  });
});

describe('generate_image_from_image Schema', () => {
  const s = schemas.generate_image_from_image;
  it('accepts prompt with source_image_id', () => {
    expect(validateInput(s, { prompt: 'Transform to watercolor', source_image_id: 'img-123' }).valid).toBe(true);
  });
  it('accepts prompt only (source_image_id optional)', () => {
    expect(validateInput(s, { prompt: 'Apply vintage filter' }).valid).toBe(true);
  });
  it('rejects missing prompt', () => {
    expect(validateInput(s, { source_image_id: 'img-123' }).valid).toBe(false);
  });
});

describe('generate_video_from_image Schema', () => {
  const s = schemas.generate_video_from_image;
  it('accepts prompt with source_image_id', () => {
    expect(validateInput(s, { prompt: 'Zoom into the scene', source_image_id: 'img-456' }).valid).toBe(true);
  });
  it('accepts prompt only', () => {
    expect(validateInput(s, { prompt: 'Animate the logo' }).valid).toBe(true);
  });
  it('rejects missing prompt', () => {
    expect(validateInput(s, {}).valid).toBe(false);
  });
});

describe('generate_social_media_post Schema', () => {
  const s = schemas.generate_social_media_post;
  it('accepts valid minimal input', () => {
    expect(validateInput(s, { platform: 'all', topic: 'New product launch' }).valid).toBe(true);
  });
  it('accepts all platform enums', () => {
    for (const p of ['linkedin', 'twitter', 'facebook', 'instagram', 'all']) {
      expect(validateInput(s, { platform: p, topic: 'test' }).valid).toBe(true);
    }
  });
  it('accepts full input with all optional fields', () => {
    expect(validateInput(s, {
      platform: 'linkedin', topic: 'AI trends',
      include_image_prompt: true, include_video_prompt: false,
      auto_generate_image: true, auto_generate_video: false,
      hashtags: true, brand_toolkit_id: 3,
    }).valid).toBe(true);
  });
  it('rejects invalid platform', () => {
    expect(validateInput(s, { platform: 'tiktok', topic: 'test' }).valid).toBe(false);
  });
  it('rejects missing topic', () => {
    expect(validateInput(s, { platform: 'all' }).valid).toBe(false);
  });
  it('rejects missing platform', () => {
    expect(validateInput(s, { topic: 'test' }).valid).toBe(false);
  });
});

describe('generate_social_chat_template Schema', () => {
  const s = schemas.generate_social_chat_template;
  it('accepts valid minimal input', () => {
    expect(validateInput(s, { platform: 'linkedin', objective: 'introduction' }).valid).toBe(true);
  });
  it('accepts all platform enums', () => {
    for (const p of ['linkedin', 'instagram', 'twitter', 'messenger']) {
      expect(validateInput(s, { platform: p, objective: 'intro' }).valid).toBe(true);
    }
  });
  it('accepts all tone enums', () => {
    for (const t of ['professional', 'friendly', 'casual', 'persuasive']) {
      expect(validateInput(s, { platform: 'linkedin', objective: 'intro', tone: t }).valid).toBe(true);
    }
  });
  it('accepts full input with all optional fields', () => {
    expect(validateInput(s, {
      platform: 'instagram', objective: 'pitch', tone: 'friendly',
      recipient_context: 'CEO of startup', include_follow_ups: true,
      include_image_prompt: false, include_video_prompt: false,
      auto_generate_image: false, auto_generate_video: false,
    }).valid).toBe(true);
  });
  it('rejects invalid platform', () => {
    expect(validateInput(s, { platform: 'whatsapp', objective: 'intro' }).valid).toBe(false);
  });
  it('rejects invalid tone', () => {
    expect(validateInput(s, { platform: 'linkedin', objective: 'intro', tone: 'aggressive' }).valid).toBe(false);
  });
  it('rejects missing objective', () => {
    expect(validateInput(s, { platform: 'linkedin' }).valid).toBe(false);
  });
});

describe('generate_email_template Schema', () => {
  const s = schemas.generate_email_template;
  it('accepts valid minimal input', () => {
    expect(validateInput(s, { recipient_role: 'CTO' }).valid).toBe(true);
  });
  it('accepts full input', () => {
    expect(validateInput(s, {
      subject_line: 'Partnership Opportunity',
      recipient_role: 'VP of Sales',
      email_body_points: ['Introduce product', 'Mention ROI', 'CTA for call'],
      tone: 'professional',
    }).valid).toBe(true);
  });
  it('accepts all tone enums', () => {
    for (const t of ['professional', 'friendly', 'urgent', 'persuasive']) {
      expect(validateInput(s, { recipient_role: 'Manager', tone: t }).valid).toBe(true);
    }
  });
  it('rejects missing recipient_role', () => {
    expect(validateInput(s, { subject_line: 'Hello' }).valid).toBe(false);
  });
  it('rejects invalid tone', () => {
    expect(validateInput(s, { recipient_role: 'CEO', tone: 'angry' }).valid).toBe(false);
  });
});

describe('generate_sms_template Schema', () => {
  const s = schemas.generate_sms_template;
  it('accepts valid minimal input', () => {
    expect(validateInput(s, { key_message: '50% off today only!' }).valid).toBe(true);
  });
  it('accepts full input', () => {
    expect(validateInput(s, {
      campaign_name: 'Summer Sale', target_audience: 'E-commerce buyers',
      key_message: 'Limited time offer', call_to_action: 'Shop now at example.com',
    }).valid).toBe(true);
  });
  it('rejects missing key_message', () => {
    expect(validateInput(s, { campaign_name: 'Sale' }).valid).toBe(false);
  });
});

describe('send_outreach_messages Schema', () => {
  const s = schemas.send_outreach_messages;
  it('accepts valid input', () => {
    expect(validateInput(s, {
      lead_ids: [1, 2, 3], channel: 'email', template_id: 'tmpl-001',
    }).valid).toBe(true);
  });
  it('accepts sms channel', () => {
    expect(validateInput(s, {
      lead_ids: [5], channel: 'sms', template_id: 'tmpl-002',
    }).valid).toBe(true);
  });
  it('rejects invalid channel', () => {
    expect(validateInput(s, {
      lead_ids: [1], channel: 'whatsapp', template_id: 'tmpl-001',
    }).valid).toBe(false);
  });
  it('rejects missing lead_ids', () => {
    expect(validateInput(s, { channel: 'email', template_id: 'tmpl-001' }).valid).toBe(false);
  });
  it('rejects missing channel', () => {
    expect(validateInput(s, { lead_ids: [1], template_id: 'tmpl-001' }).valid).toBe(false);
  });
  it('rejects missing template_id', () => {
    expect(validateInput(s, { lead_ids: [1], channel: 'email' }).valid).toBe(false);
  });
  it('rejects non-array lead_ids', () => {
    expect(validateInput(s, { lead_ids: 1, channel: 'email', template_id: 'tmpl-001' }).valid).toBe(false);
  });
});

describe('generate_ad Schema', () => {
  const s = schemas.generate_ad;
  it('accepts valid minimal input', () => {
    expect(validateInput(s, { platform: 'facebook', goal: 'Lead generation' }).valid).toBe(true);
  });
  it('accepts instagram platform', () => {
    expect(validateInput(s, { platform: 'instagram', goal: 'Brand awareness' }).valid).toBe(true);
  });
  it('accepts full input', () => {
    expect(validateInput(s, {
      platform: 'facebook', goal: 'Conversions',
      headline: 'Get 50% Off', primary_text: 'Limited time deal',
      include_image_prompt: true, include_video_prompt: false,
      auto_generate_image: true, auto_generate_video: false,
    }).valid).toBe(true);
  });
  it('rejects invalid platform (google is not supported)', () => {
    expect(validateInput(s, { platform: 'google', goal: 'Traffic' }).valid).toBe(false);
  });
  it('rejects missing goal', () => {
    expect(validateInput(s, { platform: 'facebook' }).valid).toBe(false);
  });
  it('rejects missing platform', () => {
    expect(validateInput(s, { goal: 'Traffic' }).valid).toBe(false);
  });
});

describe('publish_meta_ads Schema', () => {
  const s = schemas.publish_meta_ads;
  it('accepts valid input', () => {
    expect(validateInput(s, { campaign_id: 'camp-123', budget: 50 }).valid).toBe(true);
  });
  it('accepts input with placements', () => {
    expect(validateInput(s, {
      campaign_id: 'camp-456', budget: 100, placements: ['facebook_feed', 'instagram_stories'],
    }).valid).toBe(true);
  });
  it('rejects missing campaign_id', () => {
    expect(validateInput(s, { budget: 50 }).valid).toBe(false);
  });
  it('rejects missing budget', () => {
    expect(validateInput(s, { campaign_id: 'camp-123' }).valid).toBe(false);
  });
  it('rejects non-number budget', () => {
    expect(validateInput(s, { campaign_id: 'camp-123', budget: 'fifty' }).valid).toBe(false);
  });
});

describe('analytics_query Schema', () => {
  const s = schemas.analytics_query;
  it('accepts valid campaign query', () => {
    expect(validateInput(s, { question: 'How did my last campaign perform?', query_type: 'campaign' }).valid).toBe(true);
  });
  it('accepts all query_type enums', () => {
    for (const qt of ['campaign', 'lead', 'outreach', 'overview']) {
      expect(validateInput(s, { question: 'Show me stats', query_type: qt }).valid).toBe(true);
    }
  });
  it('rejects invalid query_type', () => {
    expect(validateInput(s, { question: 'Show me', query_type: 'financial' }).valid).toBe(false);
  });
  it('rejects missing question', () => {
    expect(validateInput(s, { query_type: 'campaign' }).valid).toBe(false);
  });
  it('rejects missing query_type', () => {
    expect(validateInput(s, { question: 'Show me' }).valid).toBe(false);
  });
});

describe('switch_agent Schema', () => {
  const s = schemas.switch_agent;
  it('accepts valid agent switch', () => {
    expect(validateInput(s, { target_agent: 'content_studio', reason: 'User wants to create content' }).valid).toBe(true);
  });
  it('accepts all valid target agents', () => {
    for (const a of ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing']) {
      expect(validateInput(s, { target_agent: a, reason: 'test' }).valid).toBe(true);
    }
  });
  it('rejects orchestrator as target (cannot switch to self)', () => {
    expect(validateInput(s, { target_agent: 'orchestrator', reason: 'test' }).valid).toBe(false);
  });
  it('rejects supervisor as target', () => {
    expect(validateInput(s, { target_agent: 'supervisor', reason: 'test' }).valid).toBe(false);
  });
  it('rejects missing target_agent', () => {
    expect(validateInput(s, { reason: 'test' }).valid).toBe(false);
  });
  it('rejects missing reason', () => {
    expect(validateInput(s, { target_agent: 'outreach' }).valid).toBe(false);
  });
});

describe('tasks_completed Schema', () => {
  const s = schemas.tasks_completed;
  it('accepts valid summary', () => {
    expect(validateInput(s, { summary: 'Generated ICP profile with 85% fit score' }).valid).toBe(true);
  });
  it('rejects missing summary', () => {
    expect(validateInput(s, {}).valid).toBe(false);
  });
  it('rejects non-string summary', () => {
    expect(validateInput(s, { summary: 42 }).valid).toBe(false);
  });
});

describe('Schema Coverage', () => {
  const allToolNames = [
    'generate_icp', 'save_business_profile', 'generate_lead_inputs', 'execute_lead_workflow',
    'select_brand_toolkit', 'generate_image', 'generate_video', 'generate_image_from_image',
    'generate_video_from_image', 'generate_social_media_post', 'generate_social_chat_template',
    'generate_email_template', 'generate_sms_template', 'send_outreach_messages',
    'generate_ad', 'publish_meta_ads', 'analytics_query', 'switch_agent', 'tasks_completed',
  ];

  it('every tool has a schema defined', () => {
    for (const name of allToolNames) {
      expect(schemas[name]).toBeDefined();
    }
  });

  it('schema count matches tool count (19)', () => {
    expect(Object.keys(schemas)).toHaveLength(19);
  });

  it('every schema has at least one field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [name, schema] of Object.entries(schemas)) {
      expect(Object.keys(schema.fields).length).toBeGreaterThan(0);
    }
  });
});
