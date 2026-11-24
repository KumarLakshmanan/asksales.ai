import type { AssistantCatalog } from '@/lib/outreach-assistants';

export const setupCatalog: AssistantCatalog = {
  runtimeEnabled: true,
  presets: [
    { agentType: 'hotel_sales', name: 'Hotel Sales Agent', description: 'Help with stays and booking enquiries.', instructions: 'Hotel starting instructions', tools: [], policies: {} },
    { agentType: 'technical_support', name: 'Technical Support Agent', description: 'Troubleshoot product questions.', instructions: 'Technical starting instructions', tools: [], policies: {} },
    { agentType: 'lead_qualification', name: 'Lead Qualification Agent', description: 'Understand and qualify new enquiries.', instructions: 'Qualification starting instructions', tools: [], policies: {} },
    { agentType: 'customer_success', name: 'Customer Success Agent', description: 'Support onboarding and continued use.', instructions: 'Success starting instructions', tools: [], policies: {} },
    { agentType: 'general_service', name: 'General Customer Service Agent', description: 'Handle everyday customer questions.', instructions: 'General starting instructions', tools: [], policies: {} },
  ],
  accounts: [
    { channel: 'whatsapp', surface: 'private', accountId: 'same-id', label: 'Orchid business line', connected: true },
    { channel: 'whatsapp', surface: 'private', accountId: 'second-line', label: 'Orchid reservations', connected: true },
    { channel: 'whatsapp', surface: 'private', accountId: 'disconnected', label: 'Offline line', connected: false },
    { channel: 'instagram', surface: 'private', accountId: 'same-id', label: '@orchid.stays', connected: true },
    { channel: 'instagram', surface: 'public_comment', accountId: 'same-id', label: 'Instagram comments', connected: true },
    { channel: 'email', surface: 'private', accountId: 'support@orchid.example', label: 'support@orchid.example', connected: true },
  ],
  models: [
    { provider: 'openai', model: 'fixture-gpt', label: 'GPT Luna', description: 'General customer conversations', controls: [] },
    { provider: 'openrouter', model: 'fixture/gemini', label: 'Gemini 3.5 Plus', description: 'Detailed customer assistance', controls: [] },
  ],
  knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
  permissions: { canManage: true, description: 'Business owner.' },
};
