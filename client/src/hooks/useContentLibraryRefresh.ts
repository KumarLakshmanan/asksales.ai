import { useEffect, useRef } from 'react';

/** Refetch saved work without remounting the pane or clearing its draft form. */
export function useContentLibraryRefresh(refreshKey: number, reload: () => void) {
  const previousKey = useRef(refreshKey);
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; });
  useEffect(() => {
    if (previousKey.current === refreshKey) return;
    previousKey.current = refreshKey;
    reloadRef.current();
  }, [refreshKey]);
}
