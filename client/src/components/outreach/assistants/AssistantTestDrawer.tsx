"use client";

import { useRef } from 'react';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import type { OutreachAssistant } from '@/lib/outreach-assistants';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AssistantSimulator } from './AssistantSimulator';

export function AssistantTestDrawer({ open, onOpenChange, assistant, workspace, dirty }: {
  open: boolean; onOpenChange: (open: boolean) => void; assistant: OutreachAssistant;
  workspace: ReturnType<typeof useAssistantWorkspace>; dirty: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }} className="ak-drawer flex h-dvh w-full flex-col gap-0 p-0 sm:max-w-2xl [&>button]:inline-flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center">
      <SheetHeader className="shrink-0 border-b p-5 pr-16 text-left">
        <SheetTitle>Test assistant</SheetTitle>
        <SheetDescription>Preview a customer conversation using a saved version. Test replies stay here and are never sent to customers.</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <AssistantSimulator assistant={assistant} workspace={workspace} dirty={dirty} />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 border-t p-4">
        <p className="text-xs leading-5 text-muted-foreground">Closing clears this preview conversation. Saved scenarios stay available.</p>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
      </div>
    </SheetContent>
  </Sheet>;
}
