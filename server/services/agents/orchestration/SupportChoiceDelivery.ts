import crypto from 'node:crypto';
import type {
  PlaybookFieldDefinition,
  SupportChoiceManifest,
} from '../../../models/supportOrchestration/schema.js';
import { normalizeMatchText as normalizedChoiceText } from '../../../utils/matchText.js';
export type { SupportChoiceManifest, SupportChoiceOption } from '../../../models/supportOrchestration/schema.js';

const labelFitsNativeControls = (label: string): boolean => label.trim().length > 0 && label.trim().length <= 20;

/**
 * Match only an exact, published selection. This is intentionally stricter
 * than general NLU so a phrase such as "do not request a callback" cannot be
 * mistaken for the "Request a callback" choice.
 */
export function matchExactPlaybookChoice(
  field: PlaybookFieldDefinition,
  inboundText: string,
): { value: string | boolean; label: string } | undefined {
  const input = normalizedChoiceText(inboundText);
  if (!input) return undefined;
  if (field.type === 'boolean') {
    if (['yes', 'y', 'confirm', 'confirmed', 'i agree', 'please do'].includes(input)) {
      return { value: true, label: 'Yes' };
    }
    if (['no', 'n', 'do not', 'don t', 'decline'].includes(input)) {
      return { value: false, label: 'No' };
    }
    return undefined;
  }
  if (field.type !== 'single_select') return undefined;
  const numbered = input.match(/^(\d{1,2})$/);
  if (numbered) {
    const option = field.options?.[Number(numbered[1]) - 1];
    return option ? { value: option.value, label: option.label } : undefined;
  }
  const matches = (field.options || []).filter((option) => [
    option.value,
    option.label,
    option.shortLabel,
    ...(option.aliases || []),
  ].filter((term): term is string => typeof term === 'string')
    .map(normalizedChoiceText)
    .includes(input));
  return matches.length === 1 ? { value: matches[0].value, label: matches[0].label } : undefined;
}

function optionId(runId: number, nodeId: string, fieldKey: string, value: string): string {
  const digest = crypto.createHash('sha256')
    .update(`${runId}:${nodeId}:${fieldKey}:${value}`)
    .digest('base64url')
    .slice(0, 24);
  return `choice_v1_${digest}`;
}

export function createSupportChoiceManifest(input: {
  runId: number;
  nodeId: string;
  field: PlaybookFieldDefinition;
  preface?: string;
}): SupportChoiceManifest | undefined {
  const { field } = input;
  const configuredOptions = field.type === 'boolean'
    ? [
      { value: 'true', label: 'Yes', shortLabel: 'Yes' },
      { value: 'false', label: 'No', shortLabel: 'No' },
    ]
    : field.type === 'single_select'
      ? (field.options || [])
      : [];
  if (!configuredOptions.length) return undefined;

  const prompt = [String(input.preface || '').trim(), field.prompt.trim()].filter(Boolean).join('\n');
  const options = configuredOptions.map((option) => {
    const requestedShortLabel = String(option.shortLabel || option.label).trim();
    return {
      id: optionId(input.runId, input.nodeId, field.key, option.value),
      value: option.value,
      label: option.label.trim(),
      // Keep the invalid value in the manifest so the provider renderer can
      // safely fall back to text instead of silently truncating its meaning.
      shortLabel: requestedShortLabel,
    };
  });
  const fallbackText = [
    prompt,
    '',
    ...options.map((option, index) => `${index + 1}. ${option.label}`),
    '',
    'Reply with a number or describe your choice in your own words.',
  ].join('\n').trim();
  return {
    schemaVersion: 1,
    fieldKey: field.key,
    prompt,
    fallbackText,
    allowFreeText: true,
    options,
  };
}

export function choiceSupportsMetaQuickReplies(choice: SupportChoiceManifest): boolean {
  return choice.options.length >= 1
    && choice.options.length <= 13
    && choice.options.every((option) => labelFitsNativeControls(option.shortLabel))
    && choice.prompt.length <= 1000;
}

export function buildMetaQuickReplies(choice: SupportChoiceManifest): Array<{
  content_type: 'text';
  title: string;
  payload: string;
}> | undefined {
  if (!choiceSupportsMetaQuickReplies(choice)) return undefined;
  return choice.options.map((option) => ({
    content_type: 'text',
    title: option.shortLabel,
    payload: option.id,
  }));
}

export function buildWhatsAppInteractive(
  choice: SupportChoiceManifest,
  bodyText: string = choice.prompt,
): Record<string, unknown> | undefined {
  const prompt = bodyText.trim() || choice.prompt;
  if (prompt.length > 1024) return undefined;
  if (choice.options.length >= 1
    && choice.options.length <= 3
    && choice.options.every((option) => labelFitsNativeControls(option.shortLabel))) {
    return {
      type: 'button',
      body: { text: prompt },
      action: {
        buttons: choice.options.map((option) => ({
          type: 'reply',
          reply: { id: option.id, title: option.shortLabel },
        })),
      },
    };
  }
  if (choice.options.length >= 1
    && choice.options.length <= 10
    && choice.options.every((option) => labelFitsNativeControls(option.shortLabel))) {
    return {
      type: 'list',
      body: { text: prompt },
      action: {
        button: 'Choose an option',
        sections: [{
          title: 'Available choices',
          rows: choice.options.map((option) => ({
            id: option.id,
            title: option.shortLabel,
            ...(option.shortLabel !== option.label ? { description: option.label.slice(0, 72) } : {}),
          })),
        }],
      },
    };
  }
  return undefined;
}

export function normalizeWhatsAppInboundText(message: {
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { payload?: string; text?: string };
}): { text: string; selection?: { kind: string; id?: string; title: string } } {
  if (typeof message.text?.body === 'string' && message.text.body.trim()) {
    return { text: message.text.body };
  }
  const interactiveReply = message.interactive?.type === 'button_reply'
    ? message.interactive.button_reply
    : message.interactive?.type === 'list_reply'
      ? message.interactive.list_reply
      : undefined;
  if (interactiveReply?.title?.trim()) {
    const kind = message.interactive?.type === 'list_reply' ? 'list_reply' : 'button_reply';
    return {
      text: interactiveReply.title.trim(),
      selection: {
        kind,
        id: interactiveReply.id?.slice(0, 255),
        title: interactiveReply.title.trim().slice(0, 255),
      },
    };
  }
  if (message.button?.text?.trim()) {
    return {
      text: message.button.text.trim(),
      selection: {
        kind: 'template_button',
        id: message.button.payload?.slice(0, 255),
        title: message.button.text.trim().slice(0, 255),
      },
    };
  }
  return { text: `[${String(message.type || 'unsupported')} message]` };
}
