import type { WhatsAppTemplateRecord } from '../models/whatsappTemplates/schema.js';

const contentKeys = ['name', 'language', 'category', 'body', 'header', 'headerType', 'headerMediaUrl', 'footer', 'buttons', 'examples', 'variableLabels', 'authConfig'] as const;
export function templateSnapshot(template: Partial<WhatsAppTemplateRecord>): Record<string, unknown> {
  return Object.fromEntries(contentKeys.map((key) => [key, template[key] ?? null]));
}
export function templateActivity(template: Partial<WhatsAppTemplateRecord> | null, action: string, content?: Partial<WhatsAppTemplateRecord>, status?: string) {
  const history = Array.isArray(template?.activityHistory) ? template.activityHistory : [];
  return [...history.slice(-49), { at: new Date().toISOString(), action, ...(status ? { status } : {}), ...(content ? { snapshot: templateSnapshot(content) } : {}) }];
}
export function existingApprovedSnapshot(template: Partial<WhatsAppTemplateRecord>) {
  return template.approvedSnapshot ?? (String(template.metaStatus || template.status).toUpperCase() === 'APPROVED' && !template.hasLocalChanges ? templateSnapshot(template) : null);
}
export function parseTemplateListQuery(query: Record<string, unknown>): { error?: string; data?: { page: number; pageSize: number; search: string; category: string; status: string; language: string; sort: string } } {
  const text = (key: string) => query[key] == null ? '' : typeof query[key] === 'string' ? String(query[key]).trim() : null;
  if (Object.keys(query).some((key) => text(key) === null)) return { error: 'Template filters must be single text values' };
  const page = Number(text('page') || '1'), pageSize = Number(text('pageSize') || '12');
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return { error: 'Page must be a positive integer and page size between 1 and 100' };
  const search = text('search') || '', category = text('category') || '', status = text('status') || '', language = text('language') || '', sort = text('sort') || 'updated_desc';
  if (search.length > 255 || language.length > 50 || !/^[a-zA-Z0-9_]*$/.test(language)) return { error: 'Search or language filter is invalid' };
  if (category && !['MARKETING','UTILITY','AUTHENTICATION','all','ALL'].includes(category)) return { error: 'Unknown category filter' };
  if (status && !['DRAFT','APPROVED','PENDING','REJECTED','PAUSED','DISABLED','all','ALL'].includes(status)) return { error: 'Unknown status filter' };
  if (!['updated_desc','updated_asc','name_asc','name_desc'].includes(sort)) return { error: 'Unknown template sort order' };
  return { data: { page, pageSize, search, category: /all/i.test(category) ? '' : category, status: /all/i.test(status) ? '' : status, language: /^(all|ALL)$/.test(language) ? '' : language, sort } };
}
export function clientTemplateRevisionMatches(clientRevision: unknown, template: { revision: string; updatedAt: Date }): boolean {
  if (clientRevision == null) return true;
  if (typeof clientRevision !== 'string' || clientRevision.length > 64) return false;
  if (clientRevision === template.revision) return true;
  // ISO dates have millisecond precision. GET returns exact PostgreSQL revision
  // where available; retain compatibility with older clients using updatedAt.
  return /^\d{4}-\d{2}-\d{2}T/.test(clientRevision) && new Date(clientRevision).getTime() === new Date(template.updatedAt).getTime();
}

/** Keep media used by the bounded history/approved revision until that reference
 * is evicted or the template is deleted. Storage still verifies ownership. */
export function templateMediaReferences(template: Partial<WhatsAppTemplateRecord>): string[] {
  const snapshots = [template, template.approvedSnapshot, template.submittedSnapshot,
    ...(Array.isArray(template.activityHistory) ? template.activityHistory.map((event) => event?.snapshot) : [])];
  return [...new Set(snapshots.flatMap((snapshot) => {
    const reference = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>).headerMediaUrl : null;
    return typeof reference === 'string' && reference.trim() ? [reference] : [];
  }))];
}
