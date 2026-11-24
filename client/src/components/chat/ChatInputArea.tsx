import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { getPersona } from "@/lib/agent-personas";
import { CAMPAIGN_AGENT_MENTIONS } from "../../../../shared/campaignAgentMentions";

interface ChatInputAreaProps {
  input: string;
  setInput: (value: string) => void;
  isProcessing: boolean;
  isListening: boolean;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onToggleVoice: () => void;
  onFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  attachmentAccept?: string;
  hasAttachments?: boolean;
  isUploadingAttachments?: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  contextIndicator?: ReactNode;
  attachmentIndicator?: ReactNode;
  allowQueue?: boolean;
  onStop?: () => void;
}

export function ChatInputArea({
  input,
  setInput,
  isProcessing,
  isListening,
  onSend,
  onKeyDown,
  onToggleVoice,
  onFileImport,
  attachmentAccept,
  hasAttachments = false,
  isUploadingAttachments = false,
  textareaRef,
  contextIndicator,
  attachmentIndicator,
  allowQueue = false,
  onStop,
}: ChatInputAreaProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const revealFocusedComposer = () => {
      const composer = composerRef.current;
      if (!composer?.contains(document.activeElement)) return;
      composer.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('resize', revealFocusedComposer);
    window.visualViewport?.addEventListener('resize', revealFocusedComposer);
    return () => {
      window.removeEventListener('resize', revealFocusedComposer);
      window.visualViewport?.removeEventListener('resize', revealFocusedComposer);
    };
  }, []);
  const listId = useId();
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const mentionMatch = /^(\s*(?:@[a-z_]+\s+)*)@([a-z_]*)$/i.exec(input);
  const mentionQuery = mentionMatch?.[2].toLowerCase();
  const choices = mentionQuery === undefined || isProcessing || isListening || dismissedInput === input ? []
    : CAMPAIGN_AGENT_MENTIONS.filter(item => {
      const persona = getPersona(item.agent);
      return [item.handle, ...item.aliases, persona.fullName, persona.role].some(value => value.toLowerCase().includes(mentionQuery));
    });
  const activeIndex = Math.min(highlighted, Math.max(0, choices.length - 1));
  const selectAgent = (handle: string) => {
    setInput(`${mentionMatch?.[1] ?? ''}@${handle} `);
    setHighlighted(0);
    textareaRef.current?.focus();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (choices.length && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        selectAgent(choices[activeIndex].handle);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedInput(input);
        return;
      }
    }
    onKeyDown(event);
  };

  return (
    <div ref={composerRef} className="relative z-20 shrink-0 bg-transparent px-3 pb-3 sm:px-4"
      onFocusCapture={event => {
        const composer = event.currentTarget;
        const bounds = composer.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? window.innerHeight);
        if (bounds.top < top || bounds.bottom > bottom) composer.scrollIntoView({ block: 'nearest' });
      }}>
      <div className="max-w-4xl mx-auto w-full">
        <div className="relative group">
          {choices.length > 0 && (
            <div id={listId} role="listbox" aria-label="Campaign agents" className="absolute bottom-full z-30 mb-2 w-full overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
              {choices.map((item, index) => {
                const persona = getPersona(item.agent);
                return <button key={item.agent} id={`${listId}-${index}`} type="button" role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => selectAgent(item.handle)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}>
                  <span>{item.agent === 'icp_generation' ? 'ICP Specialist' : persona.fullName}</span>
                  <span className="text-xs text-muted-foreground">@{item.handle}</span>
                </button>;
              })}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            onChange={onFileImport}
            className="hidden"
            accept={attachmentAccept}
            multiple
          />
          <ConversationComposer
            value={input}
            onValueChange={value => { setHighlighted(0); setDismissedInput(null); setInput(value); }}
            onSend={onSend}
            onKeyDown={handleKeyDown}
            placeholder={isProcessing ? "Queue a follow-up or correction…" : "Ask the team or @mention an agent…"}
            inputAria={{ 'aria-expanded': choices.length > 0, 'aria-controls': choices.length ? listId : undefined,
              'aria-activedescendant': choices.length ? `${listId}-${activeIndex}` : undefined, 'aria-autocomplete': 'list' }}
            busy={isProcessing}
            allowQueue={allowQueue}
            onStop={onStop}
            disabled={isProcessing && !allowQueue}
            inputDisabled={isListening}
            sendDisabled={(!input.trim() && !hasAttachments) || isListening || isUploadingAttachments}
            textareaRef={textareaRef}
            onAttach={() => fileInputRef.current?.click()}
            attachmentDisabled={isUploadingAttachments}
            onToggleVoice={onToggleVoice}
            listening={isListening}
            voiceLabel="Start dictation"
            controlsLayout="toolbar"
            context={contextIndicator}
            attachments={attachmentIndicator}
            maxHeight={120}
          />
        </div>
      </div>
    </div>
  );
}
