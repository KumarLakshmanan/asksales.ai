import fs from 'node:fs';
import path from 'node:path';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { applyExplicitEmptyRequirements, normalizeGeneratedLeadInputEntries, validateActorInputsAgainstSchema } from '../mastra/tools/executors/leadExecutor.js';

const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin.json'), 'utf8'));
const mapping = workflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;

describe('LinkedIn profile search review contract', () => {
  it('uses the profile-by-name actor enum values rather than priced display labels', () => {
    const byNameWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_profile_by_name.json'), 'utf8'));
    const byNameActorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/harvestapi-linkedin-profile-search-by-name.json'), 'utf8'));
    const actor = byNameWorkflow.nodes.find((node: { type: string }) => node.type === 'actor');

    expect(byNameActorMetadata.input.profileScraperMode.enum).toEqual(['Short', 'Full', 'Full + email search']);
    expect(actor.data.inputMapping.profileScraperMode).toBe('Short');
    expect(actor.data.finalValues.profileScraperMode).toBe('Short');
  });

  it('allows profile-by-name searches to keep optional LinkedIn filters empty', () => {
    const inputs = {
      firstName: 'Lenny',
      lastName: 'Rachitsky',
      locations: [],
      currentCompanies: [],
      currentJobTitles: [],
      schools: [],
      industryIds: [],
      maxItems: 1,
      profileScraperMode: 'Short',
      strictSearch: false,
    };

    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-profile-search-by-name', inputs, {}, []))
      .toEqual([]);
  });

  it('maps the current Short profile-by-name response without inventing a company or placeholder title', () => {
    const byNameWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_profile_by_name.json'), 'utf8'));
    const byNameMapping = byNameWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      id: 'short-profile-id',
      name: 'Lenny Rachitsky',
      location: { linkedinText: 'United States' },
      position: '--',
      linkedinUrl: 'https://www.linkedin.com/in/lenny-rachitsky-53403220',
      publicIdentifier: 'lenny-rachitsky-53403220',
    }, byNameMapping, { platform: 'linkedin_profile_by_name' });

    expect(result).toMatchObject({
      fullName: 'Lenny Rachitsky',
      name: 'Lenny Rachitsky',
      firstName: 'Lenny',
      lastName: 'Rachitsky',
      linkedinUrl: 'https://www.linkedin.com/in/lenny-rachitsky-53403220',
      publicId: 'lenny-rachitsky-53403220',
      location: { address: 'United States' },
    });
    expect(result.company).toBeNull();
    expect(result.companyName).toBeNull();
    expect(result.headline).toBeNull();
    expect(result.role).toBeNull();
    expect(result.jobTitle).toBeNull();
  });

  it('uses Full employee profiles for a public URL usable by the chained posts actor', () => {
    const chained = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/retired-workflows/linkedin_company_employees_posts.json'), 'utf8'));
    const employeeActor = chained.nodes.find((node: { id: string }) => node.id === 'linkedin_company_employees');
    expect(employeeActor.data.inputMapping.profileScraperMode).toBe('Full ($8 per 1k)');
    expect(employeeActor.data.finalValues.profileScraperMode).toBe('Full ($8 per 1k)');
  });
  it('preserves explicitly empty optional arrays and keyword strings', () => {
    const schema = { locations: { type: 'array' }, searchQuery: { type: 'string' }, jobTitles: { type: 'array' }, companies: { type: 'array', required: true } };
    const result = applyExplicitEmptyRequirements({ locations: ['Bengaluru'], searchQuery: 'Software Engineer', jobTitles: ['Software Engineer'], companies: ['example'] }, schema, 'locations [], searchQuery "", jobTitles ["Software Engineer"], companies []');
    expect(result).toEqual({ locations: [], searchQuery: '', jobTitles: ['Software Engineer'], companies: ['example'] });
    expect(applyExplicitEmptyRequirements({ searchQuery: 'Engineer' }, schema, 'The searchQuery is useful and results may be empty')).toEqual({ searchQuery: 'Engineer' });
  });
  it('allows company-only employee discovery without inventing optional filters', () => {
    const inputs = { companies: ['https://www.linkedin.com/company/example-software/'], locations: [], jobTitles: [], seniorityLevelIds: [], searchQuery: '', maxItems: 1 };
    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-company-employees', inputs, {}, [])).toEqual([]);
  });

  it('maps the Short company-employee response without dropping provider fields', () => {
    const employeeWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_company_employees.json'), 'utf8'));
    const employeeMapping = employeeWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      firstName: 'Example', lastName: 'Employee', summary: 'Public professional biography',
      currentPositions: [{ companyName: 'Example Software', title: 'Business Development Manager', current: true }],
      location: { linkedinText: 'Bengaluru, Karnataka, India' }, pictureUrl: 'https://example.com/photo.jpg',
    }, employeeMapping, { platform: 'linkedin_company_employees' });
    expect(result.companyName).toBe('Example Software');
    expect(result.role).toBe('Business Development Manager');
    expect(result.bio).toBe('Public professional biography');
    expect(result.location).toEqual({ address: 'Bengaluru, Karnataka, India' });
    expect(result.profilePicture).toBe('https://example.com/photo.jpg');
  });

  it('maps the current LinkedIn post-search author identity and approved ICP ID', () => {
    const postWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_post_search.json'), 'utf8'));
    const postMapping = postWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToPosts').data.field_mapping;
    const result = (WorkflowExecutorService as any).mapActorResultToPost({
      entityId: '7502725203412729856',
      linkedinUrl: 'https://www.linkedin.com/posts/example',
      content: 'Zoho CRM migration notes',
      author: {
        name: 'Example Author',
        universalName: null,
        publicIdentifier: 'example-author',
        linkedinUrl: 'https://www.linkedin.com/in/example-author',
      },
      postedAt: { date: '2026-09-07T13:51:22.387Z' },
      engagement: { likes: 4, comments: 0, shares: 0 },
      postImages: [],
    }, postMapping, { platform: 'linkedin_post_search', userId: 1, promptId: 147 });

    expect(result).toMatchObject({
      userId: 1,
      promptId: 147,
      platform: 'linkedin',
      postId: '7502725203412729856',
      authorUsername: 'example-author',
      authorName: 'Example Author',
      likesCount: 4,
    });
    expect(result.createdAt).toEqual(new Date('2026-09-07T13:51:22.387Z'));
    expect(result.mediaUrls).toBe('[]');
  });

  it('preserves saved lead identities when the following post-save node updates the receipt', async () => {
    const postWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_post_search.json'), 'utf8'));
    const postNode = postWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToPosts');
    const executionContext = {
      executionId: 'post-receipt-test',
      platform: 'linkedin_post_search',
      nodesExecuted: new Map<string, any>([
        ['linkedin_searched_posts', [{ entityId: '1', content: 'Example', linkedinUrl: 'https://linkedin.com/posts/1' }]],
        ['db_save_results', { saved: 1, leadsCount: 1, postsCount: 0, leadIds: [1206] }],
      ]),
      errors: [],
      logs: [],
      promptId: 147,
    };

    const executor = WorkflowExecutorService as any;
    const persistPostRecords = executor.persistPostRecords;
    executor.persistPostRecords = async () => ({ posts: [], newCount: 0, duplicateCount: 0 });
    try {
      await executor.executeNode(postNode, postWorkflow, executionContext, {});
    } finally {
      executor.persistPostRecords = persistPostRecords;
    }

    expect(executionContext.nodesExecuted.get('db_save_results')).toMatchObject({
      leadsCount: 1,
      leadIds: [1206],
    });
  });

  it('maps the current post-search author profile without dropping its public identifier or photo', () => {
    const postWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_post_search.json'), 'utf8'));
    const authorMapping = postWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      author: {
        name: 'Example Author',
        info: 'Zoho CRM consultant',
        universalName: null,
        publicIdentifier: 'example-author',
        linkedinUrl: 'https://www.linkedin.com/in/example-author',
        avatar: { url: 'https://example.com/avatar.jpg' },
      },
    }, authorMapping, { platform: 'linkedin_post_search', userId: 1, promptId: 147 });

    expect(result).toMatchObject({
      promptId: 147,
      fullName: 'Example Author',
      headline: 'Zoho CRM consultant',
      publicId: 'example-author',
      linkedinUsername: 'example-author',
      profilePicture: 'https://example.com/avatar.jpg',
    });
  });

  it('saves each searched post before its author so the lead can reference the post row', () => {
    const postWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_post_search.json'), 'utf8'));
    const order = (WorkflowExecutorService as any).getExecutionOrder(postWorkflow);
    expect(order.indexOf('linkedin_post_search')).toBeLessThan(order.indexOf('db_save_posts'));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('db_save_post_authors'));
  });

  it('saves profile posts before their commenters so commenter leads can reference the post row', () => {
    const commentersWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_posts_commenters.json'), 'utf8'));
    const order = (WorkflowExecutorService as any).getExecutionOrder(commentersWorkflow);
    expect(commentersWorkflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts', target: 'db_save_commenters',
    }));
    expect(order.indexOf('linkedin_profile_posts')).toBeLessThan(order.indexOf('db_save_posts'));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('linkedin_post_comments'));
    expect(order.indexOf('linkedin_post_comments')).toBeLessThan(order.indexOf('db_save_commenters'));
  });

  it('saves profile posts before their reactors so reactor leads can reference the post row', () => {
    const reactorsWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_posts_reactors.json'), 'utf8'));
    const order = (WorkflowExecutorService as any).getExecutionOrder(reactorsWorkflow);
    expect(reactorsWorkflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts', target: 'db_save_reactors',
    }));
    expect(order.indexOf('linkedin_profile_posts')).toBeLessThan(order.indexOf('db_save_posts'));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('linkedin_post_reactions'));
    expect(order.indexOf('linkedin_post_reactions')).toBeLessThan(order.indexOf('db_save_reactors'));
  });

  it('requires a company target even when an employee keyword is present', () => {
    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-company-employees', { companies: [], searchQuery: 'Founder' }, {}, []))
      .toContain('LinkedIn company employee search requires company URLs');
  });

  it('still rejects malformed optional employee locations', () => {
    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-company-employees', { companies: ['https://www.linkedin.com/company/example/'], locations: 'Bengaluru' }, {}, []))
      .toContain('LinkedIn filter error: "locations" must be an array');
  });
  it.each([{ searches: [] }, { searches: ['Example Software'] }])('preserves provider-owned searches data $searches', ({ searches }) => {
    const inputs = { companies: ['https://www.linkedin.com/company/example-software/'], searches };
    expect(normalizeGeneratedLeadInputEntries(inputs, { searches: { type: 'array' } }))
      .toEqual({ entries: [inputs], isMultiSearch: false });
  });

  it('supports an unambiguous company batch envelope and legacy search envelopes', () => {
    const entries = [{ companies: ['https://www.linkedin.com/company/example-software/'] }];
    expect(normalizeGeneratedLeadInputEntries({ searchInputs: entries }, { searches: {} }).entries).toEqual(entries);
    expect(normalizeGeneratedLeadInputEntries({ searches: entries }, {}).entries).toEqual(entries);
  });

  it('rejects company detail inputs with no target instead of running provider defaults', () => {
    expect(validateActorInputsAgainstSchema('harvestapi/linkedin-company', { companies: [], searches: [] }, {}, []))
      .toContain('LinkedIn company details requires company URLs or company names');
  });

  it('preserves structured company location instead of flattening it to a label', () => {
    const companyWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_company_details.json'), 'utf8'));
    const companyMapping = companyWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const location = { city: 'Bengaluru', state: 'Karnataka', country: 'India', text: 'Bengaluru, India' };
    const result = (WorkflowExecutorService as any).mapActorResultToLead({ name: 'Example Software', locations: [{ parsed: location }] }, companyMapping, { platform: 'linkedin_company_details' });
    expect(result.location).toMatchObject(location);
  });
  it.each([
    [{ start: 10001, end: null }, '10001+'],
    [{ start: 11, end: 50 }, '11-50'],
    [{ start: null, end: 50 }, 'Up to 50'],
    [{ start: null, end: null }, null],
    [{ start: 50, end: 11 }, null],
  ])('formats provider company employee range %j without invented bounds', (employeeCountRange, expected) => {
    const companyWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/linkedin_company_search.json'), 'utf8'));
    const companyMapping = companyWorkflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const result = (WorkflowExecutorService as any).mapActorResultToLead({ name: 'Example Company', employeeCountRange }, companyMapping, { platform: 'linkedin_company_search' });
    expect(result.companySize).toBe(expected);
  });
  it('keeps paid email-search mode user-configurable instead of an immutable final value', () => {
    const actor = workflow.nodes.find((node: { type: string }) => node.type === 'actor');
    expect(actor.data.inputMapping.profileScraperMode).toBe('{{profileScraperMode}}');
    expect(actor.data.finalValues).not.toHaveProperty('profileScraperMode');
  });

  it('preserves current employment and structured location when currentPosition is empty', () => {
    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      firstName: 'Example', lastName: 'Founder', currentPosition: [],
      experience: [{ companyName: 'Example Software', position: 'Co-Founder and CEO', endDate: { text: 'Present' } }],
      location: { linkedinText: 'Bengaluru, Karnataka, India', parsed: { text: 'Bengaluru, India', city: 'Bengaluru', state: 'Karnataka', country: 'India' } },
      photo: { url: null, sizes: [] },
    }, mapping, { platform: 'linkedin' });
    expect(result.companyName).toBe('Example Software');
    expect(result.location).toMatchObject({ city: 'Bengaluru', state: 'Karnataka', country: 'India' });
    expect(result.profilePicture).toBeNull();
  });

  it('does not infer current employer from an ended experience entry', () => {
    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      firstName: 'Example', lastName: 'Founder', currentPosition: [],
      experience: [{ companyName: 'Former Software', endDate: { text: 'Jan 2020', year: 2020 } }],
    }, mapping, { platform: 'linkedin' });
    expect(result.companyName ?? null).toBeNull();
  });
  it('sends LinkedIn ID filters saved as numbers as the string IDs the actor accepts', () => {
    const sanitized = (WorkflowExecutorService as any).sanitizeActorInputs('harvestapi/linkedin-profile-search', {
      searchQuery: 'Human Resources', seniorityLevelIds: [210, 220, '300'], functionIds: [12], maxItems: 50,
    });
    expect(sanitized.seniorityLevelIds).toEqual(['210', '220', '300']);
    expect(sanitized.functionIds).toEqual(['12']);
    expect(sanitized.maxItems).toBe(50);
  });
});
