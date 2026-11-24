"use client";

import { createContext, useContext } from "react";

/**
 * ChatActionContext — centralises tab-open callbacks for the conversations page.
 * Consumers (ChatInterface and its children) can read these without prop drilling.
 */
export interface ChatActionContextValue {
  onOpenAgentChooseTab?: () => void;
  onOpenICPTab?: () => void;
  onOpenLeadInputsTab?: () => void;
  onOpenBrandToolkitTab?: () => void;
  onCreateBrandToolkit?: () => void;
  onOpenICPSelector?: () => void;
  onOpenOutreachTab?: () => void;
}

/**
 * Phase 6.4 / CLIENT-004: a missing handler used to silently no-op because
 * the context default was `{}`. Now consumers that call a handler without
 * a provider being installed get a clear, debuggable error.
 */
function throwNotProvided(name: string): never {
  throw new Error(
    `useChatActions: handler "${name}" invoked but no ChatActionProvider is mounted ` +
      `(or the provider did not supply this callback). Wrap your tree in <ChatActionProvider value={...} />.`
  );
}

const ChatActionContext = createContext<ChatActionContextValue>({
  onOpenAgentChooseTab:   () => throwNotProvided('onOpenAgentChooseTab'),
  onOpenICPTab:           () => throwNotProvided('onOpenICPTab'),
  onOpenLeadInputsTab:    () => throwNotProvided('onOpenLeadInputsTab'),
  onOpenBrandToolkitTab:  () => throwNotProvided('onOpenBrandToolkitTab'),
  onCreateBrandToolkit:   () => throwNotProvided('onCreateBrandToolkit'),
  onOpenICPSelector:      () => throwNotProvided('onOpenICPSelector'),
  onOpenOutreachTab:      () => throwNotProvided('onOpenOutreachTab'),
});

export function ChatActionProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ChatActionContextValue;
}) {
  return (
    <ChatActionContext.Provider value={value}>
      {children}
    </ChatActionContext.Provider>
  );
}

/** Hook — returns the context value. */
export function useChatActions(): ChatActionContextValue {
  return useContext(ChatActionContext);
}
