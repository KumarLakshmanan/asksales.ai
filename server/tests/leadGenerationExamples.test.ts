import { expect, it } from '@jest/globals';
import { leadGenerationExamples } from '../services/outreach/leadGenerationExamples.js';

it('provides business context without contact details or full CRM records', () => {
  const examples = leadGenerationExamples([{
    company: 'Example Co', role: 'Operations lead', industry: 'Software',
    email: 'person@example.test', phone: '+15550001001', full_name: 'Test Person',
    address: 'Private address', raw_data: { private_note: 'Private note' },
  }]);
  expect(examples).toEqual([{ company: 'Example Co', role: 'Operations lead', industry: 'Software' }]);
  expect(JSON.stringify(examples)).not.toMatch(/person@example|15550001001|Test Person|Private/);
});
