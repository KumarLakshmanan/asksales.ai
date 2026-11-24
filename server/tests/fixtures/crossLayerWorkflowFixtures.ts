export const regressionTenants = {
  alpha: { id: 4101, name: 'Regression Alpha' },
  beta: { id: 4102, name: 'Regression Beta' },
} as const;

export const supportChannels = ['whatsapp', 'email', 'instagram', 'facebook', 'web'] as const;
export type SupportChannelFixture = (typeof supportChannels)[number];

export type LeadFixture = {
  externalId: string;
  name: string;
  email?: string;
  profileUrl?: string;
};

export type LeadProviderFixture = {
  name: string;
  outcome: 'success' | 'failure';
  leads?: LeadFixture[];
};

export const leadFixtures = {
  shared: {
    externalId: 'lead-shared',
    name: 'Shared Dental Group',
    email: 'hello@shared-dental.example',
  },
  alpha: {
    externalId: 'lead-alpha',
    name: 'Alpha Dental',
    email: 'alpha@dental.example',
  },
  beta: {
    externalId: 'lead-beta',
    name: 'Beta Dental',
    profileUrl: 'https://example.test/leads/beta',
  },
  gamma: {
    externalId: 'lead-gamma',
    name: 'Gamma Dental',
    email: 'gamma@dental.example',
  },
  delta: {
    externalId: 'lead-delta',
    name: 'Delta Dental',
    email: 'delta@dental.example',
  },
} satisfies Record<string, LeadFixture>;

export const leadProviderScenarios = {
  overReturningWithDuplicate: [
    {
      name: 'maps',
      outcome: 'success',
      leads: [leadFixtures.shared, leadFixtures.alpha, leadFixtures.beta],
    },
    {
      name: 'linkedin',
      outcome: 'success',
      leads: [leadFixtures.shared, leadFixtures.gamma, leadFixtures.delta],
    },
  ],
  partialFailure: [
    { name: 'maps', outcome: 'success', leads: [leadFixtures.alpha] },
    { name: 'linkedin', outcome: 'failure' },
  ],
  allFailure: [
    { name: 'maps', outcome: 'failure' },
    { name: 'linkedin', outcome: 'failure' },
  ],
  emptySuccess: [
    { name: 'maps', outcome: 'success', leads: [] },
  ],
} satisfies Record<string, LeadProviderFixture[]>;

export const supportRequests = {
  factual: 'What are your published support hours?',
  transactional: 'Please change the delivery address on my open order.',
} as const;

export const deliveryStates = ['sent', 'accepted', 'failed', 'uncertain'] as const;
export type DeliveryStateFixture = (typeof deliveryStates)[number];
