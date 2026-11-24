import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('outreach provider readiness contract', () => {
  it('gates official social outreach before campaign persistence', () => {
    // Campaign sends delegate to the same reviewed batch admission as Compose.
    const executor = readFileSync(resolve(process.cwd(), 'mastra/tools/executors/outreachExecutor.ts'), 'utf8');
    expect(executor).toContain('executeOutreachBatch(');
    const controller = readFileSync(resolve(process.cwd(), 'controllers/outreachConversationsController.ts'), 'utf8');
    const batch = controller.slice(controller.indexOf('export async function executeOutreachBatch'));
    const readinessIndex = batch.indexOf('resolveOfficialSocialProviderBinding(');
    const notReadyIndex = batch.indexOf("code: 'OUTREACH_PROVIDER_NOT_READY'", readinessIndex);
    const persistenceIndex = batch.indexOf('createOutreachConversation(');
    expect(readinessIndex).toBeGreaterThan(0);
    expect(notReadyIndex).toBeGreaterThan(readinessIndex);
    expect(persistenceIndex).toBeGreaterThan(notReadyIndex);
    expect(batch).toContain('socialProviderBinding?.providerAccountId');
  });

  it('revalidates the exact reviewed provider binding at the worker boundary', () => {
    const worker = readFileSync(resolve(process.cwd(), 'workers/index.ts'), 'utf8');
    expect(worker).toContain("job.name === 'start_outreach_campaign'");
    expect(worker).toContain('binding.providerAccountId !== providerAccountId');
  });
});
