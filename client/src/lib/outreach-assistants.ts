import {
  assistantBindingKey,
  type AssistantAccount,
  type AssistantAvailability,
  type AssistantBindingInput,
  type AssistantCatalog,
  type AssistantChannel,
  type AssistantDraft,
  type AssistantModel,
  type AssistantResource,
  type OutreachAssistant, assistantModelKey as modelKey,
} from '../../../shared/outreachAssistants';
export { modelKey };

export * from '../../../shared/outreachAssistants';

export const assistantChannelLabels: Record<AssistantChannel, string> = {
  whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook Messenger', email: 'Email', web: 'Web chat',
};
export const assistantStateLabels = { draft: 'Draft', live: 'Live', paused: 'Paused', needs_attention: 'Needs attention' } as const;
export const sameModel = (a: AssistantModel | null, b: AssistantModel | null) => !!a && !!b && a.provider === b.provider && a.model === b.model;
export const accountLabel = (account: AssistantAccount) => `${account.label} · ${account.surface === 'public_comment' ? 'Public comments' : 'Private messages'}`;
export function resourceSupportsChannel(resource: AssistantResource, channel: AssistantChannel, surface = 'private'): boolean {
  const key = surface === 'public_comment' ? `${channel}_comment` : channel;
  return resource.channels.includes(key) || resource.channels.includes(channel) || resource.channels.includes('all');
}
/** Live cards show current routing, not the historical bindings in a published revision. */
export function assistantListBindings(assistant: OutreachAssistant): AssistantBindingInput[] {
  if (['live', 'needs_attention'].includes(assistant.state) && assistant.published) return assistant.enabledBindings ?? assistant.published.bindings;
  return assistant.draft.bindings;
}
export function displayedAssistantState(assistant: OutreachAssistant, catalog: AssistantCatalog): OutreachAssistant['state'] {
  if (assistant.state !== 'live') return assistant.state;
  if (!catalog.runtimeEnabled) return 'needs_attention';
  // readiness describes the editable draft. A partial next draft must not
  // downgrade a currently live published configuration reported by the server.
  const bindings = assistantListBindings(assistant);
  if (!assistant.published || !assistant.publishedRevision || !bindings.length) return 'needs_attention';
  return bindings.every(binding => catalog.accounts.some(account => assistantBindingKey(account) === assistantBindingKey(binding) && account.connected))
    ? 'live' : 'needs_attention';
}
export function draftResourceSummary(draft: AssistantDraft): { label: string; mode: string; count: number }[] {
  return [
    { label: 'Knowledge sources', mode: draft.knowledge.mode, count: draft.knowledge.ids.length },
    { label: 'Playbook assignments', mode: draft.playbooks.mode, count: draft.playbooks.assignments.length },
    { label: 'Follow-up sequences', mode: draft.followUps.mode, count: draft.followUps.sequences.length },
    { label: 'Brochures & documents', mode: draft.documents.mode, count: draft.documents.ids.length },
    { label: 'Galleries', mode: draft.galleries.mode, count: draft.galleries.ids.length },
    { label: 'Tools', mode: draft.tools.mode, count: draft.tools.names.length },
  ];
}
export function draftAssignmentDetails(draft: AssistantDraft, catalog: AssistantCatalog): Record<string, string[]> {
  const names = (ids: number[], resources: AssistantResource[]) => ids.map(id => resources.find(resource => resource.id === id)?.name || `Unavailable resource ${id}`);
  return {
    'Knowledge sources': names(draft.knowledge.ids, catalog.knowledge),
    'Playbook assignments': draft.playbooks.assignments.map(assignment => `${catalog.playbooks.find(playbook => playbook.id === assignment.playbookId)?.name || `Unavailable playbook ${assignment.playbookId}`} → ${assistantChannelLabels[assignment.channel]} / ${assignment.surface === 'public_comment' ? 'Comments' : 'Private'} · ${assignment.intent || 'Any intent'}`),
    'Follow-up sequences': draft.followUps.sequences.map(sequence => `${assistantChannelLabels[sequence.channel]}: ${sequence.steps.map(step => `${step.delayMinutes} min → ${step.messageMode === 'ai' ? 'AI-generated reply (open 24-hour window only)' : catalog.templates.find(template => template.id === step.templateId)?.name || 'Template not selected'}`).join('; ')}`),
    'Brochures & documents': names(draft.documents.ids, catalog.documents),
    'Galleries': names(draft.galleries.ids, catalog.galleries),
    'Tools': draft.tools.names.map(name => `${catalog.tools.find(tool => tool.name === name)?.label || name}${draft.tools.approvalRequired.includes(name) ? ' · Approval required' : ''}`),
  };
}
export function assistantAvailabilityIssues(availability: AssistantAvailability): string[] {
  const issues: string[] = [];
  try { new Intl.DateTimeFormat('en', { timeZone: availability.timezone }).format(); } catch { issues.push('Choose a valid timezone.'); }
  if (availability.enabled && !availability.weekly.some(day => day.ranges.length)) issues.push('Add at least one availability range.');
  const days = new Set<number>();
  for (const day of availability.weekly) {
    if (!Number.isInteger(day.day) || day.day < 1 || day.day > 7 || days.has(day.day)) issues.push('Availability must contain unique weekdays.');
    days.add(day.day);
    let previousEnd = '';
    for (const range of [...day.ranges].sort((a, b) => a.start.localeCompare(b.start))) {
      const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
      const endClock = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
      if (!clock.test(range.start) || !endClock.test(range.end) || range.start >= range.end || range.start < previousEnd) issues.push('Availability ranges must not overlap or cross midnight.');
      previousEnd = range.end;
    }
  }
  return [...new Set(issues)];
}
/** UX validation only. The server rechecks readiness, permissions and assignments. */
export function assistantDraftIssues(draft: AssistantDraft, catalog: AssistantCatalog): string[] {
  const issues: string[] = [];
  if (!draft.name.trim()) issues.push('Enter an assistant name.');
  if (!catalog.presets.some(preset => preset.agentType === draft.agentType)) issues.push('Choose an available specialist preset.');
  if (!draft.replyModel || !catalog.models.some(model => sameModel(model, draft.replyModel))) issues.push(catalog.modelAvailabilityNotice || 'Choose an available reply model.');
  if (!Number.isInteger(draft.response.maxReplyTokens) || draft.response.maxReplyTokens < 64 || draft.response.maxReplyTokens > 8192) issues.push('Reply-length limit must be a whole number between 64 and 8192 tokens.');
  const model = catalog.models.find(item => sameModel(item, draft.replyModel));
  if (draft.response.temperature !== undefined && (!model?.controls.includes('temperature') || !Number.isFinite(draft.response.temperature) || draft.response.temperature < 0 || draft.response.temperature > 2)) issues.push('Remove unsupported response controls or set temperature between 0 and 2.');
  if (draft.response.topP !== undefined && (!model?.controls.includes('topP') || !Number.isFinite(draft.response.topP) || draft.response.topP < 0.01 || draft.response.topP > 1)) issues.push('Remove unsupported response controls or set Top P between 0.01 and 1.');
  if (!Number.isFinite(draft.privacy.minimumConfidence) || draft.privacy.minimumConfidence < 0.5 || draft.privacy.minimumConfidence > 1) issues.push('Confidence must be between 0.5 and 1.');
  if (draft.privacy.uncertaintyMessage.trim().length < 10 || draft.privacy.uncertaintyMessage.length > 500) issues.push('Enter an uncertainty message between 10 and 500 characters.');
  for (const fallback of draft.fallbackModels) if (sameModel(fallback, draft.replyModel) || !catalog.models.some(model => sameModel(model, fallback))) issues.push('Remove an unavailable or duplicate fallback model.');
  if (new Set(draft.fallbackModels.map(modelKey)).size !== draft.fallbackModels.length) issues.push('Remove an unavailable or duplicate fallback model.');
  if (!draft.bindings.length) issues.push('Select at least one receiving account.');
  if (new Set(draft.bindings.map(assistantBindingKey)).size !== draft.bindings.length) issues.push('Remove duplicate account assignments.');
  for (const binding of draft.bindings) {
    if (!catalog.accounts.some(account => assistantBindingKey(account) === assistantBindingKey(binding) && account.connected)) issues.push('Reconnect or remove an unavailable receiving account.');
  }
  for (const category of draftResourceSummary(draft)) {
    if (category.mode === 'unconfigured') issues.push(`Choose resources or None for ${category.label.toLowerCase()}.`);
    if (category.mode === 'selected' && !category.count) issues.push(`Select at least one item for ${category.label.toLowerCase()}, or choose None.`);
  }
  for (const [selection, resources, label] of [[draft.knowledge, catalog.knowledge, 'knowledge sources'], [draft.documents, catalog.documents, 'documents'], [draft.galleries, catalog.galleries, 'galleries']] as const) {
    if (selection.ids.some(id => !resources.some(resource => resource.id === id))) issues.push(`Remove unavailable ${label}.`);
  }
  for (const assignment of draft.playbooks.assignments) {
    const playbook = catalog.playbooks.find(item => item.id === assignment.playbookId);
    if (!playbook || (playbook.agentType && playbook.agentType !== draft.agentType) || !resourceSupportsChannel(playbook, assignment.channel, assignment.surface)) issues.push('Remove or replace an unavailable or incompatible playbook.');
    if (!draft.bindings.some(binding => binding.channel === assignment.channel && binding.surface === assignment.surface)) issues.push('Playbooks must use an assigned channel and surface.');
    if (!Number.isInteger(assignment.priority) || assignment.priority < 0) issues.push('Playbook priority must be a non-negative integer.');
  }
  if (new Set(draft.followUps.sequences.map(sequence => sequence.channel)).size !== draft.followUps.sequences.length) issues.push('Keep only one support follow-up sequence per channel.');
  for (const sequence of draft.followUps.sequences) {
    if (!draft.bindings.some(binding => binding.channel === sequence.channel && binding.surface === 'private')) issues.push('Follow-up sequences must use an assigned private-message channel.');
    if (!sequence.steps.length || sequence.steps.length > 3) issues.push('Each follow-up sequence must contain one to three steps.');
    for (const step of sequence.steps) {
      if (!Number.isInteger(step.delayMinutes) || step.delayMinutes < 1 || step.delayMinutes > 43200) issues.push('Follow-up delays must be whole minutes between 1 and 43200.');
      if (step.messageMode === 'ai') {
        if (sequence.channel !== 'whatsapp' || step.delayMinutes >= 1440 || step.templateId !== 0) issues.push('AI follow-ups require WhatsApp, a delay under 24 hours and no template selection.');
        continue;
      }
      const template = catalog.templates.find(item => item.id === step.templateId);
      if (!template || !resourceSupportsChannel(template, sequence.channel)) issues.push('Choose an available approved template for every follow-up step.');
    }
  }
  if (draft.tools.names.some(name => !catalog.tools.some(tool => tool.name === name))) issues.push('Remove unavailable tools.');
  if (catalog.tools.some(tool => tool.approvalRequired && draft.tools.names.includes(tool.name) && !draft.tools.approvalRequired.includes(tool.name))) issues.push('Keep mandatory tool approvals enabled.');
  if (draft.demonstrations.some(example => !example.customer.trim() || !example.assistant.trim())) issues.push('Complete both messages in each demonstration, or remove the example.');
  const collectionFields = new Set(draft.playbooks.assignments.flatMap(assignment => catalog.playbooks.find(playbook => playbook.id === assignment.playbookId)?.collectionFields || []));
  if (draft.privacy.permittedCollectionFields.some(field => !collectionFields.has(field))) issues.push('Personal collection fields must be permitted by a selected playbook.');
  issues.push(...assistantAvailabilityIssues(draft.availability));
  return [...new Set(issues)];
}
