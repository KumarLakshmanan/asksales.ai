/**
 * A readable label for a tool or workflow ID that has no friendly name, such as
 * "apify_linkedin_company_search_scraper" or "linkedin_company_search".
 * Vendor prefixes and implementation suffixes are dropped: customers see what
 * the step does, not which provider or actor ran it.
 */
export function readableToolName(name: string): string {
  const words = name
    .replace(/^(?:apify|harvestapi|scrapling)[_/-]+/i, "")
    .replace(/[_/-]+(?:scraper|actor|tool|workflow)$/i, "")
    .split(/[_/-]+/)
    .filter(Boolean);
  if (!words.length) return "Step";
  const label = words.join(" ").toLowerCase().replace(/\blinkedin\b/g, "LinkedIn");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
