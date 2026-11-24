"use client";

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { CRM_PLATFORMS, crmSelectedPlatforms, type CrmPlatform } from '@/lib/crm-configuration';
import { CRM_AUTOMATIONS_API, type AutomationCatalog } from '@/lib/crm-automations';
import { cn } from '@/lib/utils';

export interface PlatformMultiSelectProps {
  value: CrmPlatform | CrmPlatform[];
  onChange: (value: CrmPlatform[]) => void;
  disabled?: boolean;
  showConnections?: boolean;
  compact?: boolean;
  description?: string;
}

/** Reporting selections stay available even after an account is disconnected. */
export function PlatformMultiSelect({ value, onChange, disabled, showConnections = true, compact, description }: PlatformMultiSelectProps) {
  const id = useId();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const selected = crmSelectedPlatforms({ platform: value });
  const [notice, setNotice] = useState('');
  const [connections, setConnections] = useState<AutomationCatalog['accounts'] | null>(null);
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    if (!showConnections) return;
    const controller = new AbortController();
    setConnections(null);
    setConnectionError(false);
    void api.get<AutomationCatalog>(`${CRM_AUTOMATIONS_API}/catalog`, { signal: controller.signal }).then(catalog => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(catalog.accounts)) throw new Error('Connection status unavailable');
      setConnections(catalog.accounts);
    }).catch(() => { if (!controller.signal.aborted) setConnectionError(true); });
    return () => controller.abort();
  }, [profileId, showConnections]);

  const toggle = (platform: CrmPlatform, checked: boolean) => {
    const next: CrmPlatform[] = platform === 'all' ? (checked ? ['all'] : [])
      : checked ? [...selected.filter(item => item !== 'all' && item !== platform), platform]
        : selected.filter(item => item !== platform);
    if (!next.length) {
      setNotice('Keep at least one platform selected, or choose All Platforms.');
      return;
    }
    setNotice('');
    onChange(next);
  };

  return <fieldset className="min-w-0 space-y-3" disabled={disabled} aria-describedby={`${id}-description ${id}-notice`}>
    <legend className="flex w-full items-center justify-between gap-3 text-sm font-medium">
      Platforms <Badge variant="secondary" className="text-xs">{selected.includes('all') ? 'All platforms' : `${selected.length} selected`}</Badge>
    </legend>
    <p id={`${id}-description`} className="text-sm leading-6 text-muted-foreground">{description || 'Select platforms for your reports. Contacts on several selected platforms are counted once. Disconnected accounts remain available for historical reporting.'}</p>
    <div className={cn('grid grid-cols-2 gap-2', !compact && 'sm:grid-cols-4')}>
      {CRM_PLATFORMS.map(platform => {
        const accounts = connections?.filter(account => account.channel === platform.value) || [];
        const ready = accounts.filter(account => account.ready).length;
        const status = ready ? `${ready} connected account${ready === 1 ? '' : 's'}`
          : accounts.length ? 'Connection needs attention' : 'No connected account';
        return <label key={platform.value} className={cn('flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm transition-colors hover:bg-muted/40',
          platform.value === 'all' && 'col-span-2', platform.value === 'all' && !compact && 'sm:col-span-4',
          selected.includes(platform.value) ? 'border-primary/50 bg-primary/5' : 'border-border', disabled && 'cursor-default opacity-60')}>
          <input type="checkbox" aria-label={platform.label} checked={selected.includes(platform.value)} onChange={event => toggle(platform.value, event.target.checked)}
            className="h-4 w-4 shrink-0 accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" />
          <span className="min-w-0"><span className="block font-medium">{platform.label}</span>
            {showConnections && platform.value !== 'all' && platform.value !== 'web' && <span className={cn('mt-1 block text-[11px] leading-4 text-muted-foreground', accounts.length > 0 && !ready && 'text-amber-700 dark:text-amber-300')}>{platform.value === 'linkedin' || platform.value === 'twitter' ? 'Historical reporting' : connections ? status : connectionError ? 'Status unavailable' : 'Checking connection…'}</span>}
            {showConnections && platform.value === 'web' && <span className="mt-1 block text-[11px] text-muted-foreground">Web conversation history</span>}
          </span>
          {platform.value === 'all' && <span className="ml-auto hidden text-xs text-muted-foreground sm:block">Include every platform</span>}
        </label>;
      })}
    </div>
    {showConnections && <Link href="/dashboard/integrations" className="inline-block text-xs text-primary hover:underline">Manage messaging accounts</Link>}
    <p id={`${id}-notice`} role={notice ? 'alert' : undefined} className="text-xs text-destructive">{notice}</p>
  </fieldset>;
}
