import { describe, expect, it } from '@jest/globals';
import { calculateProposalPricing, fillProposalFields, getProposalReadiness, materializeProposalTemplate, missingProposalTemplateFields, unresolvedProposalFields, compareProposalVersions, type ProposalDocument } from '../../shared/proposals.js';

const complete = (): ProposalDocument => ({
  title: 'Website implementation', recipientName: 'Test Customer', recipientEmail: 'customer@example.test',
  currency: 'USD', coverNote: 'Deliver the agreed five-page website.', termsAndConditions: 'Payment due 14 days after acceptance.',
  lineItems: [{ name: 'Implementation', quantity: 2, unitPrice: 125 }],
  metadata: { approvalRequired: true, approvedAt: '2026-09-12T00:00:00Z' },
});

describe('proposal document completion', () => {
  it('fills known fields without erasing unconfirmed requirements', () => {
    const text = fillProposalFields('{{Client Name}} / {{company_name}} / {{deadline}}', { client_name: 'Alex', company_name: 'Example' });
    expect(text).toBe('Alex / Example / {{deadline}}');
    expect(unresolvedProposalFields(text)).toEqual(['deadline']);
  });
  it('reports declared template fields even when they are not printed as placeholders', () => {
    const missing = missingProposalTemplateFields(
      ['client_name', 'implementation_owner'],
      { client_name: 'Alex', implementation_owner: '' },
    );
    expect(missing).toEqual(['implementation_owner']);
    expect(getProposalReadiness({
      ...complete(),
      metadata: { ...complete().metadata, missingTemplateFields: missing },
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'template_fields', field: 'templateValues' }),
    ]));
  });
  it('separates old starter prompts from the actual customer document', () => {
    const result = materializeProposalTemplate([
      { title: 'Summary', body: 'Prepare a website proposal for {{client_name}} from {{company_name}}.', kind: 'cover' },
      { title: 'Scope', body: 'We will deliver a website for {{client_name}}.', kind: 'content' },
    ], { client_name: 'Alex' });
    expect(result.sections[0].body).toBe('');
    expect(result.sections[0].instruction).toContain('Prepare a website');
    expect(result.sections[1].body).toBe('We will deliver a website for Alex.');
    const ready = getProposalReadiness({ ...complete(), metadata: { generatedSections: result.sections } });
    expect(ready.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'section_0' })]));
  });
  it('preserves reusable customer copy when authoring guidance is separately stored', () => {
    const result = materializeProposalTemplate([{ title: 'Scope', kind: 'content', body: 'Design for {{client_name}}.', instruction: 'Use the agreed scope.' }], { client_name: 'Alex' });
    expect(result.sections[0].body).toBe('Design for Alex.');
  });
});

describe('readiness is channel aware and validates every offered choice', () => {
  it('accepts a complete reviewed proposal', () => expect(getProposalReadiness(complete()).ready).toBe(true));
  it('requires an email only for email delivery', () => {
    const proposal = { ...complete(), recipientEmail: '' };
    expect(getProposalReadiness(proposal).ready).toBe(false);
    expect(getProposalReadiness(proposal, { channel: 'whatsapp' }).ready).toBe(true);
  });
  it('distinguishes an unpriced item from an intentional complimentary item', () => {
    const proposal = { ...complete(), lineItems: [{ name: 'Discovery', unitPrice: 0 }] };
    expect(getProposalReadiness(proposal).ready).toBe(false);
    expect(getProposalReadiness({ ...proposal, lineItems: [{ name: 'Discovery', unitPrice: 0, isComplimentary: true }] }).ready).toBe(true);
  });
  it('does not hide unconfirmed prices in unselected optional services', () => {
    const proposal = complete();
    proposal.lineItems!.push({ name: 'Optional training', unitPrice: 0, isOptional: true, selected: false });
    expect(getProposalReadiness(proposal).issues.some(issue => issue.code === 'item_price_1')).toBe(true);
  });
  it('blocks placeholders in terms and line descriptions', () => {
    const proposal = complete();
    proposal.termsAndConditions = 'Payment within {{payment_days}} days.';
    proposal.lineItems![0].description = '[TODO: Confirm scope]';
    expect(getProposalReadiness(proposal).issues.find(issue => issue.code === 'placeholders')?.message).toContain('payment_days');
  });
  it('allows a content review without falsely passing the send approval gate', () => {
    const proposal = { ...complete(), metadata: { approvalRequired: true } };
    expect(getProposalReadiness(proposal).ready).toBe(false);
    expect(getProposalReadiness(proposal, { includeApproval: false }).ready).toBe(true);
  });
  it('reports expired proposals with a deterministic clock', () => {
    expect(getProposalReadiness({ ...complete(), validUntil: '2026-01-01' }, { now: new Date('2026-09-12') }).issues.some(issue => issue.code === 'expired')).toBe(true);
  });
  it('requires milestone percentages to cover the full agreed amount', () => {
    const proposal = complete();
    proposal.metadata!.commercial = { milestones: [{ id: 'deposit', title: 'Deposit', percentage: 25 }] };
    expect(getProposalReadiness(proposal).issues.some(issue => issue.code === 'milestones')).toBe(true);
  });
  it('identifies missing discovery requirements as a non-blocking review warning', () => {
    const readiness = getProposalReadiness({
      ...complete(),
      metadata: { ...complete().metadata, requirements: { objectives: 'Increase qualified pipeline' } },
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_requirements',
        field: 'requirements',
        severity: 'warning',
        message: expect.stringContaining('deliverables, timeline, responsibilities, budget'),
      }),
    ]));
  });
});

describe('commercial totals and revisions', () => {
  it('uses the selected package and add-ons, without adding alternatives into the total', () => {
    const pricing = calculateProposalPricing({
      lineItems: [
        { name: 'Standard', packageId: 'standard', unitPrice: 100 },
        { name: 'Premium', packageId: 'premium', unitPrice: 300 },
        { name: 'Training', unitPrice: 50, isOptional: true, selected: false },
        { name: 'Maintenance', unitPrice: 20, billingPeriod: 'monthly' },
      ], discountType: 'percentage', discountValue: 10, taxRate: 10,
      metadata: { commercial: { selectedPackageId: 'standard', milestones: [{ id: 'deposit', title: 'Deposit', percentage: 50 }, { id: 'handover', title: 'Handover', percentage: 50 }] } },
    });
    expect(pricing).toMatchObject({ subtotal: 120, discount: 12, tax: 10.8, total: 118.8, recurring: { monthly: 20 } });
    expect(pricing.milestones.map(item => item.amount)).toEqual([59.4, 59.4]);
  });
  it('caps fixed discounts consistently with the amount due', () => {
    expect(calculateProposalPricing({ lineItems: [{ name: 'Consulting', unitPrice: 100 }], discountType: 'fixed', discountValue: 150, taxRate: 20 })).toMatchObject({ subtotal: 100, discount: 100, tax: 0, total: 0 });
  });
  it('reports both commercial and scope changes in revisions', () => {
    const before = complete(), after = complete();
    before.metadata!.generatedSections = [{ title: 'Scope', body: 'Five pages', kind: 'content' }];
    after.metadata!.generatedSections = [{ title: 'Scope', body: 'Six pages', kind: 'content' }];
    after.lineItems![0].unitPrice = 150;
    expect(compareProposalVersions(before, after).map(change => change.field)).toEqual(['Pricing and options', 'Scope']);
  });
});
