import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('content approval retirement', () => {
  it('removes the retired approval gate from organic publishing', () => {
    const service = read('server/services/social/OrganicPublishingService.ts');

    expect(service).not.toContain('contentApprovalWorkflowsTable');
    expect(service).not.toContain('contentApprovalRequestsTable');
    expect(service).not.toContain('CONTENT_APPROVAL_REQUIRED');
    expect(service).not.toContain('assertContentApprovalGate');
  });

  it('closes pending requests and preserves an immutable retirement event', () => {
    const migration = read('server/migrations/204_retire_content_approval_workflows.js');

    expect(migration).toContain("'feature_retired'");
    expect(migration).toContain("SET status = 'cancelled'");
    expect(migration).toContain("SET is_active = FALSE");
    expect(migration).toContain("SET approval_status = 'draft'");
    expect(migration).toContain('ai_visibility_asset_approval_decisions');
    expect(migration).toContain('export const irreversible = true');
    expect(migration).toContain('is irreversible');
    expect(migration).not.toContain('DROP TABLE');
  });

  it('does not expose the retired content-approval API namespace', () => {
    const routes = read('server/routes.ts');

    expect(routes).not.toContain('/api/content-approval/');
    expect(routes).toContain('/api/approvals/:workflowId');
  });

  it('retains historical tables in schema management without runtime consumers', () => {
    const allSchemas = read('server/models/allSchemas.ts');
    const historicalSchema = read('server/models/contentApprovalWorkflows/schema.ts');

    expect(allSchemas).toContain('contentApprovalWorkflows');
    expect(allSchemas).toContain('schema tooling cannot');
    expect(historicalSchema).toContain("pgTable('content_approval_workflows'");
    expect(historicalSchema).toContain('Historical-only schema');
  });

  it('removes approval-only metadata and copy from the content calendar', () => {
    const controller = read('server/controllers/contentCalendarController.ts');
    const page = read('client/src/app/dashboard/(main)/content-calendar/page.tsx');

    expect(controller).not.toContain('approvalStatus: asset.approvalStatus');
    expect(page).not.toContain('Approval:');
    expect(page).not.toContain('submit it for approval again');
  });

  it('does not carry retired workflow approval state into cross-post copies', () => {
    const controller = read('server/controllers/contentAssetController.ts');
    const organicPublisher = read('server/services/social/OrganicPublishingService.ts');

    expect(controller).not.toContain('approvalStatus: asset.approvalStatus');
    expect(controller).not.toContain("approvalStatus: 'approved'");
    expect(organicPublisher).not.toContain("approvalStatus: 'approved'");
  });

  it('does not emit hidden AI Studio navigation from server actions', () => {
    const notifications = read('server/services/NotificationService.ts');
    const chatController = read('server/mastra/chatController.ts');

    expect(notifications).not.toMatch(/["']\/dashboard\/content["']/);
    expect(chatController).not.toMatch(/["']\/dashboard\/content["']/);
  });

  it('prevents migration tracking from claiming an irreversible rollback succeeded', () => {
    const runner = read('server/scripts/migrate.mjs');

    expect(runner).toContain('mod.irreversible === true');
    expect(runner).toContain('no migrations were rolled back');
  });
});
