/** Keep explicit branding exclusions intact across the queue boundary. */
export function queuedMediaConfig(data: Record<string, unknown>, kind: 'image' | 'video'): Record<string, unknown> {
  const value = data[kind === 'image' ? 'imageConfig' : 'videoConfig'];
  const config = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const toolkit = data.brandToolkit && typeof data.brandToolkit === 'object'
    ? data.brandToolkit as Record<string, unknown> : {};
  const disabled = data.brandLogoUrl === null || config.brandLogoUrl === null || toolkit.logoVisibility === false;
  const logoUrl = disabled ? null
    : typeof data.brandLogoUrl === 'string' ? data.brandLogoUrl
      : typeof config.brandLogoUrl === 'string' ? config.brandLogoUrl
        : Array.isArray(toolkit.logoUrls) && typeof toolkit.logoUrls[0] === 'string' ? toolkit.logoUrls[0]
          : typeof toolkit.logoUrl === 'string' ? toolkit.logoUrl : undefined;
  return { ...config, brandLogoUrl: logoUrl };
}
