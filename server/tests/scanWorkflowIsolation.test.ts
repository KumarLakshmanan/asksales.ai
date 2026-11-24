import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Request, Response } from 'express';
import { withBusinessScope } from '../tenancy/businessContext.js';

jest.unstable_mockModule('../models/workflows/queries', () => Object.fromEntries([
  'createWorkflow', 'getWorkflowById', 'getWorkflowsByUserId', 'updateWorkflow', 'deleteWorkflow',
  'createWorkflowExecution', 'getWorkflowExecutionById', 'getWorkflowExecutions', 'updateWorkflowExecution', 'getUserWorkflowExecutions',
].map(name => [name, jest.fn()])));
const execute = jest.fn();
jest.unstable_mockModule('../services/WorkflowExecutorService', () => ({ WorkflowExecutorService: { executeWorkflow: execute } }));
jest.unstable_mockModule('../services/billing/entitlements.js', () => ({ normalizeCapacityError: () => null }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const handlers = await import('../controllers/leadflowController.js');

let fixture: string;
let cwd: ReturnType<typeof jest.spyOn>;
const north = { userId: 1, actorUserId: 1, businessProfileId: 11 };
const south = { userId: 1, actorUserId: 1, businessProfileId: 22 };
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { json: ReturnType<typeof jest.fn>; status: ReturnType<typeof jest.fn> };
}
const req = (id = '') => ({ user: { id: 1 }, params: { id }, body: { name: '../../same-name', description: 'fixture', nodes: [], edges: [] } } as unknown as Request);
beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'asksales-workflow-'));
  await mkdir(path.join(fixture, 'data/workflows'), { recursive: true });
  await writeFile(path.join(fixture, 'data/workflows/platform.json'), JSON.stringify({ workflow_id: 'platform', title: 'Platform' }));
  cwd = jest.spyOn(process, 'cwd').mockReturnValue(fixture);
});
afterAll(async () => {
  cwd.mockRestore();
  // fixture is an exclusively owned mkdtemp path, never a workspace path.
  await rm(fixture, { recursive: true, force: true });
});

describe('custom workflow tenant and approval boundaries', () => {
  it('creates identical/path-like names without collisions or path traversal', async () => {
    const a = response(), b = response();
    await withBusinessScope(north, () => handlers.createWorkflowHandler(req(), a));
    await withBusinessScope(south, () => handlers.createWorkflowHandler(req(), b));
    const first = (a.json.mock.calls[0][0] as any).workflow;
    const second = (b.json.mock.calls[0][0] as any).workflow;
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^custom_[a-f0-9-]+$/);
    expect(await readdir(path.join(fixture, 'data/workflows/tenants/11'))).toEqual([`${first.id}.json`]);
    const file = path.join(fixture, 'data/workflows/tenants/11', `${first.id}.json`);
    const before = await readFile(file, 'utf8');
    for (const handler of [handlers.updateWorkflowHandler, handlers.deleteWorkflowHandler]) {
      const res = response();
      await withBusinessScope(south, () => handler(req(first.id), res));
      expect(res.status).toHaveBeenCalledWith(404);
      expect(await readFile(file, 'utf8')).toBe(before);
    }
    const own = response();
    await withBusinessScope(north, () => handlers.updateWorkflowHandler(req(first.id), own));
    expect(own.json).toHaveBeenCalled();
    const memberList = response();
    await withBusinessScope({ ...north, actorUserId: 2, role: 'member' }, () => handlers.getUserWorkflowsHandler({ user: { id: 2 } } as Request, memberList));
    expect((memberList.json.mock.calls[0][0] as any).workflows).toHaveLength(1);
  });
  it('keeps platform workflows immutable through tenant mutation handlers', async () => {
    const res = response();
    await withBusinessScope(north, () => handlers.deleteWorkflowHandler(req('platform'), res));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(JSON.parse(await readFile(path.join(fixture, 'data/workflows/platform.json'), 'utf8')).title).toBe('Platform');
  });
  it.each([handlers.executeWorkflowHandler, handlers.executeAvailableWorkflowHandler])('rejects direct provider execution', async handler => {
    const res = response();
    await handler(req('platform'), res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(execute).not.toHaveBeenCalled();
  });
});
