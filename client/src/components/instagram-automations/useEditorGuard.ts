'use client';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Keep edits on screen until a navigation is explicitly accepted. */
export function useEditorGuard(dirty: boolean, busy: boolean, onDiscard?: () => void) {
  const state = useRef({ dirty, busy, onDiscard });
  useLayoutEffect(() => { state.current = { dirty, busy, onDiscard }; }, [dirty, busy, onDiscard]);
  const confirmLeave = useCallback(() => {
    if (state.current.busy) return false;
    if (!state.current.dirty) return true;
    const accepted = window.confirm('Discard your unsaved changes and leave this setup?');
    if (accepted) state.current.onDiscard?.();
    return accepted;
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!state.current.dirty && !state.current.busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const link = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element)?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      if (anchor.href === window.location.href || anchor.getAttribute('href')?.startsWith('#')) return;
      if (!confirmLeave()) { event.preventDefault(); event.stopPropagation(); }
    };
    // Chromium exposes cancellable same-document Back/Forward navigations.
    // Full-page navigation in other browsers is covered by beforeunload.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const traverse = (event: Event) => {
      if ((event as Event & { navigationType?: string }).navigationType === 'traverse' && event.cancelable && !confirmLeave()) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', link, true);
    navigation?.addEventListener('navigate', traverse);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link, true); navigation?.removeEventListener('navigate', traverse); };
  }, [confirmLeave]);
  return confirmLeave;
}

export function focusInvalidField(container: HTMLElement | null) {
  requestAnimationFrame(() => {
    const target = container?.querySelector<HTMLElement>('[aria-invalid="true"]') || container?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  });
}
