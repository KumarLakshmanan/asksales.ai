import { describe, expect, it, vi } from 'vitest';
import LegacyList from '@/app/dashboard/(main)/settings/outreach/legacy/page';
import LegacyEditor from '@/app/dashboard/(main)/settings/outreach/[agentType]/page';

vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
}));

describe('retired specialist entry points', () => {
  it.each([LegacyList, LegacyEditor])('opens Assistants for review and import without mutating configuration', page => {
    expect(() => page()).toThrow('REDIRECT:/dashboard/settings/outreach');
  });
});
