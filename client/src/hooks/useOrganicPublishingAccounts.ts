"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";

export type OrganicPublishingAccount = {
  credentialId: number;
  platform: "instagram" | "facebook" | "youtube";
  providerAccountId: string;
  accountName: string;
  expiresAt: string | null;
  expired: boolean;
  readiness?: 'ready' | 'needs_reconnect';
  isSelected?: boolean;
};

export function useOrganicPublishingAccounts() {
  const [accounts, setAccounts] = useState<OrganicPublishingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ accounts: OrganicPublishingAccount[] }>("/api/content/publishing/accounts")
      .then((response) => {
        if (cancelled) return;
        setAccounts(response.accounts.filter((account) => account.platform === 'youtube'
          ? account.readiness === 'ready' || (!account.expired && account.readiness !== 'needs_reconnect')
          : !account.expired));
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setAccounts([]);
        setError(reason instanceof Error ? reason.message : "Publishing accounts could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const forPlatform = useCallback(
    (platform: OrganicPublishingAccount["platform"]) =>
      accounts.filter((account) => account.platform === platform),
    [accounts],
  );

  const preferredForPlatform = useCallback(
    (platform: OrganicPublishingAccount["platform"]) => {
      const available = accounts.filter((account) => account.platform === platform);
      return available.find((account) => account.isSelected) || (available.length === 1 ? available[0] : undefined);
    },
    [accounts],
  );

  const connectedPlatforms = useMemo(() => (["instagram", "facebook", "youtube"] as const)
    .filter((platform) => accounts.some((account) => account.platform === platform)), [accounts]);

  return {
    accounts,
    loading,
    error,
    forPlatform,
    preferredForPlatform,
    connectedPlatforms,
  };
}
