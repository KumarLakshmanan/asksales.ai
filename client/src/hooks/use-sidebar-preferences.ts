"use client";

import { useCallback, useEffect, useState } from "react";

interface SidebarPreferences { open: boolean; sections: Record<string, boolean> }
const defaults: SidebarPreferences = { open: true, sections: {} };
export function useSidebarPreferences(userId?: number, destination = "", activeSection?: string) {
  const key = `navigation:${userId ?? "anonymous"}:sidebar`;
  const [state, setState] = useState<{ key: string; value: SidebarPreferences }>({ key: "", value: defaults });
  // Route-driven expansion is temporary. Only explicit disclosure actions save
  // preferences, so visiting CRM does not erase its saved collapsed state.
  const [visit, setVisit] = useState({ key, destination, sections: {} as Record<string, boolean> });
  if (visit.key !== key || visit.destination !== destination) {
    setVisit({ key, destination, sections: {} });
  }
  const visitSections = visit.key === key && visit.destination === destination ? visit.sections : {};
  useEffect(() => {
    let value = defaults;
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "null");
      if (stored && typeof stored.open === "boolean") value = { open: stored.open, sections: stored.sections && typeof stored.sections === "object" ? stored.sections : {} };
    } catch { /* Navigation works when storage is unavailable. */ }
    setState({ key, value });
  }, [key]);
  const update = useCallback((change: (value: SidebarPreferences) => SidebarPreferences) => {
    setState(current => {
      const value = change(current.key === key ? current.value : defaults);
      try { if (userId) localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep preferences in memory. */ }
      return { key, value };
    });
  }, [key, userId]);
  const value = state.key === key ? state.value : defaults;
  return {
    sidebarOpen: value.open,
    setSidebarOpen: (open: boolean) => update(current => ({ ...current, open })),
    sectionOpen: (section: string, fallback = false) => visitSections[section] ?? (section === activeSection ? true : value.sections[section] ?? fallback),
    setSectionOpen: (section: string, open: boolean) => {
      setVisit(current => ({ key, destination, sections: { ...(current.key === key && current.destination === destination ? current.sections : {}), [section]: open } }));
      update(current => ({ ...current, sections: { ...current.sections, [section]: open } }));
    },
  };
}
