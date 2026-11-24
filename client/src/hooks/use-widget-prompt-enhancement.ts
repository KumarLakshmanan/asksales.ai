"use client";

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { creatorSessionScope } from '@/lib/creator-session';

/** A response may update only the widget and prompt revision that requested it. */
export function useWidgetPromptEnhancement({ widgetId, threadId, contentType, prompt, apply }: {
  widgetId: number;
  threadId: number;
  contentType: 'image' | 'video';
  prompt: string;
  apply: (prompt: string) => void;
}) {
  const { toast } = useToast();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const session = creatorSessionScope();
  const identity = `${session}:${threadId}:${widgetId}:${contentType}`;
  const current = useRef({ identity, prompt, revision: 0, apply });
  const request = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    const previous = current.current;
    const changedIdentity = previous.identity !== identity;
    current.current = {
      identity, prompt, apply,
      revision: previous.revision + Number(changedIdentity || previous.prompt !== prompt),
    };
    if (changedIdentity) {
      request.current += 1;
      busy.current = false;
      setIsEnhancing(false);
    }
  }, [identity, prompt, apply]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  const enhancePrompt = async () => {
    if (busy.current || !current.current.prompt.trim()) return;
    const submitted = current.current;
    const attempt = ++request.current;
    const active = () => mounted.current && request.current === attempt
      && creatorSessionScope() === session && current.current.identity === submitted.identity;
    busy.current = true;
    setIsEnhancing(true);
    try {
      const response = await api.post<{ success: boolean; enhancedPrompt: string }>('/api/content/studio/magic-prompt', {
        currentPrompt: submitted.prompt, contentType,
      });
      if (!active()) return;
      if (response.success && response.enhancedPrompt) {
        if (current.current.revision !== submitted.revision) {
          toast({ title: 'Prompt changed', description: 'Your edits were kept. The earlier enhancement was not applied.' });
          return;
        }
        current.current.apply(response.enhancedPrompt);
        toast({ title: 'Prompt Enhanced', description: 'Your prompt has been improved with AI' });
      }
    } catch {
      if (active()) toast({ title: 'Error', description: 'Failed to enhance prompt', variant: 'destructive' });
    } finally {
      if (active()) { busy.current = false; setIsEnhancing(false); }
    }
  };
  return { isEnhancing, enhancePrompt };
}
