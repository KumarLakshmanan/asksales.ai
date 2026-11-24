import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aiVisibilityWorkspaceService } from '../services/aiVisibility/AiVisibilityWorkspaceService.js';

// Source contracts ignore formatter-only whitespace, quote style and trailing commas.
const compactSource = (value: string) => value.replace(/\s+/g, '').replace(/["']/g, '').replace(/,([)\]}])/g, '$1');
const projectRoot = resolve(process.cwd(), '..');
const read = (relativePath: string) => relativePath === 'client/src/components/ai-visibility/AiVisibilityWorkspace.tsx' ? readdirSync(resolve(projectRoot, 'client/src/components/ai-visibility')).filter(name => name.endsWith('.tsx')).map(name => readFileSync(resolve(projectRoot, 'client/src/components/ai-visibility', name), 'utf8')).join('\n') : readFileSync(resolve(projectRoot, relativePath), 'utf8');

describe('AI Visibility agency workspace foundation', () => {
  it('keeps reviewers read-only except for shared asset decisions', () => {
    expect(aiVisibilityWorkspaceService.hasCapability('client_reviewer', 'read')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('client_reviewer', 'review_assets')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('client_reviewer', 'edit')).toBe(false);
    expect(aiVisibilityWorkspaceService.hasCapability('client_reviewer', 'bill_wallet')).toBe(false);
    expect(aiVisibilityWorkspaceService.hasCapability('client_reviewer', 'manage_connections')).toBe(false);
  });

  it('allows editors to work without granting billing, credentials, or membership control', () => {
    expect(aiVisibilityWorkspaceService.hasCapability('editor', 'edit')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('editor', 'review_assets')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('editor', 'bill_wallet')).toBe(false);
    expect(aiVisibilityWorkspaceService.hasCapability('editor', 'manage_connections')).toBe(false);
    expect(aiVisibilityWorkspaceService.hasCapability('editor', 'manage_members')).toBe(false);
  });

  it('keeps wallet billing and external credentials owner-only', () => {
    expect(aiVisibilityWorkspaceService.hasCapability('owner', 'bill_wallet')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('owner', 'manage_connections')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('agency_admin', 'manage_members')).toBe(true);
    expect(aiVisibilityWorkspaceService.hasCapability('agency_admin', 'bill_wallet')).toBe(false);
    expect(aiVisibilityWorkspaceService.hasCapability('agency_admin', 'manage_connections')).toBe(false);
  });

  it('migrates every existing project into a private owner workspace without changing ownership', () => {
    const migration = read('server/migrations/198_add_ai_visibility_agency_workspaces.js');
    expect(compactSource(migration)).toContain(compactSource('WHERE workspace_id IS NULL'));
    expect(compactSource(migration)).toContain(compactSource("VALUES (project_row.user_id, project_row.name, 'private')"));
    expect(compactSource(migration)).toContain(compactSource("VALUES (new_workspace_id, project_row.user_id, 'owner', 'active', project_row.user_id)"));
    expect(compactSource(migration)).toContain(compactSource('ALTER COLUMN workspace_id SET NOT NULL'));
    expect(migration).not.toMatch(/UPDATE ai_visibility_projects SET user_id/i);
  });

  it('uses a routed website portfolio and labels shared client workspaces', () => {
    const workspace = read('client/src/components/ai-visibility/Portfolio.tsx');
    expect(compactSource(workspace)).toContain(compactSource('aria-labelledby="ai-visibility-title"'));
    expect(compactSource(workspace)).toContain(compactSource('function WebsitePortfolioCard'));
    expect(compactSource(workspace)).toContain(compactSource("project.workspace?.workspaceKind === 'client'"));
    expect(compactSource(workspace)).toContain(compactSource('Client workspace'));
    expect(compactSource(workspace)).toContain(compactSource('websiteWorkspacePath(project.id)'));
    expect(compactSource(workspace)).not.toContain(compactSource('id="ai-visibility-website"'));
  });

  it('records immutable exact-version approval decisions', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const routes = read('server/routes/aiVisibility.routes.ts');
    expect(compactSource(schema)).toContain(compactSource('ai_visibility_asset_approval_decisions_asset_version_uq'));
    expect(compactSource(schema)).toContain(compactSource("decision: varchar('decision'"));
    expect(compactSource(routes)).toContain(compactSource("'/projects/:projectId/assets/:generatedAssetLinkId/approval'"));
    expect(compactSource(routes)).toContain(compactSource("capability = 'review_assets'"));
  });
});
