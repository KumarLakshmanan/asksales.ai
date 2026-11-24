/** The negative prompt is an explicit list of visual exclusions, not chat intent. */
export function mediaBrandingPolicy(input: { include_brand_logo?: boolean; negative_prompt?: string }) {
  const exclusions = new Set((input.negative_prompt || '').toLowerCase().split(/[,;\n]/).map(value => value.trim()));
  const noText = ['text', 'lettering', 'typography', 'words'].some(value => exclusions.has(value));
  const noLogo = ['logo', 'logos', 'watermark', 'watermarks', 'brand logo', 'brand logos'].some(value => exclusions.has(value));
  return { includeLogo: input.include_brand_logo !== false && !noLogo && !noText, includeText: !noText };
}
