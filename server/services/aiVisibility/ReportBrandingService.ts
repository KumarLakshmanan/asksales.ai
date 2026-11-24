import type { BrandToolkitRecord } from '../../models/brandToolkits/schema.js';
import type { AiVisibilityWhiteLabelDefaults } from '../../models/aiVisibility/schema.js';

export interface ReportBrandingSnapshot {
  toolkitId: number | null;
  displayName: string;
  tagline: string | null;
  primaryColor: string;
  accentColor: string;
}

const FALLBACK_PRIMARY = '#6d4aff';
const FALLBACK_ACCENT = '#172033';

function safeHex(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

export function resolveReportBranding(
  toolkit: BrandToolkitRecord | null | undefined,
  projectName: string,
  workspaceDefaults?: AiVisibilityWhiteLabelDefaults | null,
  organizationDefaults?: AiVisibilityWhiteLabelDefaults | null,
): ReportBrandingSnapshot {
  const approvedToolkit = toolkit?.isActive && toolkit?.isApproved ? toolkit : null;
  const defaults = { ...(organizationDefaults || {}), ...(workspaceDefaults || {}) };
  return {
    toolkitId: approvedToolkit?.id || null,
    displayName: defaults.displayName?.trim() || approvedToolkit?.name.trim() || projectName,
    tagline: defaults.tagline?.trim() || approvedToolkit?.tagline?.trim() || null,
    primaryColor: safeHex(defaults.primaryColor, safeHex(approvedToolkit?.primaryBrandColor, FALLBACK_PRIMARY)),
    accentColor: safeHex(defaults.accentColor, safeHex(approvedToolkit?.accentColor || approvedToolkit?.secondaryBrandColor, FALLBACK_ACCENT)),
  };
}
