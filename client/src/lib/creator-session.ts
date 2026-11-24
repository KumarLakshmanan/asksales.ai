import { selectedBusinessProfileId } from './business-profile';

export function creatorSessionScope(): string {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const id = user?.id ?? user?.user?.id;
    return id ? `user-${String(id)}:business-${selectedBusinessProfileId() ?? 'unselected'}` : 'anonymous';
  } catch { return 'anonymous'; }
}
