import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let fixture: string;
let catalog: string;
jest.unstable_mockModule('../utils/dataPathResolver.js', () => ({ resolveWorkflowsDir: () => catalog }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
const { getWorkflow, listWorkflows, listSubWorkflows } = await import('../controllers/workflowController.js');
const app = express();
// The application route is authenticated. Replace only session establishment
// with this synthetic actor; catalog reads below use the actual controller/fs.
app.use((req,res,next) => req.get('X-Fixture-Actor') === '7' ? next() : res.status(401).json({error:'Unauthorized'}));
app.get('/api/workflows',listWorkflows);
app.get('/api/workflows/sub-workflows',listSubWorkflows);
app.get('/api/workflows/:workflowId',getWorkflow);
const read = (id: string) => request(app).get(`/api/workflows/${id}`).set('X-Fixture-Actor','7');

describe('workflow catalog canonical filesystem boundary with harmless real fixtures', () => {
  beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(),'workflow-boundary-qa-'));
    catalog = path.join(fixture,'server/data/workflows');
    await mkdir(catalog,{recursive:true});
    await writeFile(path.join(catalog,'direct.json'),JSON.stringify({workflow_id:'logical_alias',platform:'synthetic',title:'Trusted workflow',version:'1'}));
    await writeFile(path.join(catalog,'legacy_workflow.json'),JSON.stringify({workflow_id:'legacy_alias',platform:'synthetic',title:'Trusted legacy workflow',version:'1'}));
    await writeFile(path.join(catalog,'tenant_owned.json'),JSON.stringify({workflow_id:'tenant_owned',platform:'custom',title:'Private workflow',userId:7}));
    await writeFile(path.join(fixture,'server/data/disposable-marker.json'),JSON.stringify({workflow_id:'outside_alias',platform:'outside',title:'Outside marker',syntheticOutsideCatalog:true}));
    await symlink('../disposable-marker.json',path.join(catalog,'outside-link.json'));
    await symlink('../disposable-marker.json',path.join(catalog,'legacy-link_workflow.json'));
    await symlink('direct.json',path.join(catalog,'inside-link.json'));
    await symlink('..',path.join(catalog,'outside-directory'));
    await mkdir(path.join(catalog,'folder.json'));
    await writeFile(path.join(catalog,'broken.json'),'synthetic malformed JSON');
  });
  afterAll(async () => { if (fixture) await rm(fixture,{recursive:true,force:true}); });

  it.each(['direct','logical_alias','legacy','legacy_alias'])('serves an ordinary authenticated catalog read for %s', async id => {
    const response = await read(id).expect(200);
    expect(response.body.platform).toBe('synthetic');
    expect(response.body).not.toHaveProperty('syntheticOutsideCatalog');
  });

  it.each([
    '..%2Fdisposable-marker', '..%5Cdisposable-marker', '%252e%252e%252fdisposable-marker',
    '%2Ftmp%2Fdisposable-marker', 'C%3A%5Cdisposable-marker', '%00disposable-marker',
    'outside-directory%2Fdisposable-marker', 'a'.repeat(256),
  ])('rejects a non-catalog identifier without reading an unintended JSON file: %s', async id => {
    const response = await read(id);
    expect([400,404]).toContain(response.status);
    expect(response.body).not.toHaveProperty('syntheticOutsideCatalog');
  });

  it.each(['outside-link','legacy-link','outside_alias','inside-link','folder','broken','missing','tenant_owned'])('does not serve a linked, non-regular, malformed or tenant-owned entry: %s', async id => {
    const response = await read(id).expect(404);
    expect(response.body).toEqual({error:'Workflow not found'});
  });

  it('keeps both catalog listing surfaces inside the same trusted directory', async () => {
    const list = await request(app).get('/api/workflows').set('X-Fixture-Actor','7').expect(200);
    expect(list.body.map((value: { workflow_id: string }) => value.workflow_id).sort()).toEqual(['legacy_alias','logical_alias']);
    const sub = await request(app).get('/api/workflows/sub-workflows').set('X-Fixture-Actor','7').expect(200);
    expect(Object.values(sub.body).flat().map(value => (value as {id: string}).id).sort()).toEqual(['legacy_alias','logical_alias']);
  });

  it('retains the existing authentication boundary for catalog reads', async () => {
    await request(app).get('/api/workflows/direct').expect(401);
  });

  it('returns not found for an unknown maximum-length logical ID instead of a filesystem error', async () => {
    await read('z'.repeat(255)).expect(404);
  });

  it('rejects a regular entry replaced by a symlink between validation and open', async () => {
    const candidate = path.join(catalog,'race.json');
    await writeFile(candidate,JSON.stringify({workflow_id:'race',title:'Safe initial file'}));
    const open = fs.openSync;
    const intercept = jest.spyOn(fs,'openSync').mockImplementationOnce((file,flags,mode) => {
      expect(file).toBe(candidate);
      fs.unlinkSync(candidate); fs.symlinkSync('../disposable-marker.json',candidate);
      return open(file,flags,mode);
    });
    try { await read('race').expect(404); }
    finally { intercept.mockRestore(); }
  });
});
