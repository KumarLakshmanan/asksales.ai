import fs from 'node:fs';
import path from 'node:path';

describe('support member resources', () => {
  it('keeps member media and playbooks read-only and published-only', () => {
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'routes/supportMember.routes.ts'), 'utf8');
    const resources = fs.readFileSync(path.resolve(process.cwd(), 'controllers/supportMemberResourcesController.ts'), 'utf8');
    expect(routes).toContain("router.get('/media-galleries', listMemberMediaGalleries)");
    expect(routes).toContain("router.get('/playbooks', listMemberPlaybooks)");
    expect(routes).not.toContain("router.post('/media-galleries'");
    expect(resources).toContain('publishedMediaAssetAccess');
    expect(resources).toContain('publishedMediaGalleryAccess');
    expect(resources).toContain("eq(supportPlaybooksTable.status, 'published')");
    expect(resources).toContain('eq(supportPlaybooksTable.enabled, true)');
  });
});
