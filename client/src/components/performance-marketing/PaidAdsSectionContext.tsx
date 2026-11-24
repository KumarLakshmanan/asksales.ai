"use client";

import { createContext, useContext, type ReactNode } from "react";

export type PaidAdsSection = "overview" | "recommendations" | "automation";
export type PaidAdsWorkspaceTab = PaidAdsSection | "campaigns";
export type PaidAdsQueryUpdates = Record<string, string | null>;

const PaidAdsSectionContext = createContext<PaidAdsSection | null>(null);
const PaidAdsAdvancedViewContext = createContext<boolean | null>(null);

export function PaidAdsSectionProvider({ section, children }: { section: PaidAdsSection; children: ReactNode }) {
  return <PaidAdsSectionContext.Provider value={section}>{children}</PaidAdsSectionContext.Provider>;
}

export function usePaidAdsSection() {
  return useContext(PaidAdsSectionContext);
}

export function PaidAdsAdvancedViewProvider({ advanced, children }: { advanced: boolean; children: ReactNode }) {
  return <PaidAdsAdvancedViewContext.Provider value={advanced}>{children}</PaidAdsAdvancedViewContext.Provider>;
}

export function usePaidAdsAdvancedView() {
  return useContext(PaidAdsAdvancedViewContext);
}

interface PaidAdsNavigationContextValue {
  navigate: (tab: PaidAdsWorkspaceTab, updates?: PaidAdsQueryUpdates) => void;
  updateQuery: (updates: PaidAdsQueryUpdates) => void;
}

const PaidAdsNavigationContext = createContext<PaidAdsNavigationContextValue | null>(null);

export function PaidAdsNavigationProvider({ value, children }: { value: PaidAdsNavigationContextValue; children: ReactNode }) {
  return <PaidAdsNavigationContext.Provider value={value}>{children}</PaidAdsNavigationContext.Provider>;
}

export function usePaidAdsNavigation() {
  const value = useContext(PaidAdsNavigationContext);
  if (!value) throw new Error("Paid Ads navigation is unavailable outside the Paid Ads workspace.");
  return value;
}
