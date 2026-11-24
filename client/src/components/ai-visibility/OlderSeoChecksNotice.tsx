'use client';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import Link from 'next/link';

/**
 * Shown when the selected measurement used older SEO checks than a new analysis would.
 * Links to Overview, where a new analysis is started with its credit estimate.
 */
export function OlderSeoChecksNotice({
  projectId,
  version,
  current,
  subject,
}: {
  projectId: number;
  version: number | null | undefined;
  current: number | undefined;
  /** "findings" on the SEO page, "SEO fixes" on the fixes page. */
  subject: 'findings' | 'SEO fixes';
}) {
  if (typeof version !== 'number' || typeof current !== 'number' || version >= current) return null;
  return (
    <Callout
      tone="warning"
      title="Measured with older SEO checks"
      actions={
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/ai-visibility/websites/${projectId}`}>Analyze again</Link>
        </Button>
      }
    >
      {subject === 'findings'
        ? 'Some findings may no longer apply, and the score won’t compare directly with a new analysis.'
        : 'Some SEO fixes may no longer be needed.'}
    </Callout>
  );
}
