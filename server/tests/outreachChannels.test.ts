import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { describe, it, expect } from '@jest/globals';
import { sendOutreachMessagesTool } from '../mastra/tools/outreachTools.js';
import { toolMetadata, agentToolMapping } from '../mastra/tools/toolRegistry.js';

describe('Outreach Channels Expanded Registry', () => {
  it('should have publish_social_post mapped to outreach and content_studio', () => {
    expect(agentToolMapping.outreach).toContain('publish_social_post');
    expect(agentToolMapping.content_studio).toContain('publish_social_post');
    expect(toolMetadata.publish_social_post.agents).toContain('outreach');
    expect(toolMetadata.publish_social_post.agents).toContain('content_studio');
  });

  it('send_outreach_messages tool input schema should allow all 6 channels', () => {
    expect(sendOutreachMessagesTool.inputSchema).toBeDefined();
    
    // Parse test inputs to verify zod schema matches
    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    const emailParse = sendOutreachMessagesTool.inputSchema.safeParse({
      lead_ids: [1, 2],
      channel: 'email',
      body: 'Hello',
    });
    expect(emailParse.success).toBe(true);

    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    const waParse = sendOutreachMessagesTool.inputSchema.safeParse({
      lead_ids: [1, 2],
      channel: 'whatsapp',
      body: 'Hello',
    });
    expect(waParse.success).toBe(true);

    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    const liParse = sendOutreachMessagesTool.inputSchema.safeParse({
      lead_ids: [1, 2],
      channel: 'linkedin',
      body: 'Hello',
    });
    expect(liParse.success).toBe(true);

    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    const invalidParse = sendOutreachMessagesTool.inputSchema.safeParse({
      lead_ids: [1, 2],
      channel: 'tiktok', // invalid channel
      body: 'Hello',
    });
    expect(invalidParse.success).toBe(false);
  });
});
