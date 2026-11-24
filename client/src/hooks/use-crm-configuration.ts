"use client";

import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { CRM_CONFIGURATION_API, DEFAULT_CRM_CONFIGURATION, isCrmConfiguration, type CrmConfiguration } from '@/lib/crm-configuration';

export function useCrmConfiguration() {
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [reloadVersion, reload] = useReducer(version => version + 1, 0);
  const [configuration, setConfiguration] = useState<CrmConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setConfiguration(null);
    setError(null);
    void api.get<unknown>(CRM_CONFIGURATION_API, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      if (!isCrmConfiguration(value)) throw new Error('The saved CRM configuration could not be loaded.');
      setConfiguration(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load CRM configuration.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [profileId, reloadVersion]);

  return { configuration, stages: configuration?.stages ?? DEFAULT_CRM_CONFIGURATION.stages, loading, error, reload };
}
