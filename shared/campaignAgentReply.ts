export interface CampaignReplySpeaker {
  id: string;
  names: readonly string[];
}

function speakerPrefix(names: readonly string[]): RegExp {
  const alternatives = [...new Set(names)].sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Only an explicit label at the start of a line, including common Markdown
  // variants. Names in sentences, quotations, tables and code are untouched.
  return new RegExp(`^ {0,3}(?:#{1,6} +)?(?:(?:\\*\\*|__)(?:${alternatives})(?::(?:\\*\\*|__)|(?:\\*\\*|__):)|(?:${alternatives}):)[ \\t]*`, 'i');
}

export function campaignSpeakerSections(text: string, speakers: readonly CampaignReplySpeaker[]) {
  if (/^\s*(?:```|~~~|>)/m.test(text) || /^(?: {4}|\t)/m.test(text)) return null;
  const sections: Array<{ speaker: string; content: string }> = [];
  for (const line of text.trim().split('\n')) {
    const speaker = speakers.find(candidate => speakerPrefix(candidate.names).test(line));
    if (speaker) {
      sections.push({ speaker: speaker.id, content: line.replace(speakerPrefix(speaker.names), '') });
    } else if (!sections.length || /^ {0,3}(?:#{1,6} +)?(?:\*\*|__)?[A-Z][A-Za-z ]{0,50}:(?:\*\*|__)?/.test(line)) {
      // Unlabelled preamble or another attributed section is ambiguous.
      return null;
    } else {
      sections[sections.length - 1].content += `\n${line}`;
    }
  }
  return sections.length ? sections : null;
}

/** Extract a specialist's answer only when the entire reply is explicitly
 * attributed to members of this coordinated turn. Never infer from prose. */
export function selectCampaignSpeakerReply(text: string, speakerId: string, speakers: readonly CampaignReplySpeaker[]) {
  const sections = campaignSpeakerSections(text, speakers);
  const own = sections?.filter(section => section.speaker === speakerId);
  return own?.length ? own.map(section => section.content.trim()).join('\n\n') || text : text;
}

export function stripCampaignSpeakerLabel(text: string, speaker: CampaignReplySpeaker, speakers: readonly CampaignReplySpeaker[]) {
  const trimmed = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  if (!speakerPrefix(speaker.names).test(trimmed)) return text;
  // A transcript or combined summary needs its attributions. Only remove a
  // redundant self-label when no other speaker has a labelled section.
  if (speakers.some(other => other.id !== speaker.id
    && !other.names.some(name => speaker.names.includes(name))
    && trimmed.split('\n').some(line => speakerPrefix(other.names).test(line)))) return text;
  return trimmed.replace(speakerPrefix(speaker.names), '').trimStart() || text;
}
