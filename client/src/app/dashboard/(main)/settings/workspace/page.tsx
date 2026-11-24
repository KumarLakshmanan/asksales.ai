"use client";

import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { WorkspaceSettingsOverview } from '@/components/settings/WorkspaceSettingsOverview';
import { ACCOUNT_SETTINGS_HREF } from '@/lib/settings-navigation';

export default function WorkspaceSettingsPage() {
  return <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
    <PageHeader icon={Settings2} title="Workspace configuration" subtitle="Find every available workspace setting in one place." actions={<Button asChild variant="outline"><Link href={ACCOUNT_SETTINGS_HREF}>Account settings</Link></Button>} />
    <WorkspaceSettingsOverview />
  </div>;
}
