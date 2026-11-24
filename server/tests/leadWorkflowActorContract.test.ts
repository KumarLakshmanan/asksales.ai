import { readFileSync } from 'node:fs';

function readJson(relativeUrl: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(relativeUrl, import.meta.url), 'utf8'));
}

describe('lead workflow actor contracts', () => {
  it('maps every required Twitter search actor field by its canonical name', () => {
    const workflow = readJson('./fixtures/retired-workflows/twitter_post_search.json');
    const actor = readJson('../data/actors/powerai-twitter-search-scraper.json');
    const actorNode = workflow.nodes.find((node: any) => node.type === 'actor');
    const mapping = actorNode?.data?.inputMapping || {};

    for (const requiredField of actor.inputSchema.required || []) {
      expect(mapping).toHaveProperty(requiredField);
    }
    expect(mapping).not.toHaveProperty('queries');
  });

  it('maps Twitter author leads from the actor user_info payload', () => {
    const workflow = readJson('./fixtures/retired-workflows/twitter_post_search.json');
    const saveNode = workflow.nodes.find((node: any) => node.type === 'saveToLeads');
    const mapping = saveNode?.data?.field_mapping || {};

    expect(mapping.fullName).toBe('user_info.name');
    expect(mapping.twitterHandle).toBe('user_info.screen_name');
    expect(mapping.twitterUrl).toContain('user_info.screen_name');
    expect(mapping.profilePicture).toBe('user_info.avatar');
  });
});
