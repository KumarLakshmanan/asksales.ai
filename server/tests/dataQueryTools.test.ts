import { describe, it, expect } from '@jest/globals';
import { toolMetadata, agentToolMapping } from '../mastra/tools/toolRegistry.js';
import { queryLeadsTool, queryIcpProfilesTool, queryContentAssetsTool, queryOutreachCampaignsTool } from '../mastra/tools/dataQueryTools.js';

describe('Data Query Tools Registration', () => {
  it('should have new tools in toolMetadata', () => {
    expect(toolMetadata.query_leads).toBeDefined();
    expect(toolMetadata.query_icp_profiles).toBeDefined();
    expect(toolMetadata.query_content_assets).toBeDefined();
    expect(toolMetadata.query_outreach_campaigns).toBeDefined();
  });

  it('should map query_leads to lead_generation, outreach, and performance_marketing', () => {
    expect(agentToolMapping.lead_generation).toContain('query_leads');
    expect(agentToolMapping.outreach).toContain('query_leads');
    expect(agentToolMapping.performance_marketing).toContain('query_leads');
  });

  it('should map query_icp_profiles to icp_generation, lead_generation, and orchestrator', () => {
    expect(agentToolMapping.icp_generation).toContain('query_icp_profiles');
    expect(agentToolMapping.lead_generation).toContain('query_icp_profiles');
    expect(agentToolMapping.orchestrator).toContain('query_icp_profiles');
  });

  it('should map query_content_assets to content_studio and outreach', () => {
    expect(agentToolMapping.content_studio).toContain('query_content_assets');
    expect(agentToolMapping.outreach).toContain('query_content_assets');
  });

  it('should map query_outreach_campaigns to outreach and performance_marketing', () => {
    expect(agentToolMapping.outreach).toContain('query_outreach_campaigns');
    expect(agentToolMapping.performance_marketing).toContain('query_outreach_campaigns');
  });

  it('new tools should not require approval', () => {
    expect(toolMetadata.query_leads.requiresApproval).toBe(false);
    expect(toolMetadata.query_icp_profiles.requiresApproval).toBe(false);
    expect(toolMetadata.query_content_assets.requiresApproval).toBe(false);
    expect(toolMetadata.query_outreach_campaigns.requiresApproval).toBe(false);
  });
});

describe('Data Query Tools Object Definitions', () => {
  it('should have correct IDs', () => {
    expect(queryLeadsTool.id).toBe('query_leads');
    expect(queryIcpProfilesTool.id).toBe('query_icp_profiles');
    expect(queryContentAssetsTool.id).toBe('query_content_assets');
    expect(queryOutreachCampaignsTool.id).toBe('query_outreach_campaigns');
  });

  it('should have validation input schemas', () => {
    expect(queryLeadsTool.inputSchema).toBeDefined();
    expect(queryIcpProfilesTool.inputSchema).toBeDefined();
    expect(queryContentAssetsTool.inputSchema).toBeDefined();
    expect(queryOutreachCampaignsTool.inputSchema).toBeDefined();
  });
});
