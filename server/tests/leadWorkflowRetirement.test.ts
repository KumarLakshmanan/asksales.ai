import { readFileSync, readdirSync } from 'node:fs';
import { listWorkflowsForChannels } from '../mastra/tools/executors/leadExecutor.js';
import { listWorkflows, listSubWorkflows, getWorkflow } from '../controllers/workflowController.js';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { RETIRED_LEAD_WORKFLOW_IDS } from '../services/workflow/retiredLeadWorkflows.js';

const readDirectory = (dir: string) => readdirSync(new URL('../data/' + dir + '/', import.meta.url))
  .filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL('../data/' + dir + '/' + file, import.meta.url), 'utf8')));
const response = () => {
  const result: any = { body: undefined, code: 200 };
  result.json = (body: any) => { result.body = body; return result; };
  result.status = (code: number) => { result.code = code; return result; };
  return result;
};

describe('curated lead workflow catalog', () => {
  it('keeps 28 active strategies and retires 17 with no ID overlap', () => {
    const active = readDirectory('workflows');
    expect(active).toHaveLength(28);
    expect(active.some(w => w.platform === 'yelp')).toBe(false);
    expect(RETIRED_LEAD_WORKFLOW_IDS.size).toBe(17);
    expect(active.every(w => !w.retired && !RETIRED_LEAD_WORKFLOW_IDS.has(w.workflow_id))).toBe(true);
  });

  it('excludes retired choices from both public catalog endpoints', async () => {
    const flat = response();
    await listWorkflows({ query: {} } as any, flat);
    expect(flat.body).toHaveLength(28);
    expect(flat.body.some((w: any) => w.platform === 'yelp')).toBe(false);
    expect(flat.body.every((w: any) => !RETIRED_LEAD_WORKFLOW_IDS.has(w.workflow_id))).toBe(true);
    const grouped = response();
    await listSubWorkflows({} as any, grouped);
    const variants: any[] = Object.values(grouped.body).flat();
    expect(variants).toHaveLength(28);
    expect(grouped.body.yelp).toBeUndefined();
    expect(variants.every(w => !RETIRED_LEAD_WORKFLOW_IDS.has(w.id))).toBe(true);
  });

  it('keeps every channel available to the chat strategy picker', async () => {
    const result = await listWorkflowsForChannels(['facebook', 'instagram', 'twitter', 'linkedin', 'google_maps', 'justdial', 'yelp']);
    expect(JSON.stringify(result)).not.toContain('Complete Lead Discovery');
    expect(Object.values(result.workflows).flat()).toHaveLength(28);
    expect(result.workflows.yelp || []).toEqual([]);
    expect(Object.values(result.workflows).flat().every(w => !RETIRED_LEAD_WORKFLOW_IDS.has(w.id))).toBe(true);
    for (const id of ['facebook_post_authors', 'instagram_post_authors', 'twitter_post_authors', 'linkedin_company_employees']) {
      expect(JSON.stringify(result)).toContain(id);
    }
  });

  it('does not resolve retired IDs through direct catalog lookup', async () => {
    for (const id of RETIRED_LEAD_WORKFLOW_IDS) {
      const res = response();
      await getWorkflow({ params: { workflowId: id } } as any, res);
      expect(res.code).toBe(404);
    }
  });

  it('rejects every historical retired snapshot before executing providers or saving results', async () => {
    // Archived JSON files are ignored by Git. Validate the persisted ID guard
    // without depending on a developer's local archive or a retired flag.
    for (const workflow_id of RETIRED_LEAD_WORKFLOW_IDS) {
      await expect(WorkflowExecutorService.executeWorkflow({ workflow_id, nodes: [] } as any, {}, '1'))
        .rejects.toThrow('retired');
    }
  });
});
