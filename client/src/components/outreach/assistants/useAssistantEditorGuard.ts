'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';

export function useAssistantEditorGuard(dirty: boolean, busy: boolean) {
  const state = useRef({ dirty, busy });
  useLayoutEffect(() => { state.current = { dirty, busy }; }, [dirty, busy]);
  useEffect(() => {
    const allowed = () => !state.current.busy && (!state.current.dirty || window.confirm('Leave this assistant with unsaved changes? Configuration selections can be recovered in this tab. Unsaved instructions, examples and message text will be lost.'));
    const unload = (event: BeforeUnloadEvent) => { if (state.current.dirty || state.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.href === location.href || anchor.getAttribute('href')?.startsWith('#')) return;
      if (!allowed()) { event.preventDefault(); event.stopPropagation(); }
    };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const traverse = (event: Event) => { if ((event as Event & { navigationType?: string }).navigationType === 'traverse' && event.cancelable && !allowed()) event.preventDefault(); };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', click, true); navigation?.addEventListener('navigate', traverse);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true); navigation?.removeEventListener('navigate', traverse); };
  }, []);
}
