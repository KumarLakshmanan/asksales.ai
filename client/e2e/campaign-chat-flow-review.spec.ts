import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { runtime, type Fixture } from './fixtures/conversation-runtime';

// A synthetic lead -> outreach campaign conversation taken from a live-model
// run (fake leads, example.com addresses). Every mutation is blocked by the
// runtime fixture, so nothing can be searched or sent.
const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 9, minute)).toISOString();
const leadsTable = [
  '**5 leads** are saved for this campaign.',
  '',
  '| Hotel | Contact role | Email | Location |',
  '|---|---|---|---|',
  '| Aurum Stay | General Manager | lead1@example.com | Chennai, India |',
  '| Velvet Nest | Owner | lead2@example.com | Chennai, India |',
  '| Marina Bay Suites | General Manager | lead3@example.com | Chennai, India |',
  '| Banyan Court | Owner | lead4@example.com | Chennai, India |',
  '| Indigo House | General Manager | lead5@example.com | Chennai, India |',
].join('\n');
const hire = (action: string, id: string, label: string, type: string) => ({ id, label, action, type });
const linkedinStrategies = ['LinkedIn Profile Search', 'LinkedIn Company Details Enrichment', 'LinkedIn Company Employees Search',
  'LinkedIn Company Search', 'LinkedIn Company Employee Extraction', 'LinkedIn Post Search', 'LinkedIn Post Commenters by Profile',
  'LinkedIn Post Reactors by Profile', 'LinkedIn Profile Search by Name'];
const messages = [
  { id: 199, role: 'assistant', agentType: 'orchestrator', createdAt: at(0),
    content: 'ICP approved. For this ICP I recommend starting with **Marcus (Lead Generation), 92% match**, then Emily (Outreach), 85% match and Alex (Content Studio), 40% match. Choose the agent you want to work with next. Selecting an agent does not authorize searches, sending, publishing, or ad spend; those actions still require their own review.',
    metadata: { workflowStage: 'agent_selection', recommendedAgentScores: { lead_generation: 92, outreach: 85, content_studio: 40, performance_marketing: 0 }, actionButtons: [
      hire('HIRE_LEAD_GEN', 'hire_lead_gen', 'Lead Generation', 'primary'), hire('HIRE_OUTREACH', 'hire_outreach', 'Outreach', 'secondary'),
      hire('HIRE_CONTENT_STUDIO', 'hire_content_studio', 'Content Studio', 'secondary'), hire('HIRE_PERFORMANCE', 'hire_performance', 'Performance Marketing', 'secondary'),
      { id: 'choose_agent', label: 'Choose agent', action: 'OPEN_TAB', type: 'secondary', data: { tabType: 'agentchoose' } }] } },
  { id: 201, role: 'user', content: 'Which lead strategies would you recommend for finding boutique hotels in Chennai?', createdAt: at(0) },
  { id: 202, role: 'assistant', agentType: 'lead_generation', createdAt: at(1), content: [
    'Recommended strategies for this campaign:', '',
    '| Channel | Strategy | Why it fits |', '|---|---|---|',
    '| Google Maps | **Google Maps Business Search** | 92% match: finds boutique hotels in Chennai with phone, website and reviews. |',
    '| LinkedIn | **LinkedIn Profile Search** | 74% match: finds owners and general managers; titles may need checking. |',
    '', 'Select **Prepare Search Settings** and I will prepare the settings for your review, or **Show All Strategies** to compare the others. Nothing has been searched yet.'].join('\n'),
    metadata: { actionButtons: [
      { id: 'lead_proceed_strategies', label: 'Prepare Search Settings', action: 'LEAD_AGENT_START', type: 'primary', data: {} },
      { id: 'lead_show_all_strategies', label: 'Show All Strategies', action: 'LEAD_AGENT_USE_WORKFLOW', type: 'secondary', data: {} }] } },
  { id: 2021, role: 'user', content: 'Show me all the LinkedIn strategies', createdAt: at(1) },
  { id: 2022, role: 'assistant', agentType: 'lead_generation', createdAt: at(1), content: [
    `**LinkedIn** · ${linkedinStrategies.length} strategies`, '',
    ...linkedinStrategies.map(title => `- **${title}**: One short line about what ${title} finds.`), '',
    'Choose a strategy below and I will prepare its search settings for your review. Nothing has been searched yet.'].join('\n'),
    metadata: { actionButtons: linkedinStrategies.map((title, i) => ({ id: `lead_strategy_${i}`, label: title, action: 'LEAD_AGENT_USE_WORKFLOW', type: 'secondary', data: { workflowId: `linkedin_${i}`, platform: 'linkedin' } })) } },
  { id: 203, role: 'user', content: 'Go with the Google Maps business search and prepare the settings for 50 boutique hotels in Chennai. Do not run it yet.', createdAt: at(2) },
  { id: 204, role: 'assistant', agentType: 'lead_generation', createdAt: at(3),
    content: 'Prepared 1 search input for Google Maps Business Search. Review the exact saved settings in the Lead Inputs tab before approving the search. No search has been executed.',
    metadata: { actionButtons: [
      { id: 'approve-lead-input-set:5007:1', label: 'Approve & Run Search', action: 'approve_tool', type: 'primary', data: { requestId: 'lead-input-set:5007:1', toolName: 'execute_lead_workflow' } },
      { id: 'edit-lead-input-set', label: 'Edit Parameters', action: 'OPEN_LEAD_INPUTS', type: 'secondary' },
    ] } },
  { id: 205, role: 'user', content: 'Before I approve, what will this search cost and how long will it take?', createdAt: at(4) },
  { id: 206, role: 'assistant', agentType: 'lead_generation', createdAt: at(5),
    content: 'Estimated cost: about **20 credits** for 50 results, based on 4 past runs of the Google Maps scraper. A typical run takes about 3 minutes (the longest took 7). The actual charge is the real Apify usage after the run. The search has not run.' },
  { id: 207, role: 'user', content: 'Show me the leads the search found', createdAt: at(12) },
  { id: 208, role: 'assistant', agentType: 'lead_generation', createdAt: at(13), content: leadsTable },
  { id: 209, role: 'user', content: 'Prepare an email outreach campaign for these leads with a short intro about missed night-time enquiries. Do not send anything yet.', createdAt: at(14) },
  { id: 210, role: 'assistant', agentType: 'outreach', createdAt: at(15),
    content: 'Email outreach to 5 selected leads is ready for review in the card below, with the subject "Capture guest enquiries after hours". Check the recipients and message, then select **Confirm and run** to send it. Nothing has been sent yet.' },
  { id: 211, role: 'user', content: 'சென்னை ஹோட்டல்களுக்கு இப்போது மின்னஞ்சல் அனுப்ப முடியுமா?', createdAt: at(16) },
  { id: 212, role: 'assistant', agentType: 'outreach', createdAt: at(17),
    content: 'இப்போது அனுப்ப முடியாது: **மின்னஞ்சல் இணைப்பு இல்லை.** Settings → Integrations-இல் email-ஐ இணைத்த பிறகு, மதிப்பாய்வு செய்யப்பட்ட அட்டையில் **Confirm and run** தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.' },
];

for (const theme of ['light', 'dark'] as const) {
  test(`campaign chat lead -> outreach conversation reads clearly (${theme})`, async ({ page }, testInfo) => {
    const state: Fixture = { turns: [], stops: [], messages };
    await page.emulateMedia({ colorScheme: theme });
    await runtime(page, state);
    // The saved preference decides the theme, not the OS colour scheme.
    await page.route('**/api/settings/preferences', route => route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } }));
    await page.goto('/dashboard/conversations/42');
    await expect(page.getByText('Recommended strategies for this campaign:')).toBeVisible();
    await expect(page.getByText('Best match · 92%')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Choose a strategy' }).getByRole('button')).toHaveCount(9);
    await expect(page.getByRole('button', { name: 'Approve & Run Search' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const shots: Array<[string, string]> = [['agents', 'Best match · 92%'], ['strategies', 'Recommended strategies for this campaign:'], ['catalog', 'Prepare search settings for'], ['approval', 'Approve & Run Search'],
      ['estimate', 'Estimated cost: about'], ['leads', 'Marina Bay Suites'], ['outreach', 'Email outreach to 5 selected leads']];
    for (const [name, text] of shots) {
      await page.getByText(text).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`campaign-chat-${name}-${theme}.png`) });
    }
    await page.screenshot({ path: testInfo.outputPath(`campaign-chat-full-${theme}.png`), fullPage: true });
  });
}
