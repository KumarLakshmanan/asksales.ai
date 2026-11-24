import type { AssistantCatalog, AssistantChannel } from '../../../shared/outreachAssistants.js';
import { ASSISTANT_CHANNELS } from '../../../shared/outreachAssistants.js';
import { ASSISTANT_RESOURCE_CATEGORIES, type AssistantPickerItem, type AssistantResourceCategory, type AssistantResourcePage } from '../../../shared/assistantResourcePicker.js';
import { AssistantManagementError } from './AssistantManagementError.js';

export function assistantResourceFilters(category: string, raw: Record<string, unknown>) {
  if (!ASSISTANT_RESOURCE_CATEGORIES.includes(category as AssistantResourceCategory)) throw new AssistantManagementError('Unknown assistant resource category.', 400);
  const text = (key: string, max: number) => {
    const value = raw[key] ?? '';
    if (typeof value !== 'string' || value.length > max) throw new AssistantManagementError(`Invalid resource ${key}.`, 400);
    return value.trim();
  };
  const integer = (key: string, fallback: number, max: number) => {
    const value = raw[key] ?? String(fallback);
    if (typeof value !== 'string' || !/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new AssistantManagementError(`Invalid resource ${key}.`, 400);
    return Number(value);
  };
  const channels = text('channels', 100).split(',').filter(Boolean);
  if (channels.some(channel => !ASSISTANT_CHANNELS.includes(channel as AssistantChannel))) throw new AssistantManagementError('Invalid resource channels.', 400);
  const bindings = text('bindings', 5000).split(',').filter(Boolean).map(value => value.split(':'));
  if (bindings.length > 100 || bindings.some(parts => parts.length !== 2 || !ASSISTANT_CHANNELS.includes(parts[0] as AssistantChannel) || !['private', 'public_comment'].includes(parts[1]))) throw new AssistantManagementError('Invalid resource account surfaces.', 400);
  return { category: category as AssistantResourceCategory, search: text('search', 200).toLowerCase(), page: integer('page', 1, 100000), pageSize: integer('pageSize', 20, 50), agentType: text('agentType', 80), channels, bindings };
}

/** The input catalog already enforces business, published-version and audience access. */
export function assistantResourcePage(catalog: AssistantCatalog, filters: ReturnType<typeof assistantResourceFilters>): AssistantResourcePage {
  // Every tool stays selectable; the role's own defaults are marked and listed first.
  const roleTools = new Set(catalog.presets?.find(preset => preset.agentType === filters.agentType)?.tools || []);
  const source: AssistantPickerItem[] = filters.category === 'tools'
    ? catalog.tools.map(tool => ({ id: tool.name, name: tool.label, channels: [], approvalRequired: tool.approvalRequired, ...(roleTools.has(tool.name) ? { recommended: true } : {}) }))
    : catalog[filters.category].map(resource => ({ ...resource, id: String(resource.id) }));
  const matches = source.filter(resource =>
    (!filters.agentType || !resource.agentType || resource.agentType === filters.agentType)
    && (!filters.bindings.length || resource.channels.includes('all') || filters.bindings.some(([channel, surface]) => resource.channels.includes(channel) || (surface === 'public_comment' && resource.channels.includes(`${channel}_comment`))))
    && (!filters.channels.length || !resource.channels.length || resource.channels.includes('all') || filters.channels.some(channel => resource.channels.includes(channel) || resource.channels.includes(`${channel}_comment`)))
    && (!filters.search || `${resource.name} ${resource.channels.join(' ')} ${resource.preview || ''}`.toLowerCase().includes(filters.search)),
  ).sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const start = (filters.page - 1) * filters.pageSize;
  return { items: matches.slice(start, start + filters.pageSize), total: matches.length, page: filters.page, pageSize: filters.pageSize, hasMore: start + filters.pageSize < matches.length };
}
