"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/** Focus lifecycle for controlled consumer dialogs whose opener is outside the Root. */
export function useControlledDialogReturnFocus(open: boolean, returnFocusRef?: RefObject<HTMLElement | null>) {
  const mounted = useRef(false);
  const isOpen = useRef(open);
  const focusSession = useRef<{ opener: HTMLElement | null; content: HTMLElement; pathname: string; superseded: boolean } | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    const reopening = open && !isOpen.current;
    isOpen.current = open;
    const session = focusSession.current;
    if (!session) return;
    if (reopening) {
      // An exit animation can be interrupted without remounting the focus scope.
      const active = session.content.ownerDocument.activeElement;
      session.opener = returnFocusRef?.current ??
        (active instanceof HTMLElement && active !== document.body && !session.content.contains(active) ? active : session.opener);
      session.superseded = false;
      return;
    }
    if (open) return;
    const ownerDocument = session.content.ownerDocument;
    const supersede = (event: Event) => {
      if (event.target instanceof Node && !session.content.contains(event.target) && focusSession.current === session) {
        session.superseded = true;
      }
    };
    // Remember newer actions even if their destination later leaves focus on BODY.
    ownerDocument.addEventListener('focusin', supersede, true);
    ownerDocument.addEventListener('pointerdown', supersede, true);
    ownerDocument.addEventListener('keydown', supersede, true);
    return () => {
      ownerDocument.removeEventListener('focusin', supersede, true);
      ownerDocument.removeEventListener('pointerdown', supersede, true);
      ownerDocument.removeEventListener('keydown', supersede, true);
    };
  }, [open, returnFocusRef]);

  const onOpenAutoFocus = (event: Event) => {
    const content = event.target as HTMLElement;
    const active = content.ownerDocument.activeElement;
    // Capture once per focus scope, before Radix moves focus into the form.
    focusSession.current = {
      opener: returnFocusRef?.current ?? (active instanceof HTMLElement ? active : null),
      content,
      pathname: window.location.pathname,
      superseded: false,
    };
  };
  const onCloseAutoFocus = (event: Event) => {
    // These controlled dialogs have no Radix Trigger. Own the deferred restoration,
    // including suppressing it when a later action has taken over focus.
    event.preventDefault();
    const session = focusSession.current;
    if (!session || session.content !== event.target || !mounted.current || isOpen.current) return;
    focusSession.current = null;
    if (session.superseded) return;
    const { opener, content, pathname } = session;
    const ownerDocument = content.ownerDocument;
    const active = ownerDocument.activeElement;
    if (window.location.pathname !== pathname ||
      (active !== ownerDocument.body && active !== opener && !content.contains(active)) ||
      ownerDocument.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
    if (opener?.isConnected && opener !== ownerDocument.body && !opener.matches(':disabled') &&
      !opener.closest('[hidden], [inert], [aria-hidden="true"]')) {
      opener.focus({ preventScroll: true });
    }
  };

  return { onOpenAutoFocus, onCloseAutoFocus };
}
