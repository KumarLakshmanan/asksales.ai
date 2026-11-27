import { jest } from '@jest/globals';

// These tests cover how strategies are presented, so every search has a key.
jest.unstable_mockModule('../services/apifyCredentialResolver.js', () => ({
  findLeadActorsWithoutKey: async () => new Set(),
  resolveApifyCredential: async () => ({ apiKey: "test", source: "admin", keyInfo: null }),
  LEAD_PROVIDER_UNAVAILABLE_MESSAGE: 'not connected',
  LeadProviderUnavailableError: class extends Error {},
}));

const { createLeadAgent, leadChannelLabel, leadStrategyChannelsChanged } = await import('../mastra/agents/leadAgent.js');
const { listWorkflowsForChannels, resolveCatalogWorkflowIds } = await import('../mastra/tools/executors/leadExecutor.js');

it('does not present executed inputs as a newly generated review', async () => {
  const agent = createLeadAgent() as any;
  const result = await agent.postProcess({ leadWorkflowExecuted: true, intentAnalysis: { leadSettingsRequested: true } }, {
    text: 'I have prepared the search settings.', toolResults: [],
  });
  expect(result.text).toContain('No new search settings or approval card were generated');
  const prompt = agent.buildSystemPrompt({ messages: [], leadInputs: [{ inputs: { maxItems: 1 } }], leadWorkflowExecuted: true });
  expect(prompt).toContain('historical inputs from an executed search');
  expect(prompt).not.toContain('These inputs are ready.');
});

describe('authoritative strategy presentation', () => {
  it('requires a fresh bound strategy choice when requested channels replace the confirmed set', () => {
    expect(leadStrategyChannelsChanged(
      ['google_maps'],
      ['linkedin_company_search', 'google_maps_b2b'],
    )).toBe(true);
    expect(leadStrategyChannelsChanged(
      ['google_maps'],
      ['google_maps_b2b'],
    )).toBe(false);
  });
  it('does not expose settings generation until an exact strategy selection is saved', async () => {
    const agent = createLeadAgent() as any;
    await agent.preProcess({ messages: [], selectedWorkflows: [] });
    expect(agent.getTools({ userId: 1, threadId: 2 })).not.toHaveProperty('generate_lead_inputs');
    expect(agent.buildSystemPrompt({ messages: [] })).toContain('generate_lead_inputs is intentionally unavailable in this turn');
    expect(agent.buildSystemPrompt({ messages: [] })).toContain('Call list_available_workflows at most once, then stop');

    await agent.preProcess({ messages: [], selectedWorkflows: ['linkedin_post_search'] });
    expect(agent.getTools({ userId: 1, threadId: 2 })).toHaveProperty('generate_lead_inputs');
    expect(agent.buildSystemPrompt({ messages: [] })).not.toContain('CURRENT STRATEGY GATE');
  });

  it('does not trust stale thread strategy state for a new durable campaign run', async () => {
    const agent = createLeadAgent() as any;
    await agent.preProcess({
      userId: 1,
      threadId: 2,
      messages: [],
      selectedWorkflows: ['linkedin_post_search'],
      runContext: { userId: 1, threadId: 2, runId: 'new-run-without-confirmation' },
    });
    expect(agent.getTools({ userId: 1, threadId: 2 })).not.toHaveProperty('generate_lead_inputs');
  });

  it('renders only actual recommendations and never claims an input review was generated', async () => {
    const agent = createLeadAgent() as any;
    const tools = [{ toolName: 'list_available_workflows', success: true, result: { output: {
      recommendations: { linkedin: { id: 'linkedin_company_search', title: 'LinkedIn Company Search', description: 'Find companies.' } },
    } } }];
    const result = await agent.postProcess({}, { text: 'LinkedIn Company Employee Posts is available. These settings are now prepared.', toolResults: tools });
    expect(result.text).toContain('LinkedIn Company Search');
    expect(result.text).not.toContain('Company Employee Posts');
    expect(result.text).not.toContain('These settings are now prepared');
    expect(result.text).toContain('Nothing has been searched yet');
    expect(result.text).toContain('| LinkedIn | **LinkedIn Company Search** |');
    expect(result.text).not.toContain('Find companies.');
    expect(agent.buildActionButtons({}, tools)[0].data.selectedWorkflows).toEqual(['linkedin_company_search']);
  });

  it('does not offer preparation when no actual strategy was recommended', async () => {
    const agent = createLeadAgent() as any;
    const tools = [{ toolName: 'list_available_workflows', success: true, result: { output: { recommendations: { linkedin: null } } } }];
    const result = await agent.postProcess({}, { text: 'Ready to prepare.', toolResults: tools });
    expect(result.text).toContain('No available strategy was recommended');
    expect(agent.buildActionButtons({}, tools).map((button: any) => button.label)).toEqual(['Show All Strategies']);
  });

  it('offers a review-only catalog action when fresh preparation produces no tool result', () => {
    const buttons = (createLeadAgent() as any).buildActionButtons({
      leadWorkflowExecuted: true, intentAnalysis: { leadSettingsRequested: true }, selectedLeadIds: [1],
    }, []);
    expect(buttons).toEqual([expect.objectContaining({
      label: 'Choose strategy for fresh review', action: 'LEAD_AGENT_USE_WORKFLOW',
      data: { message: 'Show me all available strategies for each channel' },
    })]);
    expect(buttons.some((button: { action: string }) => button.action === 'approve_tool')).toBe(false);
  });
  it('does not attach historical lead approval to a no-tool strategy discussion', () => {
    const buttons = (createLeadAgent() as any).buildActionButtons({
      leadWorkflowExecuted: true, selectedLeadIds: [1], intentAnalysis: { action: 'question' },
    }, []);
    expect(buttons).toEqual([]);
  });
  it('clears prior execution and outreach-review state when fresh inputs are generated', () => {
    const agent = createLeadAgent() as any;
    agent._workflowAlreadyExecuted = true;
    agent._leadReviewApproved = true;
    agent._reviewedLeadIds = [1];
    const state = { leadWorkflowExecuted: true, leadReviewApproved: true, selectedLeadIds: [1], tasksCompleted: true };
    agent._handleToolResult('generate_lead_inputs', { success: true, output: {
      schemas: [{ platform: 'linkedin_company_employees', inputs: { maxItems: 1 } }],
      workflowIds: ['linkedin_company_employees'],
    } }, state, {});
    const next = agent.buildReturnState(state, {});
    expect(next).toMatchObject({ leadWorkflowExecuted: false, leadReviewApproved: false, selectedLeadIds: [], requiresApproval: true });
    expect(state.tasksCompleted).toBe(false);
    expect(agent.buildSystemPrompt({ ...state, ...next, messages: [] })).toContain('These inputs are ready.');
  });
  it('binds a failed settings retry to the selected strategy and preserves the request', () => {
    const buttons = (createLeadAgent() as any).buildActionButtons({
      selectedWorkflows: ['linkedin_company_details'], leadWorkflowExecuted: true, selectedLeadIds: [1],
      messages: [{ role: 'user', content: 'Use this company URL only, global cap 1.' }],
    }, [{ toolName: 'generate_lead_inputs', success: false }]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ action: 'LEAD_AGENT_USE_WORKFLOW', data: {
      workflowId: 'linkedin_company_details', platform: 'linkedin',
    } });
    expect(buttons[0].data.message).toContain('Use this company URL only, global cap 1.');
    expect(buttons[0].label).not.toContain('Approve');
  });
  it('preserves the substantive request behind an app-authored strategy choice when retrying settings', () => {
    const buttons = (createLeadAgent() as any).buildActionButtons({
      selectedWorkflows: ['linkedin_posts_commenters'],
      messages: [
        { role: 'user', content: 'Use Satya Nadella, locations [], maxItems 1, and global cap 1.' },
        { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
      ],
    }, [{ toolName: 'generate_lead_inputs', success: false }]);
    expect(buttons[0].data.message).toContain('Use Satya Nadella, locations [], maxItems 1, and global cap 1.');
    expect(buttons[0].data.message).not.toContain('Preserve these requested inputs: Prepare search settings');
  });
  it('labels the recommendation action as settings preparation, not ambiguous approval', () => {
    const buttons = (createLeadAgent() as any).buildActionButtons({}, [{
      toolName: 'list_available_workflows', success: true,
      result: { output: { recommendations: { linkedin: { id: 'linkedin', title: 'LinkedIn Profile Search' } } } },
    }]);
    expect(buttons[0]).toMatchObject({ label: 'Prepare Search Settings', action: 'LEAD_AGENT_START', data: {
      selectedWorkflows: ['linkedin'], message: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.',
      platforms: ['linkedin'],
    } });
  });
  it('exposes every LinkedIn workflow as an exact selectable review-only action', async () => {
    const catalog = await listWorkflowsForChannels(['linkedin']);
    const entries = catalog.workflows.linkedin;
    expect(entries).toHaveLength(9);
    const buttons = (createLeadAgent() as any).buildActionButtons({}, [{
      toolName: 'list_available_workflows', success: true, result: { output: { allStrategies: catalog.workflows } },
    }]);
    expect(buttons).toHaveLength(entries.length);
    for (const entry of entries) {
      expect(buttons).toContainEqual(expect.objectContaining({ label: entry.title, action: 'LEAD_AGENT_USE_WORKFLOW', data: expect.objectContaining({ workflowId: entry.id, platform: 'linkedin', message: `Use ${entry.title} and prepare the search settings for my review.` }) }));
      expect(await resolveCatalogWorkflowIds([entry.title], new Set(entries.map(item => item.id)))).toEqual([entry.id]);
    }
  });
  it('resolves an exact display name but never guesses an invented strategy', async () => {
    const valid = new Set(['instagram', 'instagram_post_authors', 'instagram_competitor_profiles']);
    expect(await resolveCatalogWorkflowIds(['Instagram Post Author Profiles', 'instagram_competitor_profiles'], valid))
      .toEqual(['instagram_post_authors', 'instagram_competitor_profiles']);
    const invalid = await resolveCatalogWorkflowIds(['ig_business_scrape', 'Instagram Business Directory Scraping'], valid);
    expect(invalid.every(id => !valid.has(id))).toBe(true);
  });
  it('reads the catalog directly for a natural request even after an incorrect assistant answer', async () => {
    const pendingApproval = { toolName: 'execute_lead_workflow', args: {}, executionId: 'pending-review' };
    const response = await (createLeadAgent() as any).preProcess({
      messages: [
        { role: 'assistant', content: 'Try ig_business_scrape.' },
        { role: 'user', content: 'Could you show me all the available Instagram options again?' },
      ], intentAnalysis: { leadCatalogRequested: true, leadCatalogShowAll: true, leadChannels: ['instagram'] }, requiresApproval: true, pendingApproval,
    });
    expect(response.earlyResponse).toContain('Instagram Post Author Profiles');
    expect(response.earlyResponse).not.toContain('Instagram Complete Lead Discovery');
    expect(response.earlyResponse).not.toContain('ig_business_scrape');
    expect(response.earlyActionButtons.length).toBeGreaterThan(3);
    expect(response.earlyState).toEqual({ requiresApproval: true, pendingApproval });
  });

  it('shows every real Instagram strategy, not invented alternatives or fit scores', async () => {
    const catalog = await listWorkflowsForChannels(['instagram']);
    const result = await (createLeadAgent() as any).postProcess({}, {
      text: 'Instagram Business Directory Scraping: 88% match',
      toolResults: [{ toolName: 'list_available_workflows', success: true, result: { output: { allStrategies: catalog.workflows } } }],
    });
    expect(catalog.workflows.instagram.length).toBeGreaterThan(3);
    for (const strategy of catalog.workflows.instagram) expect(result.text).toContain(strategy.title);
    expect(result.text).not.toContain('Business Directory Scraping');
    expect(result.text).not.toContain('88%');
  });

  it('lists the catalog compactly under the channel name, one short line per strategy', async () => {
    const result = await (createLeadAgent() as any).postProcess({}, { text: '', toolResults: [{ toolName: 'list_available_workflows', success: true,
      result: { output: { allStrategies: { linkedin: [
        { id: 'linkedin', title: 'LinkedIn Profile Search', description: 'Search LinkedIn profiles by keywords or title. The foundational LinkedIn strategy, best for B2B prospecting.' },
        { id: 'linkedin_post_search', title: 'LinkedIn Post Search', description: 'Search posts by keyword.' },
      ] } } } }] });
    expect(result.text).toContain('**LinkedIn** · 2 strategies');
    expect(result.text).toContain('- **LinkedIn Profile Search**: Search LinkedIn profiles by keywords or title.');
    expect(result.text).not.toContain('The foundational LinkedIn strategy');
    expect(result.text).not.toContain('| Strategy | Description |');
    expect(result.text).not.toMatch(/^### linkedin/m);
  });

  it('names channels the way customers read them', () => {
    expect(leadChannelLabel('linkedin')).toBe('LinkedIn');
    expect(leadChannelLabel('google_maps')).toBe('Google Maps');
    expect(leadChannelLabel('new_channel')).toBe('New Channel');
  });

  it('does not replace a subsequent input-generation response with an older catalog', async () => {
    const input = { text: 'Review your new search settings.', toolResults: [
      { toolName: 'list_available_workflows', success: true, result: { output: { allStrategies: { instagram: [] } } } },
      { toolName: 'generate_lead_inputs', success: true, result: { output: {} } },
    ] };
    expect(await (createLeadAgent() as any).postProcess({}, input)).toBe(input);
  });

  it('does not offer an unbound proceed action after listing the complete catalog', () => {
    expect((createLeadAgent() as any).buildActionButtons({}, [
      { toolName: 'list_available_workflows', success: true, result: { output: { allStrategies: { instagram: [] } } } },
    ])).toEqual([]);
  });

  it('binds a plain-language strategy choice to the real catalog ID', () => {
    expect((createLeadAgent() as any).buildActionButtons({}, [
      { toolName: 'list_available_workflows', success: true, result: { output: { allStrategies: { instagram: [
        { id: 'instagram_post_authors', title: 'Instagram Post Author Profiles', description: 'Discover authors.' },
      ] } } } },
    ])).toEqual([expect.objectContaining({
      label: 'Instagram Post Author Profiles', action: 'LEAD_AGENT_USE_WORKFLOW',
      data: expect.objectContaining({ workflowId: 'instagram_post_authors', platform: 'instagram' }),
    })]);
  });
});
