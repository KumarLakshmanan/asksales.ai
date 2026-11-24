import { useEffect, useRef } from 'react';

/** Async uploads must never send after their authenticated ticket scope leaves. */
export function useSupportReplyScope(scope: string | null) {
  const active = useRef<string | null>(null);
  useEffect(() => { active.current = scope; return () => { active.current = null; }; }, [scope]);
  return () => scope !== null && active.current === scope;
}
