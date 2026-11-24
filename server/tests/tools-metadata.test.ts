/**
 * Test 5: Tool Metadata, Agent-Tool Mapping & Approval Logic
 *
 * Tests the tool metadata registry, agent-to-tool assignment,
 * approval-required tool detection, and helper functions.
 *
 * Logic replicated from: langgraph/tools/index.ts
 * (no imports to avoid ts-jest OOM on @langchain/*)
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types ──────────────────────────────────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

interface ToolMeta {
  name: string;
  description: string;
  agent: AgentType;
  requiresApproval: boolean;
}

// ─── Replicated from tools/index.ts ────────────────────────────────────
const toolMetadata: Record<string, ToolMeta> = {
  generate_icp: { name: 'generate_icp', description: 'Generate an Ideal Customer Profile (ICP) based on user requirements.', agent: 'orchestrator', requiresApproval: false },
  save_business_profile: { name: 'save_business_profile', description: 'Save business profile information provided by the user during conversation.', agent: 'icp_generation', requiresApproval: false },
  generate_lead_inputs: { name: 'generate_lead_inputs', description: 'Generate search parameters and inputs for lead generation based on an existing ICP.', agent: 'lead_generation', requiresApproval: false },
  execute_lead_workflow: { name: 'execute_lead_workflow', description: 'Execute a lead generation workflow to scrape leads from platforms. Requires user approval.', agent: 'lead_generation', requiresApproval: true },
  select_brand_toolkit: { name: 'select_brand_toolkit', description: 'Get available brand toolkits for the user.', agent: 'content_studio', requiresApproval: false },
  generate_image: { name: 'generate_image', description: 'Generate an image using AI based on a text prompt.', agent: 'content_studio', requiresApproval: false },
  generate_video: { name: 'generate_video', description: 'Generate a video using AI based on a text prompt.', agent: 'content_studio', requiresApproval: false },
  generate_image_from_image: { name: 'generate_image_from_image', description: 'Generate a new image based on an existing image and a text prompt.', agent: 'content_studio', requiresApproval: false },
  generate_video_from_image: { name: 'generate_video_from_image', description: 'Generate a video from a static image and a text prompt.', agent: 'content_studio', requiresApproval: false },
  generate_social_media_post: { name: 'generate_social_media_post', description: 'Generate a comprehensive social media post.', agent: 'content_studio', requiresApproval: false },
  generate_social_chat_template: { name: 'generate_social_chat_template', description: 'Generate a direct message or chat template.', agent: 'content_studio', requiresApproval: false },
  generate_email_template: { name: 'generate_email_template', description: 'Generate an email marketing template.', agent: 'outreach', requiresApproval: false },
  generate_sms_template: { name: 'generate_sms_template', description: 'Generate an SMS marketing template.', agent: 'outreach', requiresApproval: false },
  send_outreach_messages: { name: 'send_outreach_messages', description: 'Send outreach messages to selected leads. Requires user approval.', agent: 'outreach', requiresApproval: true },
  generate_ad: { name: 'generate_ad', description: 'Generate ad copy with creative concepts.', agent: 'performance_marketing', requiresApproval: false },
  publish_meta_ads: { name: 'publish_meta_ads', description: 'Publish a campaign to Meta Ads. Requires user approval.', agent: 'performance_marketing', requiresApproval: true },
  analytics_query: { name: 'analytics_query', description: 'Query analytics data for campaigns, leads, or outreach.', agent: 'performance_marketing', requiresApproval: false },
  switch_agent: { name: 'switch_agent', description: 'Switch the active agent to a specialized agent.', agent: 'orchestrator', requiresApproval: false },
  tasks_completed: { name: 'tasks_completed', description: 'Signal that all assigned tasks have been completed.', agent: 'orchestrator', requiresApproval: false },
};

const agentToolMapping: Record<AgentType, string[]> = {
  orchestrator: ['generate_icp', 'save_business_profile', 'switch_agent'],
  supervisor: ['switch_agent'],
  icp_generation: ['generate_icp', 'switch_agent', 'tasks_completed'],
  lead_generation: ['generate_lead_inputs', 'execute_lead_workflow', 'switch_agent', 'tasks_completed'],
  content_studio: [
    'select_brand_toolkit', 'generate_image', 'generate_video',
    'generate_image_from_image', 'generate_video_from_image',
    'generate_social_media_post', 'generate_social_chat_template',
    'generate_email_template', 'generate_sms_template',
    'switch_agent', 'tasks_completed',
  ],
  outreach: ['send_outreach_messages', 'switch_agent', 'tasks_completed'],
  performance_marketing: ['generate_ad', 'publish_meta_ads', 'analytics_query', 'switch_agent', 'tasks_completed'],
};

function toolRequiresApproval(toolName: string): boolean {
  return toolMetadata[toolName]?.requiresApproval ?? false;
}

function getApprovalRequiredTools(): string[] {
  return Object.entries(toolMetadata)
    .filter(([_, meta]) => meta.requiresApproval)
    .map(([name]) => name);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Tool Metadata Registry', () => {
  const allToolNames = Object.keys(toolMetadata);

  it('contains exactly 19 tools', () => {
    expect(allToolNames).toHaveLength(19);
  });

  it('every tool has name, description, agent, and requiresApproval', () => {
    for (const [key, meta] of Object.entries(toolMetadata)) {
      expect(meta.name).toBe(key);
      expect(meta.description).toBeTruthy();
      expect(meta.agent).toBeTruthy();
      expect(typeof meta.requiresApproval).toBe('boolean');
    }
  });

  it('tool names match their keys', () => {
    for (const [key, meta] of Object.entries(toolMetadata)) {
      expect(meta.name).toBe(key);
    }
  });

  it('descriptions are non-empty strings', () => {
    for (const meta of Object.values(toolMetadata)) {
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(10);
    }
  });

  it('every tool belongs to a valid agent', () => {
    const validAgents: AgentType[] = [
      'orchestrator', 'supervisor', 'icp_generation',
      'lead_generation', 'content_studio', 'outreach', 'performance_marketing',
    ];
    for (const meta of Object.values(toolMetadata)) {
      expect(validAgents).toContain(meta.agent);
    }
  });
});

describe('Agent Tool Mapping', () => {
  const allAgents: AgentType[] = [
    'orchestrator', 'supervisor', 'icp_generation',
    'lead_generation', 'content_studio', 'outreach', 'performance_marketing',
  ];

  it('every agent has a tool mapping', () => {
    for (const agent of allAgents) {
      expect(agentToolMapping[agent]).toBeDefined();
      expect(Array.isArray(agentToolMapping[agent])).toBe(true);
    }
  });

  it('every mapped tool exists in toolMetadata', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [agent, tools] of Object.entries(agentToolMapping)) {
      for (const toolName of tools) {
        expect(toolMetadata[toolName]).toBeDefined();
      }
    }
  });

  it('orchestrator has ICP-related and switch tools', () => {
    const tools = agentToolMapping.orchestrator;
    expect(tools).toContain('generate_icp');
    expect(tools).toContain('save_business_profile');
    expect(tools).toContain('switch_agent');
    expect(tools).not.toContain('tasks_completed');
  });

  it('supervisor only has switch_agent', () => {
    const tools = agentToolMapping.supervisor;
    expect(tools).toEqual(['switch_agent']);
  });

  it('icp_generation has ICP generation and utility tools', () => {
    const tools = agentToolMapping.icp_generation;
    expect(tools).toContain('generate_icp');
    expect(tools).toContain('switch_agent');
    expect(tools).toContain('tasks_completed');
    expect(tools).not.toContain('generate_image');
  });

  it('lead_generation has lead tools and utility tools', () => {
    const tools = agentToolMapping.lead_generation;
    expect(tools).toContain('generate_lead_inputs');
    expect(tools).toContain('execute_lead_workflow');
    expect(tools).toContain('switch_agent');
    expect(tools).toContain('tasks_completed');
    expect(tools).not.toContain('generate_image');
  });

  it('content_studio has the most tools (11)', () => {
    const tools = agentToolMapping.content_studio;
    expect(tools).toHaveLength(11);
    expect(tools).toContain('select_brand_toolkit');
    expect(tools).toContain('generate_image');
    expect(tools).toContain('generate_video');
    expect(tools).toContain('generate_image_from_image');
    expect(tools).toContain('generate_video_from_image');
    expect(tools).toContain('generate_social_media_post');
    expect(tools).toContain('generate_social_chat_template');
    expect(tools).toContain('generate_email_template');
    expect(tools).toContain('generate_sms_template');
    expect(tools).toContain('switch_agent');
    expect(tools).toContain('tasks_completed');
  });

  it('outreach has messaging tool and utility tools', () => {
    const tools = agentToolMapping.outreach;
    expect(tools).toContain('send_outreach_messages');
    expect(tools).toContain('switch_agent');
    expect(tools).toContain('tasks_completed');
    expect(tools).toHaveLength(3);
  });

  it('performance_marketing has ad, analytics, and utility tools', () => {
    const tools = agentToolMapping.performance_marketing;
    expect(tools).toContain('generate_ad');
    expect(tools).toContain('publish_meta_ads');
    expect(tools).toContain('analytics_query');
    expect(tools).toContain('switch_agent');
    expect(tools).toContain('tasks_completed');
    expect(tools).toHaveLength(5);
  });

  it('switch_agent is available to every agent', () => {
    for (const agent of allAgents) {
      expect(agentToolMapping[agent]).toContain('switch_agent');
    }
  });

  it('tasks_completed is available to all specialist agents but not orchestrator/supervisor', () => {
    const specialists: AgentType[] = ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'];
    for (const agent of specialists) {
      expect(agentToolMapping[agent]).toContain('tasks_completed');
    }
    expect(agentToolMapping.orchestrator).not.toContain('tasks_completed');
    expect(agentToolMapping.supervisor).not.toContain('tasks_completed');
  });

  it('content_studio can also generate email/SMS templates (cross-agent capability)', () => {
    expect(agentToolMapping.content_studio).toContain('generate_email_template');
    expect(agentToolMapping.content_studio).toContain('generate_sms_template');
  });

  it('no duplicate tools within any agent mapping', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [agent, tools] of Object.entries(agentToolMapping)) {
      const unique = new Set(tools);
      expect(unique.size).toBe(tools.length);
    }
  });
});

describe('Approval Required Detection', () => {
  it('execute_lead_workflow requires approval', () => {
    expect(toolRequiresApproval('execute_lead_workflow')).toBe(true);
  });

  it('send_outreach_messages requires approval', () => {
    expect(toolRequiresApproval('send_outreach_messages')).toBe(true);
  });

  it('publish_meta_ads requires approval', () => {
    expect(toolRequiresApproval('publish_meta_ads')).toBe(true);
  });

  it('generate_icp does NOT require approval', () => {
    expect(toolRequiresApproval('generate_icp')).toBe(false);
  });

  it('generate_image does NOT require approval', () => {
    expect(toolRequiresApproval('generate_image')).toBe(false);
  });

  it('switch_agent does NOT require approval', () => {
    expect(toolRequiresApproval('switch_agent')).toBe(false);
  });

  it('tasks_completed does NOT require approval', () => {
    expect(toolRequiresApproval('tasks_completed')).toBe(false);
  });

  it('unknown tool does NOT require approval (fallback false)', () => {
    expect(toolRequiresApproval('nonexistent_tool')).toBe(false);
  });

  it('getApprovalRequiredTools returns exactly 3 tools', () => {
    const approvalTools = getApprovalRequiredTools();
    expect(approvalTools).toHaveLength(3);
    expect(approvalTools).toContain('execute_lead_workflow');
    expect(approvalTools).toContain('send_outreach_messages');
    expect(approvalTools).toContain('publish_meta_ads');
  });

  it('all non-approval tools are correctly marked false', () => {
    const nonApproval = Object.values(toolMetadata).filter(m => !m.requiresApproval);
    expect(nonApproval.length).toBe(16); // 19 - 3
    for (const m of nonApproval) {
      expect(toolRequiresApproval(m.name)).toBe(false);
    }
  });
});

describe('Tool Agent Ownership', () => {
  it('ICP tools belong to orchestrator/icp_generation', () => {
    expect(toolMetadata.generate_icp.agent).toBe('orchestrator');
    expect(toolMetadata.save_business_profile.agent).toBe('icp_generation');
  });

  it('lead tools belong to lead_generation', () => {
    expect(toolMetadata.generate_lead_inputs.agent).toBe('lead_generation');
    expect(toolMetadata.execute_lead_workflow.agent).toBe('lead_generation');
  });

  it('content tools belong to content_studio', () => {
    const contentTools = ['select_brand_toolkit', 'generate_image', 'generate_video',
      'generate_image_from_image', 'generate_video_from_image',
      'generate_social_media_post', 'generate_social_chat_template'];
    for (const name of contentTools) {
      expect(toolMetadata[name].agent).toBe('content_studio');
    }
  });

  it('outreach tools belong to outreach', () => {
    expect(toolMetadata.generate_email_template.agent).toBe('outreach');
    expect(toolMetadata.generate_sms_template.agent).toBe('outreach');
    expect(toolMetadata.send_outreach_messages.agent).toBe('outreach');
  });

  it('performance marketing tools belong to performance_marketing', () => {
    expect(toolMetadata.generate_ad.agent).toBe('performance_marketing');
    expect(toolMetadata.publish_meta_ads.agent).toBe('performance_marketing');
    expect(toolMetadata.analytics_query.agent).toBe('performance_marketing');
  });

  it('utility tools belong to orchestrator', () => {
    expect(toolMetadata.switch_agent.agent).toBe('orchestrator');
    expect(toolMetadata.tasks_completed.agent).toBe('orchestrator');
  });
});

describe('Cross-Agent Tool Access', () => {
  it('content_studio can create content that outreach agents might need', () => {
    // Content studio has email/SMS template generation for cross-functional use
    expect(agentToolMapping.content_studio).toContain('generate_email_template');
    expect(agentToolMapping.content_studio).toContain('generate_sms_template');
  });

  it('outreach does NOT have content generation tools', () => {
    expect(agentToolMapping.outreach).not.toContain('generate_image');
    expect(agentToolMapping.outreach).not.toContain('generate_social_media_post');
    expect(agentToolMapping.outreach).not.toContain('generate_email_template');
    expect(agentToolMapping.outreach).not.toContain('generate_sms_template');
  });

  it('performance_marketing does NOT have content generation media tools', () => {
    expect(agentToolMapping.performance_marketing).not.toContain('generate_image');
    expect(agentToolMapping.performance_marketing).not.toContain('generate_video');
    expect(agentToolMapping.performance_marketing).not.toContain('generate_social_media_post');
  });

  it('lead_generation does NOT have content or outreach tools', () => {
    expect(agentToolMapping.lead_generation).not.toContain('generate_image');
    expect(agentToolMapping.lead_generation).not.toContain('send_outreach_messages');
    expect(agentToolMapping.lead_generation).not.toContain('generate_ad');
  });
});
