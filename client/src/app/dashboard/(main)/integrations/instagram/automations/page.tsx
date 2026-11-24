'use client';
import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageLoadingState, PageErrorState } from '@/components/ui/page-state';
import { ChannelAccountSelector } from '@/components/integrations/ChannelAccountSelector';
import {
  AutomationHub,
  type AutomationNavigation,
  type AutomationView,
} from '@/components/instagram-automations/AutomationHub';
import { INSTAGRAM_AUTOMATIONS_PATH } from '@/lib/instagram-automations';
import type { MetaMessagingStatus } from '@/lib/integrations';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';

function InstagramAutomationsPageContent() {
  const router = useRouter(),
    params = useSearchParams(),
    profileId = useSyncExternalStore(
      subscribeBusinessProfile,
      selectedBusinessProfileId,
      () => null
    );
  const [status, setStatus] = useState<MetaMessagingStatus | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const generation = useRef(0);
  const lastProfileId = useRef(profileId);
  const loadStatus = useCallback(
    async (switchAccount = false) => {
      const version = ++generation.current;
      const requestedProfile = selectedBusinessProfileId();
      setLoading(true);
      setError('');
      try {
        const result = await api.get<MetaMessagingStatus>('/api/instagram/oauth/status');
        if (version !== generation.current || selectedBusinessProfileId() !== requestedProfile) return;
        setStatus(result);
        if (switchAccount)
          router.replace(
            result.officialApi.instagramAccountId ? `${INSTAGRAM_AUTOMATIONS_PATH}?accountId=${encodeURIComponent(result.officialApi.instagramAccountId)}` : INSTAGRAM_AUTOMATIONS_PATH
          );
      } catch (cause) {
        if (version === generation.current)
          setError(
            cause instanceof Error ? cause.message : 'Instagram account could not be loaded.'
          );
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [router]
  );
  useEffect(() => {
    setStatus(null);
    const changedProfile = lastProfileId.current !== profileId;
    lastProfileId.current = profileId;
    void loadStatus(changedProfile);
    return () => {
      generation.current += 1;
    };
  }, [loadStatus, profileId]);
  const accountId = params.get('accountId') || status?.officialApi.instagramAccountId || '';
  useEffect(() => {
    if (!params.get('accountId') && status?.officialApi.instagramAccountId) {
      const query = new URLSearchParams(params.toString());
      query.set('accountId', status.officialApi.instagramAccountId);
      router.replace(`${INSTAGRAM_AUTOMATIONS_PATH}?${query}`);
    }
  }, [params, router, status]);
  if (loading) return <PageLoadingState label="Loading Instagram account…" />;
  if (error)
    return (
      <PageErrorState
        title="Instagram account unavailable"
        description={error}
        reset={() => void loadStatus()}
      />
    );
  if (!accountId || (!status?.officialApi.authorized && !status?.officialApi.connected))
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <h1 className="text-2xl font-semibold">Connect an Instagram account</h1>
        <p className="text-sm text-muted-foreground">
          Choose a professional Instagram account before setting up its automations.
        </p>
        <ChannelAccountSelector
          platform="instagram_api"
          label="Instagram account"
          onChanged={() => loadStatus(true)}
        />
        <Button asChild>
          <Link href="/dashboard/integrations/instagram">Open Instagram connection</Link>
        </Button>
      </div>
    );
  const knownViews: AutomationView[] = [
    'hub',
    'rules',
    'icebreakers',
    'menu',
    'new',
    'edit',
    'history',
    'details',
  ];
  const candidate = params.get('view') as AutomationView;
  const navigation: AutomationNavigation = {
    view: knownViews.includes(candidate) ? candidate : 'hub',
    kind: params.get('kind') === 'comment_reply' ? 'comment_reply' : params.get('kind') === 'comment_dm' ? 'comment_dm' : undefined,
    ruleId: Number(params.get('ruleId')) || undefined,
    guided: params.get('guided') === '1',
    preset: params.get('preset') === 'follow' ? 'follow' : params.get('preset') === 'standard' ? 'standard' : undefined,
  };
  const navigate = (next: AutomationNavigation) => {
    const query = new URLSearchParams({ accountId, view: next.view });
    if (next.kind) query.set('kind', next.kind);
    if (next.ruleId) query.set('ruleId', String(next.ruleId));
    if (next.guided) query.set('guided', '1');
    if (next.preset) query.set('preset', next.preset);
    router.push(`${INSTAGRAM_AUTOMATIONS_PATH}?${query}`);
  };
  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <AutomationHub
        key={`${profileId}:${accountId}`}
        accountId={accountId}
        navigation={navigation}
        onNavigate={navigate}
        accountControl={
          <ChannelAccountSelector
            variant="button"
            platform="instagram_api"
            label="Instagram account"
            onChanged={() => loadStatus(true)}
          />
        }
      />
    </div>
  );
}
export default function InstagramAutomationsPage() {
  return (
    <Suspense fallback={<PageLoadingState label="Loading automations…" />}>
      <InstagramAutomationsPageContent />
    </Suspense>
  );
}
