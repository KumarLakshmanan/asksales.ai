import { assistantBindingKey, sameModel, type AssistantCatalog, type AssistantDraft } from '@/lib/outreach-assistants';

export function assistantCreationIssues(draft: AssistantDraft, catalog: AssistantCatalog): string[][] {
  return [
    [
      ...(!draft.name.trim() ? ['Enter an assistant name.'] : []),
      ...(draft.name.length > 120 ? ['Keep the assistant name within 120 characters.'] : []),
      ...(!catalog.presets.some(preset => preset.agentType === draft.agentType) ? ['Choose a specialist preset.'] : []),
    ],
    [
      ...(!draft.bindings.length ? ['Select at least one connected receiving account.'] : []),
      ...(draft.bindings.length > 100 ? ['Select no more than 100 receiving accounts.'] : []),
      ...(draft.bindings.some(binding => binding.surface !== 'private' || !catalog.accounts.some(account => account.connected && assistantBindingKey(account) === assistantBindingKey(binding)))
        ? ['Reconnect or remove unavailable receiving accounts.'] : []),
    ],
    !catalog.models.some(model => sameModel(model, draft.replyModel)) ? ['Choose an available reply model.'] : [],
  ];
}
