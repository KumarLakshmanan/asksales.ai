/** Synthetic boundary probe. The original vulnerable receipt is retained in audit evidence. */
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getWorkflow } from '../controllers/workflowController.js';

if (process.env.NODE_ENV !== 'test') throw new Error('Run only with NODE_ENV=test and synthetic local fixtures');
const originalCwd = process.cwd();
const root = await mkdtemp(path.join(tmpdir(),'conversation-catalog-qa-'));
try {
  await mkdir(path.join(root,'server/data/workflows'),{recursive:true});
  await writeFile(path.join(root,'server/data/disposable-marker.json'),JSON.stringify({syntheticOutsideCatalog:true}));
  process.chdir(root);
  const app = express();
  app.get('/api/workflows/:workflowId',getWorkflow);
  const response = await request(app).get('/api/workflows/..%2Fdisposable-marker');
  const reproduced = response.status === 200 && response.body.syntheticOutsideCatalog === true;
  const blocked = [400,404].includes(response.status) && !reproduced;
  console.log(JSON.stringify({finding:'SM-005',route:'/api/workflows/..%2Fdisposable-marker',expected:'400 or 404',observedStatus:response.status,syntheticOutsideCatalog:reproduced,blocked}));
  process.exitCode = blocked ? 0 : 1;
} finally {
  process.chdir(originalCwd); await rm(root,{recursive:true,force:true});
}
