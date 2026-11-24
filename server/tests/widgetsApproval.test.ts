import { describe, it, expect } from '@jest/globals';
import { toolHasWidget, getWidgetTypeForTool } from '../shared/toolWidgetMap.js';

describe('Interactive Widgets & Approvals Mapping', () => {
  it('should identify publishing and outreach action tools as widget-enabled', () => {
    expect(toolHasWidget('publish_social_post')).toBe(true);
    expect(toolHasWidget('publish_meta_ads')).toBe(true);
    expect(toolHasWidget('send_outreach_messages')).toBe(true);
  });

  it('should return the correct widget type for each mapped tool', () => {
    expect(getWidgetTypeForTool('publish_social_post')).toBe('publish_post');
    expect(getWidgetTypeForTool('publish_meta_ads')).toBe('publish_ads');
    expect(getWidgetTypeForTool('send_outreach_messages')).toBe('send_outreach');
  });

  it('should return false for tool names that are not widget-enabled', () => {
    expect(toolHasWidget('check_integration_status')).toBe(false);
    expect(toolHasWidget('some_dummy_tool')).toBe(false);
  });

  it('should return undefined widget type for unmapped tools', () => {
    expect(getWidgetTypeForTool('check_integration_status')).toBeUndefined();
    expect(getWidgetTypeForTool('some_dummy_tool')).toBeUndefined();
  });
});
