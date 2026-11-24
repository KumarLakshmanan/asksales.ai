import type { ToolContext } from '../toolRegistry.js';

/** Tool ids arrive as strings or numbers; strings are parsed as base-10 integers. */
export function toNumber(value: string | number): number {
  return typeof value === 'string' ? parseInt(value, 10) : value;
}

/** The brand logo to place on generated media: null when the brand hides its logo, undefined when no toolkit is selected. */
export function selectedBrandLogoUrl(context: ToolContext): string | null | undefined {
  const toolkit = context.brandToolkit as any;
  if (!toolkit) return undefined;
  if (toolkit.logoVisibility === false) return null;
  return toolkit.logoUrl || toolkit.logoUrls?.[0] || undefined;
}
