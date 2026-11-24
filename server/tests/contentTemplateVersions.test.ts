import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Isolated in-memory transactional adapter: no application DB or provider is contacted.
type Row = Record<string, any>;
const templates = new Map<number, Row>();
let versions: Row[] = [];
let nextId = 20;
let lockTail = Promise.resolve();
let lockModes: string[] = [];
type Condition = (row: Row) => boolean;
const templateTable = { table: 'templates', id: 'id', userId: 'userId', isPredefined: 'isPredefined', isApproved: 'isApproved' };
const versionTable = { table: 'versions', templateId: 'templateId', version: 'version', snapshot: 'snapshot' };

// This suite isolates Content version semantics. The real canonical Storage
// composition, rollback and byte lifecycle run in contentManagedReferencesPostgres.
jest.unstable_mockModule('../services/content/ContentManagedStorageService.js', () => ({
  lockContentManagedStorage: jest.fn(), syncContentManagedStorage: jest.fn(), releaseContentManagedStorage: jest.fn(),
  contentStorageOwner: (kind: string, row: Row) => row.userId && row.businessProfileId
    ? { kind, id: String(row.id), userId: row.userId, businessProfileId: row.businessProfileId } : undefined,
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  eq: (field: string | ((row: Row) => unknown), value: unknown) => (row: Row) => (typeof field === 'function' ? field(row) : row[field]) === value,
  and: (...conditions: Array<Condition | undefined>) => (row: Row) => conditions.every((condition) => !condition || condition(row)),
  or: (...conditions: Condition[]) => (row: Row) => conditions.some((condition) => condition(row)),
  desc: (field: string) => field, ilike: jest.fn(), sql: () => (row: Row) => String(row.snapshot.isApproved), count: jest.fn(),
}));
jest.unstable_mockModule('../models/contentTemplates/schema', () => ({
  contentTemplatesTable: templateTable, contentTemplateVersionsTable: versionTable,
}));

function adapter(releases: Array<() => void> = []) {
  return {
    select() {
      let table = templateTable;
      let where: Condition = () => true;
      let lock: string | undefined;
      const query: any = {
        from(value: typeof templateTable) { table = value; return query; },
        where(value: Condition) { where = value; return query; },
        limit() { return query; }, orderBy() { return query; },
        for(mode: string) { lock = mode; return query; },
        async then(resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) {
          try {
            if (lock) {
              lockModes.push(lock);
              const previous = lockTail;
              lockTail = new Promise<void>((release) => releases.push(release));
              await previous;
            }
            const rows = table.table === 'versions' ? versions : [...templates.values()];
            return resolve(rows.filter(where).map((row) => ({ ...row })).sort((a, b) => b.version - a.version));
          } catch (error) { return reject(error); }
        },
      };
      return query;
    },
    update() {
      let data: Row;
      let where: Condition;
      const query = {
        set(value: Row) { data = value; return query; },
        where(value: Condition) { where = value; return query; },
        async returning() {
          const current = [...templates.values()].find(where);
          if (!current) return [];
          const result = { ...current, ...data };
          templates.set(result.id, result);
          return [result];
        },
      };
      return query;
    },
    insert(table: { table: string }) {
      return { values(data: Row) {
        if (table.table === 'versions') {
          if (versions.some((row) => row.templateId === data.templateId && row.version === data.version)) throw new Error('duplicate template version');
          const row = { ...data, id: nextId++ };
          versions.push(row);
          return { returning: async () => [row] };
        }
        const row = { version: 1, ...data, id: nextId++ };
        templates.set(row.id, row);
        return { returning: async () => [row] };
      } };
    },
  };
}
jest.unstable_mockModule('../models/db', () => ({ db: {
  ...adapter(),
  async transaction(callback: (tx: ReturnType<typeof adapter>) => Promise<unknown>) {
    const releases: Array<() => void> = [];
    try { return await callback(adapter(releases)); }
    finally { releases.forEach((release) => release()); }
  },
} }));

const model = await import('../models/contentTemplates/functions');
const original = () => ({ id: 1, userId: 7, version: 4, name: 'Reusable email', type: 'email', content: 'Hello', htmlContent: '<p>Hello</p>', variables: [], isPredefined: false, isApproved: false, brandToolkitId: 11, businessProfileId: 12, brandContextSnapshot: { tenant: 7 }, approvedAt: null });

describe('reusable template version persistence', () => {
  beforeEach(() => { templates.clear(); templates.set(1, original()); versions = []; nextId = 20; lockTail = Promise.resolve(); lockModes = []; });

  it('serializes simultaneous saves and snapshots their own complete content', async () => {
    const [first, second] = await Promise.all([
      model.updateContentTemplateForUser(1, 7, { content: 'First', isApproved: true }),
      model.updateContentTemplateForUser(1, 7, { content: 'Second', isApproved: true }),
    ]);
    expect(lockModes).toEqual(['update', 'update']);
    expect([first?.version, second?.version]).toEqual([5, 6]);
    expect(versions.map((row) => [row.version, row.snapshot.content, row.snapshot.isApproved])).toEqual([[5, 'First', true], [6, 'Second', true]]);
  });

  it('rejects a stale validated edit instead of storing metadata derived from an older version', async () => {
    await model.updateContentTemplateForUser(1, 7, { content: 'New content' }, 4);
    await expect(model.updateContentTemplateForUser(1, 7, { content: 'Stale content' }, 4)).rejects.toBeInstanceOf(model.ContentTemplateVersionConflictError);
    expect(versions).toHaveLength(1);
    expect(templates.get(1)?.content).toBe('New content');
  });

  it('serializes approvals and does not add a second identical approval version', async () => {
    const [first, second] = await Promise.all([model.approveContentTemplateForUser(1, 7), model.approveContentTemplateForUser(1, 7)]);
    expect([first?.version, second?.version]).toEqual([5, 5]);
    expect(versions).toHaveLength(1);
    expect(lockModes).toEqual(['update', 'update']);
  });

  it('refuses to approve a template changed since validation', async () => {
    await model.updateContentTemplateForUser(1, 7, { content: 'Changed' });
    await expect(model.approveContentTemplateForUser(1, 7, undefined, 4)).rejects.toBeInstanceOf(model.ContentTemplateVersionConflictError);
    expect(templates.get(1)?.isApproved).toBe(false);
  });

  it('keeps another tenant from modifying or approving a template', async () => {
    expect(await model.updateContentTemplateForUser(1, 8, { content: 'Unauthorized' })).toBeNull();
    expect(await model.approveContentTemplateForUser(1, 8)).toBeNull();
    expect(versions).toHaveLength(0);
  });

  it('starts a duplicate at version one and retains copy content without approval', async () => {
    const copy = await model.duplicateContentTemplate(1, 7);
    expect(copy).toMatchObject({ version: 1, name: 'Reusable email (Copy)', content: 'Hello', htmlContent: '<p>Hello</p>', isApproved: false, approvedBy: null, usageCount: 0 });
    expect(versions[0]).toMatchObject({ templateId: copy?.id, version: 1, createdBy: 7, snapshot: { content: 'Hello' } });
  });

  it('rejects copies of private templates from another tenant', async () => {
    expect(await model.duplicateContentTemplate(1, 8)).toBeNull();
    expect(templates.size).toBe(1);
  });

  it('can duplicate a template whose name already reaches the database limit', async () => {
    templates.set(1, { ...original(), name: 'a'.repeat(255) });
    expect((await model.duplicateContentTemplate(1, 7))?.name).toHaveLength(255);
  });

  it('never copies predefined creator governance into another tenant', async () => {
    templates.set(1, { ...original(), isPredefined: true, isApproved: true });
    const copy = await model.duplicateContentTemplate(1, 8);
    expect(copy).toMatchObject({ userId: 8, businessProfileId: null, brandToolkitId: null, brandContextSnapshot: {}, version: 1, isPredefined: false });
  });

  it('imports with caller governance in the first and only snapshot', async () => {
    templates.set(1, { ...original(), isPredefined: true, isApproved: true });
    const copy = await model.duplicateContentTemplate(1, 8, { businessProfileId: 80, brandToolkitId: 81, brandContextSnapshot: { tenant: 8 } });
    expect(copy).toMatchObject({ version: 1, isApproved: true, approvedBy: 8 });
    expect(versions).toHaveLength(1);
    expect(versions[0].snapshot).toMatchObject({ businessProfileId: 80, brandToolkitId: 81, brandContextSnapshot: { tenant: 8 } });
  });

  it('hides unapproved predefined history and copies from other tenants', async () => {
    templates.set(1, { ...original(), isPredefined: true });
    expect(await model.duplicateContentTemplate(1, 8)).toBeNull();
    expect(await model.getContentTemplateVersionsForUser(1, 8)).toEqual([]);
  });

  it('does not expose older unapproved snapshots when a predefined template is shared', async () => {
    templates.set(1, { ...original(), isPredefined: true, isApproved: true });
    versions = [
      { templateId: 1, version: 1, snapshot: { isApproved: false, content: 'Private draft' } },
      { templateId: 1, version: 2, snapshot: { isApproved: true, content: 'Shared final' } },
    ];
    expect((await model.getContentTemplateVersionsForUser(1, 8)).map((row) => row.version)).toEqual([2]);
    expect((await model.getContentTemplateVersionsForUser(1, 7)).map((row) => row.version)).toEqual([2, 1]);
  });
});
