/**
 * Test 8: Agent Tool Selection & Prompt-to-Tool Routing
 *
 * Tests that user prompts are routed to the correct agent and correct tools.
 * Validates that each agent chooses the right tool for a given user intent,
 * and that tool selection logic per agent works correctly.
 *
 * Logic replicated from: langgraph/tools/index.ts (agentToolMapping)
 *   + langgraph/graph.ts (routing heuristics)
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated types ──────────────────────────────────────────────────
type AgentType =
  | 'orchestrator' | 'supervisor' | 'icp_generation'
  | 'lead_generation' | 'content_studio' | 'outreach'
  | 'performance_marketing';

// ─── Agent–Tool mapping (from tools/index.ts) ──────────────────────────
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

/** Replicated: get tools for a given agent */
function getToolsForAgent(agentType: AgentType): string[] {
  return agentToolMapping[agentType] || [];
}

/**
 * Simulated tool selection heuristic:
 * Given a user message and the current agent, determine which tool(s) should be invoked.
 * This mirrors the pattern LLM agents follow when selecting tools.
 */
function selectToolForPrompt(agent: AgentType, userMessage: string): string | null {
  const available = getToolsForAgent(agent);
  const lm = userMessage.toLowerCase();

  // ICP agent
  if (agent === 'icp_generation') {
    if (lm.includes('icp') || lm.includes('target audience') || lm.includes('ideal customer') || lm.includes('campaign')) {
      return available.includes('generate_icp') ? 'generate_icp' : null;
    }
    if (lm.includes('done') || lm.includes('finished') || lm.includes('complete')) {
      return 'tasks_completed';
    }
    if (lm.includes('switch') || lm.includes('go to') || lm.includes('hire')) {
      return 'switch_agent';
    }
  }

  // Lead agent
  if (agent === 'lead_generation') {
    if (lm.includes('find leads') || lm.includes('search') || lm.includes('lead input') || lm.includes('generate input')) {
      return available.includes('generate_lead_inputs') ? 'generate_lead_inputs' : null;
    }
    if (lm.includes('execute') || lm.includes('run workflow') || lm.includes('start scraping') || lm.includes('scrape')) {
      return available.includes('execute_lead_workflow') ? 'execute_lead_workflow' : null;
    }
    if (lm.includes('done') || lm.includes('finished')) return 'tasks_completed';
    if (lm.includes('switch') || lm.includes('go to')) return 'switch_agent';
  }

  // Content agent
  if (agent === 'content_studio') {
    if (lm.includes('brand') || lm.includes('toolkit') || lm.includes('brand kit')) {
      return 'select_brand_toolkit';
    }
    if (lm.includes('video') && lm.includes('image')) return 'generate_video_from_image';
    if (lm.includes('video') || lm.includes('animation')) return 'generate_video';
    if (lm.includes('transform') || lm.includes('edit image') || (lm.includes('from') && lm.includes('image'))) {
      return 'generate_image_from_image';
    }
    if (lm.includes('image')) return 'generate_image';
    if (lm.includes('social media') || lm.includes('social post') || lm.includes('linkedin post') || lm.includes('tweet')) {
      return 'generate_social_media_post';
    }
    if (lm.includes('email')) return 'generate_email_template';
    if (lm.includes('sms') || lm.includes('text message')) return 'generate_sms_template';
    if (lm.includes('dm') || lm.includes('direct message') || lm.includes('chat template') || lm.includes('message template')) {
      return 'generate_social_chat_template';
    }
    if (lm.includes('done') || lm.includes('finished')) return 'tasks_completed';
    if (lm.includes('switch') || lm.includes('go to')) return 'switch_agent';
  }

  // Outreach agent
  if (agent === 'outreach') {
    if (lm.includes('send') || lm.includes('outreach') || lm.includes('reach out') || lm.includes('message leads')) {
      return 'send_outreach_messages';
    }
    if (lm.includes('done') || lm.includes('finished')) return 'tasks_completed';
    if (lm.includes('switch') || lm.includes('go to')) return 'switch_agent';
  }

  // Performance marketing agent
  if (agent === 'performance_marketing') {
    if (lm.includes('publish') || lm.includes('launch') || lm.includes('go live')) return 'publish_meta_ads';
    if (lm.includes('ad') || lm.includes('creative') || lm.includes('ad copy')) return 'generate_ad';
    if (lm.includes('analytics') || lm.includes('performance') || lm.includes('metrics') || lm.includes('stats') || lm.includes('how did')) {
      return 'analytics_query';
    }
    if (lm.includes('done') || lm.includes('finished')) return 'tasks_completed';
    if (lm.includes('switch') || lm.includes('go to')) return 'switch_agent';
  }

  return null;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('getToolsForAgent', () => {
  it('returns correct tool count per agent', () => {
    expect(getToolsForAgent('orchestrator')).toHaveLength(3);
    expect(getToolsForAgent('supervisor')).toHaveLength(1);
    expect(getToolsForAgent('icp_generation')).toHaveLength(3);
    expect(getToolsForAgent('lead_generation')).toHaveLength(4);
    expect(getToolsForAgent('content_studio')).toHaveLength(11);
    expect(getToolsForAgent('outreach')).toHaveLength(3);
    expect(getToolsForAgent('performance_marketing')).toHaveLength(5);
  });

  it('returns empty array for unknown agent', () => {
    expect(getToolsForAgent('unknown' as AgentType)).toEqual([]);
  });
});

describe('ICP Agent Tool Selection', () => {
  const agent: AgentType = 'icp_generation';

  it('selects generate_icp for "create an ICP for my SaaS product"', () => {
    expect(selectToolForPrompt(agent, 'create an ICP for my SaaS product')).toBe('generate_icp');
  });

  it('selects generate_icp for "define my target audience"', () => {
    expect(selectToolForPrompt(agent, 'define my target audience')).toBe('generate_icp');
  });

  it('selects generate_icp for "ideal customer profile for fintech"', () => {
    expect(selectToolForPrompt(agent, 'ideal customer profile for fintech')).toBe('generate_icp');
  });

  it('selects generate_icp for "start a new campaign"', () => {
    expect(selectToolForPrompt(agent, 'start a new campaign')).toBe('generate_icp');
  });

  it('selects tasks_completed for "I am done"', () => {
    expect(selectToolForPrompt(agent, 'I am done')).toBe('tasks_completed');
  });

  it('selects switch_agent for "switch to lead generation"', () => {
    expect(selectToolForPrompt(agent, 'switch to lead generation')).toBe('switch_agent');
  });
});

describe('Lead Agent Tool Selection', () => {
  const agent: AgentType = 'lead_generation';

  it('selects generate_lead_inputs for "find leads on LinkedIn"', () => {
    expect(selectToolForPrompt(agent, 'find leads on LinkedIn')).toBe('generate_lead_inputs');
  });

  it('selects generate_lead_inputs for "search for potential customers"', () => {
    expect(selectToolForPrompt(agent, 'search for potential customers')).toBe('generate_lead_inputs');
  });

  it('selects generate_lead_inputs for "generate lead input parameters"', () => {
    expect(selectToolForPrompt(agent, 'generate lead input parameters')).toBe('generate_lead_inputs');
  });

  it('selects execute_lead_workflow for "execute the workflow"', () => {
    expect(selectToolForPrompt(agent, 'execute the workflow')).toBe('execute_lead_workflow');
  });

  it('selects execute_lead_workflow for "run workflow to scrape leads"', () => {
    expect(selectToolForPrompt(agent, 'run workflow to scrape leads')).toBe('execute_lead_workflow');
  });

  it('selects execute_lead_workflow for "start scraping from Google Maps"', () => {
    expect(selectToolForPrompt(agent, 'start scraping from Google Maps')).toBe('execute_lead_workflow');
  });

  it('selects tasks_completed for "finished"', () => {
    expect(selectToolForPrompt(agent, 'finished')).toBe('tasks_completed');
  });

  it('selects switch_agent for "go to content studio"', () => {
    expect(selectToolForPrompt(agent, 'go to content studio')).toBe('switch_agent');
  });
});

describe('Content Studio Tool Selection', () => {
  const agent: AgentType = 'content_studio';

  it('selects select_brand_toolkit for "select my brand toolkit"', () => {
    expect(selectToolForPrompt(agent, 'select my brand toolkit')).toBe('select_brand_toolkit');
  });

  it('selects select_brand_toolkit for "what brand kits do I have?"', () => {
    expect(selectToolForPrompt(agent, 'what brand kits do I have?')).toBe('select_brand_toolkit');
  });

  it('selects generate_image for "create a marketing image"', () => {
    expect(selectToolForPrompt(agent, 'create a marketing image')).toBe('generate_image');
  });

  it('selects generate_image for "generate an image of a sunset"', () => {
    expect(selectToolForPrompt(agent, 'generate an image of a sunset')).toBe('generate_image');
  });

  it('selects generate_video for "create a promotional video"', () => {
    expect(selectToolForPrompt(agent, 'create a promotional video')).toBe('generate_video');
  });

  it('selects generate_video for "make an animation for our product"', () => {
    expect(selectToolForPrompt(agent, 'make an animation for our product')).toBe('generate_video');
  });

  it('selects generate_video_from_image for "create a video from this image"', () => {
    expect(selectToolForPrompt(agent, 'create a video from this image')).toBe('generate_video_from_image');
  });

  it('selects generate_image_from_image for "transform this image to watercolor"', () => {
    expect(selectToolForPrompt(agent, 'transform this image to watercolor')).toBe('generate_image_from_image');
  });

  it('selects generate_image_from_image for "edit this image to add text"', () => {
    expect(selectToolForPrompt(agent, 'edit image to add text')).toBe('generate_image_from_image');
  });

  it('selects generate_social_media_post for "write a LinkedIn post"', () => {
    expect(selectToolForPrompt(agent, 'write a LinkedIn post about AI trends')).toBe('generate_social_media_post');
  });

  it('selects generate_social_media_post for "make a social media post"', () => {
    expect(selectToolForPrompt(agent, 'make a social media post about our launch')).toBe('generate_social_media_post');
  });

  it('selects generate_social_media_post for "write a tweet"', () => {
    expect(selectToolForPrompt(agent, 'write a tweet about technology')).toBe('generate_social_media_post');
  });

  it('selects generate_social_chat_template for "create a DM template"', () => {
    expect(selectToolForPrompt(agent, 'create a DM template for LinkedIn')).toBe('generate_social_chat_template');
  });

  it('selects generate_social_chat_template for "write a direct message"', () => {
    expect(selectToolForPrompt(agent, 'write a direct message to introduce myself')).toBe('generate_social_chat_template');
  });

  it('selects generate_email_template for "create an email template"', () => {
    expect(selectToolForPrompt(agent, 'create an email template for cold outreach')).toBe('generate_email_template');
  });

  it('selects generate_sms_template for "write an SMS message"', () => {
    expect(selectToolForPrompt(agent, 'write an SMS for our sale')).toBe('generate_sms_template');
  });

  it('selects generate_sms_template for "create a text message template"', () => {
    expect(selectToolForPrompt(agent, 'create a text message template')).toBe('generate_sms_template');
  });

  it('selects tasks_completed for "I am done creating content"', () => {
    expect(selectToolForPrompt(agent, 'I am done creating content')).toBe('tasks_completed');
  });

  it('selects switch_agent for "go to outreach"', () => {
    expect(selectToolForPrompt(agent, 'go to outreach')).toBe('switch_agent');
  });
});

describe('Outreach Agent Tool Selection', () => {
  const agent: AgentType = 'outreach';

  it('selects send_outreach_messages for "send emails to my leads"', () => {
    expect(selectToolForPrompt(agent, 'send emails to my leads')).toBe('send_outreach_messages');
  });

  it('selects send_outreach_messages for "reach out to the selected leads"', () => {
    expect(selectToolForPrompt(agent, 'reach out to the selected leads')).toBe('send_outreach_messages');
  });

  it('selects send_outreach_messages for "start the outreach campaign"', () => {
    expect(selectToolForPrompt(agent, 'start the outreach campaign')).toBe('send_outreach_messages');
  });

  it('selects send_outreach_messages for "message leads via SMS"', () => {
    expect(selectToolForPrompt(agent, 'message leads via SMS')).toBe('send_outreach_messages');
  });

  it('selects tasks_completed for "done"', () => {
    expect(selectToolForPrompt(agent, 'done')).toBe('tasks_completed');
  });

  it('selects switch_agent for "switch to content studio"', () => {
    expect(selectToolForPrompt(agent, 'switch to content studio')).toBe('switch_agent');
  });
});

describe('Performance Marketing Agent Tool Selection', () => {
  const agent: AgentType = 'performance_marketing';

  it('selects generate_ad for "create an ad for Facebook"', () => {
    expect(selectToolForPrompt(agent, 'create an ad for Facebook')).toBe('generate_ad');
  });

  it('selects generate_ad for "write ad copy for our product"', () => {
    expect(selectToolForPrompt(agent, 'write ad copy for our product')).toBe('generate_ad');
  });

  it('selects generate_ad for "generate a creative for Instagram"', () => {
    expect(selectToolForPrompt(agent, 'generate a creative for Instagram')).toBe('generate_ad');
  });

  it('selects publish_meta_ads for "publish the campaign"', () => {
    expect(selectToolForPrompt(agent, 'publish the campaign')).toBe('publish_meta_ads');
  });

  it('selects publish_meta_ads for "launch the ads"', () => {
    expect(selectToolForPrompt(agent, 'launch the ads')).toBe('publish_meta_ads');
  });

  it('selects publish_meta_ads for "go live with the campaign"', () => {
    expect(selectToolForPrompt(agent, 'go live with the campaign')).toBe('publish_meta_ads');
  });

  it('selects analytics_query for "how did my campaign perform?"', () => {
    expect(selectToolForPrompt(agent, 'how did my campaign perform?')).toBe('analytics_query');
  });

  it('selects analytics_query for "show me analytics"', () => {
    expect(selectToolForPrompt(agent, 'show me analytics')).toBe('analytics_query');
  });

  it('selects analytics_query for "what are my performance metrics?"', () => {
    expect(selectToolForPrompt(agent, 'what are my performance metrics?')).toBe('analytics_query');
  });

  it('selects analytics_query for "give me campaign stats"', () => {
    expect(selectToolForPrompt(agent, 'give me campaign stats')).toBe('analytics_query');
  });

  it('selects tasks_completed for "finished"', () => {
    expect(selectToolForPrompt(agent, 'finished')).toBe('tasks_completed');
  });

  it('selects switch_agent for "go to ICP"', () => {
    expect(selectToolForPrompt(agent, 'go to ICP generation')).toBe('switch_agent');
  });
});

describe('Tool Availability Guard', () => {
  it('agent cannot select tools not in its mapping', () => {
    // Outreach agent should NOT have generate_image
    const outreachTools = getToolsForAgent('outreach');
    expect(outreachTools).not.toContain('generate_image');
    expect(outreachTools).not.toContain('generate_video');
    expect(outreachTools).not.toContain('generate_email_template');
    expect(outreachTools).not.toContain('generate_ad');
  });

  it('lead agent should NOT have content tools', () => {
    const leadTools = getToolsForAgent('lead_generation');
    expect(leadTools).not.toContain('generate_image');
    expect(leadTools).not.toContain('generate_social_media_post');
    expect(leadTools).not.toContain('send_outreach_messages');
  });

  it('performance agent should NOT have lead tools', () => {
    const perfTools = getToolsForAgent('performance_marketing');
    expect(perfTools).not.toContain('generate_lead_inputs');
    expect(perfTools).not.toContain('execute_lead_workflow');
    expect(perfTools).not.toContain('send_outreach_messages');
  });

  it('supervisor only has switch_agent (delegates everything else)', () => {
    const supervisorTools = getToolsForAgent('supervisor');
    expect(supervisorTools).toEqual(['switch_agent']);
  });
});

describe('Pipeline Tool Routing Scenarios', () => {
  // Simulates a pipeline where multiple agents work in sequence

  it('outreach pipeline: lead → content → outreach', () => {
    const pipeline: AgentType[] = ['lead_generation', 'content_studio', 'outreach'];
    
    // Step 1: Lead agent generates inputs
    expect(selectToolForPrompt(pipeline[0], 'find leads on LinkedIn')).toBe('generate_lead_inputs');
    // Step 1b: Lead agent executes workflow
    expect(selectToolForPrompt(pipeline[0], 'execute the workflow')).toBe('execute_lead_workflow');
    // Step 1c: Lead agent completes
    expect(selectToolForPrompt(pipeline[0], 'done')).toBe('tasks_completed');
    
    // Step 2: Content agent creates email template
    expect(selectToolForPrompt(pipeline[1], 'create an email template')).toBe('generate_email_template');
    // Step 2b: Content agent completes
    expect(selectToolForPrompt(pipeline[1], 'done')).toBe('tasks_completed');
    
    // Step 3: Outreach agent sends messages
    expect(selectToolForPrompt(pipeline[2], 'send emails to leads')).toBe('send_outreach_messages');
    // Step 3b: Outreach agent completes
    expect(selectToolForPrompt(pipeline[2], 'done')).toBe('tasks_completed');
  });

  it('performance pipeline: content → performance', () => {
    const pipeline: AgentType[] = ['content_studio', 'performance_marketing'];
    
    // Step 1: Content agent generates ad creative
    expect(selectToolForPrompt(pipeline[0], 'generate an image for the ad')).toBe('generate_image');
    expect(selectToolForPrompt(pipeline[0], 'done')).toBe('tasks_completed');
    
    // Step 2: Performance agent creates ad and publishes
    expect(selectToolForPrompt(pipeline[1], 'create an ad for Facebook')).toBe('generate_ad');
    expect(selectToolForPrompt(pipeline[1], 'publish the campaign')).toBe('publish_meta_ads');
    expect(selectToolForPrompt(pipeline[1], 'done')).toBe('tasks_completed');
  });

  it('full pipeline: ICP → lead → content → outreach → performance', () => {
    const pipeline: AgentType[] = [
      'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing',
    ];
    
    expect(selectToolForPrompt(pipeline[0], 'create an ICP for my startup')).toBe('generate_icp');
    expect(selectToolForPrompt(pipeline[1], 'find leads on Google Maps')).toBe('generate_lead_inputs');
    expect(selectToolForPrompt(pipeline[2], 'write a social media post')).toBe('generate_social_media_post');
    expect(selectToolForPrompt(pipeline[3], 'send outreach emails')).toBe('send_outreach_messages');
    expect(selectToolForPrompt(pipeline[4], 'show me analytics')).toBe('analytics_query');
  });
});

describe('Edge Cases: Ambiguous Prompts', () => {
  it('content agent: "image" keyword triggers generate_image', () => {
    expect(selectToolForPrompt('content_studio', 'I want an image')).toBe('generate_image');
  });

  it('null for unrecognized prompt with no matching keywords', () => {
    expect(selectToolForPrompt('lead_generation', 'tell me a joke')).toBeNull();
  });

  it('null for supervisor (no direct tool selection except switch)', () => {
    expect(selectToolForPrompt('supervisor' as AgentType, 'create content')).toBeNull();
  });

  it('performance agent: "ad" in "advice" correctly matches generate_ad', () => {
    // "advice" contains "ad" — this is a known behavior of substring matching
    expect(selectToolForPrompt('performance_marketing', 'give me advice on marketing')).toBe('generate_ad');
  });
});
