import { describe, it, expect } from '@jest/globals';
import { toolMetadata, agentToolMapping } from '../mastra/tools/toolRegistry.js';
import { checkIntegrationStatusTool } from '../mastra/tools/integrationTools.js';
import { generateWhatsappTemplateTool } from '../mastra/tools/contentTools.js';

describe('Integration Status Tools Registration', () => {
  it('should have new tools in toolMetadata', () => {
    expect(toolMetadata.check_integration_status).toBeDefined();
    expect(toolMetadata.generate_whatsapp_template).toBeDefined();
  });

  it('should map check_integration_status to the orchestrator and execution agents', () => {
    expect(agentToolMapping.orchestrator).toContain('check_integration_status');
    expect(agentToolMapping.icp_generation).not.toContain('check_integration_status');
    expect(agentToolMapping.lead_generation).toContain('check_integration_status');
    expect(agentToolMapping.content_studio).toContain('check_integration_status');
    expect(agentToolMapping.outreach).toContain('check_integration_status');
    expect(agentToolMapping.performance_marketing).toContain('check_integration_status');
  });

  it('should map generate_whatsapp_template to content_studio only', () => {
    expect(agentToolMapping.content_studio).toContain('generate_whatsapp_template');
    expect(agentToolMapping.outreach).not.toContain('generate_whatsapp_template');
  });

  it('should not require approval', () => {
    expect(toolMetadata.check_integration_status.requiresApproval).toBe(false);
    expect(toolMetadata.generate_whatsapp_template.requiresApproval).toBe(false);
  });
});

describe('Integration Status Tools Object Definitions', () => {
  it('should have correct IDs', () => {
    expect(checkIntegrationStatusTool.id).toBe('check_integration_status');
    expect(generateWhatsappTemplateTool.id).toBe('generate_whatsapp_template');
  });

  it('should have validation input schemas', () => {
    expect(checkIntegrationStatusTool.inputSchema).toBeDefined();
    expect(generateWhatsappTemplateTool.inputSchema).toBeDefined();
  });
});
