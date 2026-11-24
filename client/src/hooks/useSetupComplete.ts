"use client";

import { useAuth } from "@/contexts/AuthContext";

/**
 * useSetupComplete Hook
 * 
 * Determines if the user has completed initial setup (business profile + brand toolkit)
 * and provides utilities for layout switching and setup navigation.
 * 
 * Returns:
 * - isSetupComplete: boolean - whether user has completed full setup
 * - isLoading: boolean - whether auth is still loading
 * - shouldShowOnboarding: boolean - true if user should see onboarding layout
 * - hasBusinessProfile: boolean - whether business profile is filled
 * - hasBrandToolkit: boolean - whether brand toolkit is filled
 * - setupRedirectPath: string | null - path to redirect for incomplete setup
 * - completeSetup: () => void - marks setup as complete
 */
export function useSetupComplete() {
  const { 
    isLoading,
    workspaceRole,
    setSetupComplete,
    isSetupComplete,
    hasBusinessProfile,
    hasBrandToolkit,
    setHasBusinessProfile,
    setHasBrandToolkit,
  } = useAuth();

  const staff = workspaceRole === 'member' || workspaceRole === 'billing_admin';
  const bothComplete = hasBusinessProfile && (hasBrandToolkit || staff);
  const effectiveSetupComplete = bothComplete && (isSetupComplete || staff);

  // Determine where to redirect based on what's missing
  const getSetupRedirectPath = (): string | null => {
    if (effectiveSetupComplete) return null;
    if (!hasBusinessProfile) return "/setup/business-profile";
    if (!hasBrandToolkit) return "/setup/brand-toolkit";
    return "/setup/brand-toolkit";
  };

  return {
    isSetupComplete: effectiveSetupComplete,
    isLoading,
    shouldShowOnboarding: !isLoading && !effectiveSetupComplete,
    hasBusinessProfile,
    hasBrandToolkit,
    setupRedirectPath: getSetupRedirectPath(),
    completeSetup: () => setSetupComplete(true),
    setHasBusinessProfile,
    setHasBrandToolkit,
  };
}
